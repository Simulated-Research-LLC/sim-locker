// Sim Locker core: the four states, the rules, and the records. Pure functions over a repo path; the CLI and the MCP server are thin
// shells around these. Every function returns plain JSON. A refusal is a thrown LockerError with a stable code and the reason.
//
// What the rules rest on, honestly: the actor and its kind come from SL_ACTOR plus the locker.json on the REMOTE truth branch, so an
// agent cannot promote itself by editing a file in its clone. But nothing here runs on the server. An agent that sets SL_ACTOR=rick,
// or uses raw git, is stopped only by GitHub branch protection or a server hook. Sim Locker makes the honest path easy and the
// dishonest path visible (trailers, records, the lease); it does not make it impossible.
import { readFile, writeFile, mkdir, mkdtemp, readdir, stat, rm } from "node:fs/promises";
import { join, relative, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { git, revParse, currentBranch, isClean, changedFiles, blobAt, topLevel, range, aheadBehind } from "./git.js";

export class LockerError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}

const CONFIG = "locker.json";
// The lease lives on a branch, not a custom ref: GitHub proxies and hooks that allow only refs/heads/* still carry it.
const LEASE_REF = "refs/heads/locker/lease";
const CONFIRM_TTL_MS = 10 * 60 * 1000;
const REGISTRY = join(homedir(), ".simlocker", "clones.json");
const SLICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

// ---------- the folder, the config, the actor ----------

async function gitDir(top) { const d = await git(top, ["rev-parse", "--git-dir"]); return resolve(top, d); }

/** Fill the defaults and refuse a config that would weaken the rules. Pure: the same object comes back filled. */
export function checkConfig(config, from = "locker.json") {
  for (const key of ["project", "truth", "remote", "actors"]) if (!(key in config)) throw new LockerError("CONFIG", `${CONFIG} on ${from} lacks "${key}"`);
  config.fetch = { maxAgeSeconds: 300, ...(config.fetch ?? {}) };
  config.lease = { ttlMinutes: 30, ...(config.lease ?? {}) };
  config.live = config.live ?? { kind: "none" };
  config.confirm = config.confirm ?? ["accept", "revert"];
  // accept.gate: a command run on the slice's tree before accepting (a project's own checks); accept.trailing: record files, not code,
  // that may change after the reviewed head (a delivery ledger, say). Review records and locker.json are never trailing.
  config.accept = { gate: null, gateTimeoutSeconds: 900, trailing: [], ...(config.accept ?? {}) };
  if (config.accept.gate !== null && !(Array.isArray(config.accept.gate) && config.accept.gate.every((x) => typeof x === "string") && config.accept.gate.length)) throw new LockerError("CONFIG", "accept.gate must be a list of strings (the command and its arguments)");
  if (!Array.isArray(config.accept.trailing) || !config.accept.trailing.every((x) => typeof x === "string")) throw new LockerError("CONFIG", "accept.trailing must be a list of path patterns");
  for (const pat of config.accept.trailing) {
    const re = globToRegExp(pat);
    if (/^(locker($|[./])|\.gitattributes|\.github|bin\/sl-guard)/.test(pat)) throw new LockerError("CONFIG", `accept.trailing pattern "${pat}" is under a protected path; locker.json, locker/, .gitattributes, .github/ and the guard are never trailing`);
    if (["locker.json", "locker/reviews/rev_000000000000.json", "locker/live/x.json", ".gitattributes", ".github/workflows/x.yml", "bin/sl-guard.js"].some((f) => re.test(f))) throw new LockerError("CONFIG", `accept.trailing pattern "${pat}" would cover locker.json, locker/, .gitattributes, .github/ or the guard; those are never trailing`);
  }
  // drill.test: the command `sl drill` runs in a plain clone restored from a second remote (the project's tests); none means restore only.
  config.drill = { test: null, timeoutSeconds: 900, ...(config.drill ?? {}) };
  if (config.drill.test !== null && !(Array.isArray(config.drill.test) && config.drill.test.every((x) => typeof x === "string") && config.drill.test.length)) throw new LockerError("CONFIG", "drill.test must be a list of strings (the command and its arguments)");
  if (!(Number.isInteger(config.drill.timeoutSeconds) && config.drill.timeoutSeconds >= 1 && config.drill.timeoutSeconds <= 86400)) throw new LockerError("CONFIG", "drill.timeoutSeconds must be a whole number of seconds from 1 to 86400");
  if (!(Number.isInteger(config.accept.gateTimeoutSeconds) && config.accept.gateTimeoutSeconds >= 1 && config.accept.gateTimeoutSeconds <= 86400)) throw new LockerError("CONFIG", "accept.gateTimeoutSeconds must be a whole number of seconds from 1 to 86400");
  return config;
}

/** The config that rules is the one on the remote truth branch; the working tree copy only bootstraps a project that has never been backed up. */
async function loadConfig(top, local) {
  let config = local, configFrom = "working tree";
  for (const ref of [`${local.remote}/${local.truth}`, local.truth]) {
    const text = await git(top, ["show", `${ref}:${CONFIG}`], { allowFail: true });
    if (text !== null) { try { config = JSON.parse(text); configFrom = ref; break; } catch { throw new LockerError("CONFIG", `${CONFIG} on ${ref} is not valid JSON`); } }
  }
  checkConfig(config, configFrom);
  return { config, configFrom };
}

/** Resolve a repo: a git work tree whose remote truth branch (or, before the first backup, the local one) carries locker.json. */
export async function openRepo(cwd = process.cwd()) {
  const top = await topLevel(cwd);
  if (!top) throw new LockerError("UNMANAGED", `${cwd} is not inside a git work tree. Sim Locker refuses to work in a plain folder; clone the project instead (sl clone <url>).`);
  let local; try { local = JSON.parse(await readFile(join(top, CONFIG), "utf8")); }
  catch (e) { throw new LockerError("UNMANAGED", `${top} has a .git but no readable ${CONFIG}. Run sl init here if this folder is meant to be managed.`, { cause: String(e) }); }
  for (const key of ["project", "truth", "remote", "actors"]) if (!(key in local)) throw new LockerError("CONFIG", `${CONFIG} lacks "${key}"`);
  const remoteUrl = await git(top, ["remote", "get-url", local.remote], { allowFail: true });
  if (remoteUrl === null) throw new LockerError("UNMANAGED", `remote "${local.remote}" is not configured in ${top}`);
  const { config, configFrom } = await loadConfig(top, local);
  const repo = { top, config, configFrom, remoteUrl, gitDir: await gitDir(top) };
  await registerClone(repo);                                           // every clone that runs the tool is known to the registry
  return repo;
}

/** The actor is stamped by the tool from SL_ACTOR, never taken from a payload. The session is SL_SESSION, or one id per clone. */
export async function actorFromEnv(repo, env = process.env) {
  const name = env.SL_ACTOR, config = repo.config;
  if (!name) throw new LockerError("NO_ACTOR", `SL_ACTOR is not set. Set it to one of: ${Object.keys(config.actors).join(", ")}`);
  const kind = config.actors[name];
  if (!kind) throw new LockerError("NO_ACTOR", `SL_ACTOR="${name}" is not an actor in ${CONFIG} on ${repo.configFrom} (${Object.keys(config.actors).join(", ")})`);
  let session = env.SL_SESSION;
  if (!session) {
    const file = join(repo.gitDir, "locker-session");
    try { session = (await readFile(file, "utf8")).trim(); } catch { session = randomBytes(6).toString("hex"); await writeFile(file, session + "\n"); }
  }
  return { name, kind, session };
}

/** A simple glob: * matches within a path segment, ** across segments. */
function globToRegExp(pattern) {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\0").replace(/\*\*/g, "\x01").replace(/\*/g, "[^/]*").replace(/\0/g, "(?:.*/)?").replace(/\x01/g, ".*");
  return new RegExp(`^${esc}$`);
}

/** Run a project's own gate command on a clean checkout of exactly the commit being accepted, with the actor in its environment and a
 * timeout. Never a shell, never the working tree (ignored or excluded files there would count). */
/** Run a command (no shell) in cwd with a timeout. Its own process group, so the timeout kills it and everything it started (a test
 *  runner's browsers), and settled on exit, not close, so a grandchild holding the pipes cannot keep the caller waiting. */
function runCommand([cmd, ...args], cwd, env, timeoutSeconds) {
  return new Promise((done) => {
    const c = spawn(cmd, args, { cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let output = "", settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(t); done(r); } };
    const killAll = () => { try { if (process.platform === "win32") spawn("taskkill", ["/T", "/F", "/PID", String(c.pid)], { stdio: "ignore" }); else process.kill(-c.pid, "SIGKILL"); } catch { try { c.kill("SIGKILL"); } catch { /* gone */ } } };
    const t = setTimeout(() => { output += `\n(killed after ${timeoutSeconds} s)`; killAll(); finish({ code: 124, output }); }, timeoutSeconds * 1000);
    c.stdout.on("data", (d) => { output += d; }); c.stderr.on("data", (d) => { output += d; });
    c.on("error", (e) => finish({ code: 127, output: output + String(e) }));
    c.on("exit", (code) => { killAll(); setTimeout(() => finish({ code: code ?? 137, output }), 50); });   // its stragglers die with it; a moment for the last output
  });
}

/** The project's own gate, in a clean detached checkout of exactly the commit being accepted; never the working tree. */
async function runGate(repo, head, actor) {
  const dir = join(repo.gitDir, `locker-gate-${head.slice(0, 12)}`);
  await git(repo.top, ["worktree", "remove", "--force", dir], { allowFail: true });
  await git(repo.top, ["worktree", "add", "--detach", "--quiet", dir, head]);
  try { return await runCommand(repo.config.accept.gate, dir, { SL_ACTOR: actor.name, SL_SESSION: actor.session, SL_GATE_COMMIT: head }, repo.config.accept.gateTimeoutSeconds); }
  finally { await git(repo.top, ["worktree", "remove", "--force", dir], { allowFail: true }); }
}

/** Files that are never trailing, whatever the patterns say: the config, the records, the attributes, the workflows, the guard. */
const NEVER_TRAILING = /^(locker\.json|locker\/.*|\.gitattributes|\.github\/.*|bin\/sl-guard\.js)$/;

const ident = (actor) => ["-c", `user.name=${actor.name}`, "-c", `user.email=${actor.name}@simlocker.local`];
const trailers = (fields) => Object.entries(fields).map(([k, v]) => `Locker-${k}: ${v}`).join("\n");

function checkSliceName(repo, slice) {
  if (!slice || !SLICE_NAME.test(slice) || slice.includes("..") || slice.endsWith("/") || slice.endsWith(".lock") || /^(HEAD|refs|heads|remotes|done|kept)(\/|$)/.test(slice) || slice.startsWith(`${repo.config.remote}/`))
    throw new LockerError("BAD_SLICE", `"${slice}" is not a slice name; use letters, digits, dots, dashes and slashes, like slice/boss-hp`);
  if (slice === repo.config.truth) throw new LockerError("BAD_SLICE", `${slice} is the truth branch, not a slice`);
}

// ---------- fetching and staleness ----------

/** The age of the last fetch Sim Locker itself made, or null. FETCH_HEAD is not used: any fetch of any remote touches it. */
async function lastFetchAge(repo) {
  try { const s = await stat(join(repo.gitDir, "locker-fetched")); return (Date.now() - s.mtimeMs) / 1000; } catch { return null; }
}

/** Fetch the heads and the lease ref if the last fetch is older than allowed. Says plainly when it did not fetch. */
export async function freshen(repo, { force = false } = {}) {
  const age = await lastFetchAge(repo);
  const ageSeconds = age === null ? null : Math.round(age);
  const due = force || age === null || age > repo.config.fetch.maxAgeSeconds;
  if (!due) return { fetched: false, fresh: true, reason: `last fetch ${ageSeconds} s ago, within ${repo.config.fetch.maxAgeSeconds} s`, ageSeconds };
  const r = repo.config.remote;
  const heads = await git(repo.top, ["fetch", "--quiet", r, `+refs/heads/*:refs/remotes/${r}/*`], { allowFail: true });
  if (heads === null) return { fetched: false, fresh: false, reason: "fetch failed (offline, or the remote refused)", ageSeconds };
  const lease = await git(repo.top, ["fetch", "--quiet", r, `+${LEASE_REF}:${LEASE_REF}`], { allowFail: true });
  if (lease === null) await git(repo.top, ["update-ref", "-d", LEASE_REF], { allowFail: true });   // the remote has no lease
  await writeFile(join(repo.gitDir, "locker-fetched"), new Date().toISOString() + "\n");
  return { fetched: true, fresh: true, ageSeconds: 0 };
}

async function truthState(repo) {
  const { truth, remote } = repo.config;
  const local = await revParse(repo.top, truth), remoteRef = await revParse(repo.top, `${remote}/${truth}`);
  const ab = local && remoteRef ? await aheadBehind(repo.top, truth, `${remote}/${truth}`) : { ahead: null, behind: null };
  return { local, remote: remoteRef, ...ab, stale: ab.behind !== null && ab.behind > 0 };
}

/** Ask the remote itself what a ref points at. A real round trip, unlike the tracking ref a push writes. */
async function remoteRef(repo, ref) {
  const out = await git(repo.top, ["ls-remote", "--exit-code", repo.config.remote, ref], { allowFail: true });
  if (out === null) return null;
  return out.split(/\s+/)[0] || null;
}

// ---------- clone registry (two clones of one project on one machine is an error) ----------

async function readRegistry() { try { return JSON.parse(await readFile(REGISTRY, "utf8")); } catch { return {}; } }
const urlKey = (url) => url.replace(/^file:\/\//, "").replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
export async function registerClone(repo) {
  const reg = await readRegistry(), key = urlKey(repo.remoteUrl);
  const list = new Set(reg[key] ?? []); list.add(repo.top);
  reg[key] = [...list];
  await mkdir(dirname(REGISTRY), { recursive: true });
  await writeFile(REGISTRY, JSON.stringify(reg, null, 1));
}
async function otherClones(repo) {
  const reg = await readRegistry(); const out = [];
  for (const p of reg[urlKey(repo.remoteUrl)] ?? []) if (resolve(p) !== resolve(repo.top)) { try { await stat(join(p, ".git")); out.push(p); } catch { /* gone */ } }
  return out;
}

// ---------- lease: one writer on the truth branch, a TTL, compare-and-swap through git ----------

async function readLease(repo) {
  const sha = await revParse(repo.top, LEASE_REF); if (!sha) return { sha: null, lease: null };
  const text = await git(repo.top, ["show", `${sha}:lease.json`], { allowFail: true });
  if (text === null) return { sha, lease: null };
  let lease; try { lease = JSON.parse(text); } catch { return { sha, lease: null, corrupt: true }; }
  lease.expired = Date.parse(lease.expires) < Date.now();
  return { sha, lease };
}

async function writeLeaseRef(repo, lease, expectedSha) {
  const blob = await git(repo.top, ["hash-object", "-w", "--stdin"], { input: JSON.stringify(lease, null, 1) + "\n" });
  const tree = await git(repo.top, ["mktree"], { input: `100644 blob ${blob}\tlease.json\n` });
  const commit = await git(repo.top, [...ident({ name: lease.owner ?? lease.releasedBy ?? "locker" }), "commit-tree", tree, "-m", `locker lease: ${lease.owner ?? "released"} until ${lease.expires}`]);
  const guard = `--force-with-lease=${LEASE_REF}:${expectedSha ?? ""}`;
  const pushed = await git(repo.top, ["push", "--quiet", repo.config.remote, `${commit}:${LEASE_REF}`, guard], { allowFail: true });
  if (pushed === null) throw new LockerError("LEASE_RACE", "someone else changed the lease first; fetch and look at sl status before trying again");
  await git(repo.top, ["update-ref", LEASE_REF, commit]);
  return commit;
}

export async function lease(repo, actor, action) {
  const f = await freshen(repo, { force: true });
  if (!f.fetched) throw new LockerError("NOT_FETCHED", `cannot reach ${repo.config.remote}; the lease lives there`);
  const { sha, lease: cur } = await readLease(repo);
  const mine = cur && cur.owner === actor.name && cur.session === actor.session;
  if (action === "status") return { lease: cur, mine: !!mine };
  if (action === "release") {
    if (!cur || cur.owner === null) return { released: false, reason: "no lease is held" };
    if (!mine && !cur.expired) throw new LockerError("LEASE_HELD", `the lease is held by ${cur.owner} (${cur.session}) until ${cur.expires}`);
    await writeLeaseRef(repo, { owner: null, session: null, expires: new Date().toISOString(), releasedBy: actor.name }, sha);
    return { released: true };
  }
  if (cur && cur.owner && !cur.expired && !mine) throw new LockerError("LEASE_HELD", `the lease is held by ${cur.owner} (${cur.session}) until ${cur.expires}; it can be taken when it expires, or released by its owner`);
  if (action === "renew" && !mine) throw new LockerError("LEASE_NOT_MINE", "nothing to renew: this session does not hold the lease (acquire it)");
  const expires = new Date(Date.now() + repo.config.lease.ttlMinutes * 60 * 1000).toISOString();
  const next = { owner: actor.name, kind: actor.kind, session: actor.session, acquired: mine ? cur.acquired : new Date().toISOString(), expires };
  await writeLeaseRef(repo, next, sha);
  return { lease: { ...next, expired: false }, action: mine ? "renewed" : "acquired" };
}

async function holdsLease(repo, actor) {
  const { lease: cur } = await readLease(repo);
  return !!cur && cur.owner === actor.name && cur.session === actor.session && !cur.expired;
}

// ---------- records: reviews, live, accepted ----------

const recordsDir = (repo, kind) => join(repo.top, "locker", kind);

async function listRecords(repo, kind) {
  const dir = recordsDir(repo, kind); let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort(); } catch { return []; }
  const out = [];
  for (const n of names) { try { out.push({ path: relative(repo.top, join(dir, n)), ...JSON.parse(await readFile(join(dir, n), "utf8")) }); } catch (e) { out.push({ path: relative(repo.top, join(dir, n)), unreadable: String(e) }); } }
  return out;
}

/** What accepts on the truth branch have consumed: review ids, and the slice heads they accepted. */
async function accepted(repo) {
  const log = await git(repo.top, ["log", "--format=%(trailers:key=Locker-Review,valueonly)%x00%(trailers:key=Locker-Range-Head,valueonly)%x1e", "-n", "500", repo.config.truth], { allowFail: true });
  const reviews = new Set(), heads = [];
  for (const rec of (log ?? "").split("\x1e")) { const [r, h] = rec.split("\0").map((x) => x?.trim()); if (r) reviews.add(r); if (h) heads.push(h); }
  return { reviews, heads };
}

/** A review record: the exact range, the reviewer, the findings, and the blob hash of every file it cites, so status can see it go stale. */
export async function review(repo, actor, { from, to, findings, verdict }) {
  const toSha = await revParse(repo.top, to), fromRef = await revParse(repo.top, from);
  if (!toSha || !fromRef) throw new LockerError("BAD_RANGE", `cannot resolve ${from}..${to}`);
  // "main..slice" means the slice's own commits, so the range starts at the merge base, not at wherever main is today
  const fromSha = await git(repo.top, ["merge-base", fromRef, toSha]);
  if (!["pass", "fix", "block"].includes(verdict)) throw new LockerError("BAD_VERDICT", `verdict must be pass, fix or block, got "${verdict}"`);
  const files = (await git(repo.top, ["diff", "--name-only", "--no-renames", `${fromSha}..${toSha}`])).split("\n").filter(Boolean);
  const cited = {}; for (const f of files) cited[f] = await blobAt(repo.top, toSha, f);
  const id = `rev_${createHash("sha256").update(`${fromSha}${toSha}${actor.name}${Date.now()}${randomBytes(4).toString("hex")}`).digest("hex").slice(0, 12)}`;
  const rec = { id, kind: "review", range: { from: fromSha, to: toSha }, reviewer: actor.name, reviewerKind: actor.kind, session: actor.session, verdict, findings, cited, created: new Date().toISOString() };
  await mkdir(recordsDir(repo, "reviews"), { recursive: true });
  const path = join(recordsDir(repo, "reviews"), `${id}.json`);
  await writeFile(path, JSON.stringify(rec, null, 1) + "\n");
  return { id, path: relative(repo.top, path), record: rec };
}

async function staleReviews(repo) {
  const out = [], done = await accepted(repo);
  for (const r of await listRecords(repo, "reviews")) {
    if (r.unreadable || !r.cited || done.reviews.has(r.id)) continue;
    // a review of an earlier head of a slice that was later accepted is superseded, not stale
    let superseded = false;
    for (const h of done.heads) if (r.range?.to && (await git(repo.top, ["merge-base", "--is-ancestor", r.range.to, h], { allowFail: true })) !== null) { superseded = true; break; }
    if (superseded) continue;
    const moved = [];
    for (const [f, blob] of Object.entries(r.cited)) { const now = await blobAt(repo.top, "HEAD", f); if (now !== blob) moved.push(f); }
    if (moved.length) out.push({ id: r.id, moved });
  }
  return out;
}

// ---------- confirm tokens: two steps for anything long or destructive ----------

async function requireConfirm(repo, actor, op, args, given) {
  if (!repo.config.confirm.includes(op)) return null;
  const file = join(repo.gitDir, "locker-confirm.json");
  let table = {}; try { table = JSON.parse(await readFile(file, "utf8")); } catch { /* none yet */ }
  const key = createHash("sha256").update(JSON.stringify({ op, args, actor: actor.name, session: actor.session })).digest("hex").slice(0, 16);
  const now = Date.now();
  for (const [t, v] of Object.entries(table)) if (now - v.created > CONFIRM_TTL_MS) delete table[t];
  if (given) {
    const hit = table[given];
    if (!hit || hit.key !== key) throw new LockerError("BAD_CONFIRM", "that confirm token does not match this operation, actor and session, or it expired (10 minutes). Run the command again without --confirm to get a new one.");
    delete table[given]; await writeFile(file, JSON.stringify(table));
    return null;
  }
  const token = randomBytes(4).toString("hex");
  table[token] = { key, created: now, op };
  await writeFile(file, JSON.stringify(table));
  return { confirmRequired: true, token, op, message: `${op} is a two-step command. Run it again with --confirm ${token} within 10 minutes to go ahead.` };
}

// ---------- the four states ----------

async function sliceState(repo, branch) {
  const { remote, truth } = repo.config;
  const head = await revParse(repo.top, "HEAD");
  const remoteHead = await revParse(repo.top, `${remote}/${branch}`);
  const backedUp = !!remoteHead && remoteHead === head;
  const log = await git(repo.top, ["log", "--format=%H%x00%(trailers:key=Locker-Slice,valueonly)%x00%(trailers:key=Locker-Range-Head,valueonly)%x1e", "-n", "500", truth], { allowFail: true });
  let accepted = null;
  for (const rec of (log ?? "").split("\x1e")) { const [sha, slice, rangeHead] = rec.split("\0"); const s = slice?.trim(); if ((s === branch || `done/${s}` === branch) && rangeHead?.trim() === head) { accepted = sha.trim(); break; } }
  return { branch, head, saved: !!head, backedUp, remoteHead, accepted, live: await liveState(repo) };
}

async function liveState(repo) {
  const cfg = repo.config.live;
  if (cfg.kind === "none") return { kind: "none", applies: false };
  const recs = await listRecords(repo, "live");
  const last = recs.filter((r) => !r.unreadable).at(-1) ?? null;
  return { kind: cfg.kind, applies: true, commit: last?.commit ?? null, setBy: last?.actor ?? null, at: last?.created ?? null, target: cfg.url ?? cfg.path ?? null, note: "a record of what was declared live; the tool does not check the target" };
}

export async function setLive(repo, actor, commit) {
  if (repo.config.live.kind === "none") throw new LockerError("NO_LIVE", `${repo.config.project} declares live: none; nothing to set`);
  const sha = await revParse(repo.top, commit); if (!sha) throw new LockerError("BAD_COMMIT", `cannot resolve ${commit}`);
  await mkdir(recordsDir(repo, "live"), { recursive: true });
  const rec = { kind: "live", commit: sha, actor: actor.name, session: actor.session, created: new Date().toISOString() };
  const path = join(recordsDir(repo, "live"), `${rec.created.replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify(rec, null, 1) + "\n");
  return { path: relative(repo.top, path), record: rec, note: "written, not saved; sl save it" };
}

/** The truth about where this folder stands. Problems first. */
export async function status(repo, { fetch = true } = {}) {
  const problems = [];
  const freshness = fetch ? await freshen(repo) : { fetched: false, fresh: false, reason: "fetch skipped by request", ageSeconds: await lastFetchAge(repo).then((a) => (a === null ? null : Math.round(a))) };
  if (!freshness.fresh) problems.push(`NOT FETCHED: ${freshness.reason}; everything below about the remote and the lease may be out of date`);
  const truth = await truthState(repo);
  if (truth.stale) problems.push(`STALE: ${repo.config.truth} is ${truth.behind} commit(s) behind ${repo.config.remote}/${repo.config.truth}; pull before saving or accepting`);
  if (!truth.remote) problems.push(`NO REMOTE TRUTH: ${repo.config.remote}/${repo.config.truth} does not exist; nothing has ever been backed up`);
  if (repo.configFrom === "working tree") problems.push(`CONFIG FROM WORKING TREE: ${CONFIG} is not on ${repo.config.truth} yet; save and back it up`);
  const others = await otherClones(repo);
  if (others.length) problems.push(`TWO CLONES: this project is also cloned at ${others.join(", ")}; one machine, one clone`);
  const { lease: cur, corrupt } = await readLease(repo);
  if (corrupt) problems.push("LEASE CORRUPT: refs/heads/locker/lease does not hold valid JSON");
  if (cur?.owner && !cur.expired) problems.push(`LEASE HELD BY ${cur.owner} (${cur.kind}, session ${cur.session}) until ${cur.expires}`);
  const stale = await staleReviews(repo);
  for (const s of stale) problems.push(`STALE REVIEW ${s.id}: ${s.moved.length} cited file(s) changed since: ${s.moved.slice(0, 5).join(", ")}${s.moved.length > 5 ? ", ..." : ""}`);
  const branch = await currentBranch(repo.top);
  if (branch === "HEAD") problems.push("DETACHED: not on any branch; check out a slice or the truth branch");
  const dirty = await changedFiles(repo.top);
  const slice = await sliceState(repo, branch);
  const ab = await aheadBehind(repo.top, branch, `${repo.config.remote}/${branch}`);
  return { project: repo.config.project, path: repo.top, remote: repo.remoteUrl, configFrom: repo.configFrom, freshness, problems, truth: { branch: repo.config.truth, ...truth }, current: { ...slice, onTruth: branch === repo.config.truth, ahead: ab.ahead, behind: ab.behind, uncommitted: dirty }, lease: cur ?? null, reviews: (await listRecords(repo, "reviews")).map((r) => ({ id: r.id, verdict: r.verdict, reviewer: r.reviewer, to: r.range?.to })) };
}

/** saved: commit the work on the current slice branch, stamped with the actor. Refuses a stale folder, and refuses agents on the truth branch. */
export async function save(repo, actor, { message, paths = [], slice } = {}) {
  if (!message) throw new LockerError("NO_MESSAGE", "save needs a message that says what changed and why");
  const f = await freshen(repo);
  const truth = await truthState(repo);
  if (truth.stale) throw new LockerError("STALE", `${repo.config.truth} is ${truth.behind} commit(s) behind the remote; pull first (sl pull)`);
  const before = await currentBranch(repo.top);
  if (slice !== undefined) checkSliceName(repo, slice);
  if (slice && slice !== before) {
    const exists = await revParse(repo.top, `refs/heads/${slice}`);
    await git(repo.top, exists ? ["checkout", "--quiet", slice] : ["checkout", "--quiet", "-b", slice, repo.config.truth]);
  }
  const branch = await currentBranch(repo.top);                       // what git says, not what the caller said
  if (branch === "HEAD") throw new LockerError("DETACHED", "not on a branch; nothing is saved from a detached HEAD");
  if (branch === repo.config.truth && actor.kind !== "human") throw new LockerError("AGENT_ON_TRUTH", `an agent does not save on ${repo.config.truth}; save on a slice branch (sl save --slice <name>) and accept it after a review`);
  if (branch === repo.config.truth && !f.fresh) throw new LockerError("NOT_FETCHED", `cannot reach the remote, so it is unknown whether ${repo.config.truth} is behind; saving on the truth branch waits`);
  await git(repo.top, ["add", "-A", "--", ...(paths.length ? paths : ["."])]);
  if (await isClean(repo.top)) return { saved: false, reason: "nothing to save", branch, head: await revParse(repo.top, "HEAD") };
  const body = `${message}\n\n${trailers({ Actor: `${actor.name} (${actor.kind})`, Session: actor.session })}\n`;
  await git(repo.top, [...ident(actor), "commit", "--quiet", "-F", "-"], { input: body });
  const head = await revParse(repo.top, "HEAD");
  const files = (await git(repo.top, ["show", "--name-only", "--format=", head])).split("\n").filter(Boolean);
  return { saved: true, branch, head, actor: actor.name, files, ...(f.fresh ? {} : { warning: `NOT FETCHED: ${f.reason}` }) };
}

/** backed up: push the current branch and prove it arrived by asking the remote for the ref. The push exit code alone is not evidence. */
export async function backup(repo) {
  const branch = await currentBranch(repo.top), head = await revParse(repo.top, "HEAD");
  if (branch === "HEAD") throw new LockerError("DETACHED", "not on a branch; check one out first");
  if (!(await isClean(repo.top))) throw new LockerError("DIRTY", "uncommitted changes; save first, then back up");
  const pushed = await git(repo.top, ["push", "--quiet", repo.config.remote, `${branch}:refs/heads/${branch}`], { allowFail: true });
  if (pushed === null) throw new LockerError("PUSH_REFUSED", `the remote refused the push of ${branch} (it has commits you do not have, or you are offline). Sim Locker never forces; pull, then try again`);
  const onRemote = await remoteRef(repo, `refs/heads/${branch}`);
  if (onRemote === null) throw new LockerError("NOT_BACKED_UP", `the push returned but the remote could not be asked for ${branch} afterwards; not counted as backed up`);
  if (onRemote !== head) throw new LockerError("NOT_BACKED_UP", `after the push the remote ${branch} is ${onRemote}, not ${head}`);
  await freshen(repo, { force: true });
  return { backedUp: true, branch, head, remote: repo.remoteUrl, verifiedBy: "ls-remote" };
}

/** Bring the truth branch up to date, fast-forward only. */
export async function pull(repo) {
  const f = await freshen(repo, { force: true });
  if (!f.fetched) throw new LockerError("NOT_FETCHED", `cannot reach ${repo.config.remote}`);
  const { truth, remote } = repo.config;
  const t = await truthState(repo);
  if (t.ahead > 0) throw new LockerError("DIVERGED", `${truth} has ${t.ahead} local commit(s) the remote does not; this needs a person to look`);
  const branch = await currentBranch(repo.top);
  if (branch !== truth) await git(repo.top, ["fetch", "--quiet", repo.config.remote, `${truth}:${truth}`]);
  else {
    if (!(await isClean(repo.top))) throw new LockerError("DIRTY", "uncommitted changes on the truth branch; save or discard them before pulling");
    await git(repo.top, ["merge", "--ff-only", "--quiet", `${remote}/${truth}`]);
  }
  return { truth: await truthState(repo) };
}

/** The review record for a slice, read from the slice head itself, never from the working tree. */
async function committedReview(repo, head, reviewId) {
  if (!reviewId) throw new LockerError("NO_REVIEW", "accept needs --review <id>");
  const text = await git(repo.top, ["show", `${head}:locker/reviews/${reviewId}.json`], { allowFail: true });
  if (text === null) throw new LockerError("NO_REVIEW", `no review record ${reviewId} is committed in the slice; write one with sl review, then sl save it on the slice`);
  try { return JSON.parse(text); } catch { throw new LockerError("NO_REVIEW", `review record ${reviewId} in the slice is not valid JSON`); }
}

/** accepted: squash-merge a reviewed slice onto the truth branch, under the lease, in two steps. */
export async function accept(repo0, actor, { slice, reviewId, message, confirm }) {
  let repo = repo0;
  const { truth, remote } = repo.config;
  checkSliceName(repo, slice);
  const f = await freshen(repo, { force: true });
  if (!f.fetched) throw new LockerError("NOT_FETCHED", `cannot reach ${remote}; accepting needs the remote`);
  // the config that rules is the one on the remote truth branch as just fetched, not whatever the local tracking ref said when the repo was opened
  let fresh = await loadConfig(repo.top, repo.config), bootstrap = false;
  if (fresh.configFrom !== `${remote}/${truth}`) {
    // bootstrap: the project has never had locker.json on its truth branch, and this very slice brings it. The slice's own config rules
    // this one acceptance, with its own actors, confirm list and gate (the lease and a review by another actor still hold); afterwards the remote's copy rules.
    const sliceHead = await revParse(repo.top, `refs/heads/${slice}`);
    const onRemote = await git(repo.top, ["show", `${remote}/${truth}:${CONFIG}`], { allowFail: true });
    const onSlice = sliceHead ? await git(repo.top, ["show", `${sliceHead}:${CONFIG}`], { allowFail: true }) : null;
    if (onRemote !== null || onSlice === null) throw new LockerError("CONFIG", `${CONFIG} is not on ${remote}/${truth}; back the truth branch up before accepting`);
    const ever = await git(repo.top, ["log", "-1", "--format=%H", `${remote}/${truth}`, "--", CONFIG], { allowFail: true });
    if (ever) throw new LockerError("CONFIG", `${CONFIG} was on ${remote}/${truth} before (${ever.slice(0, 7)}) and is gone; a bootstrap is only for a project that never had one. A human puts it back on the truth branch`);
    let cfg; try { cfg = JSON.parse(onSlice); } catch { throw new LockerError("CONFIG", `${CONFIG} in ${slice} is not valid JSON`); }
    fresh = { config: checkConfig(cfg, `${slice} (bootstrap)`), configFrom: `${slice} (bootstrap)` }; bootstrap = true;
  }
  repo = { ...repo, config: fresh.config, configFrom: fresh.configFrom };
  if (!(actor.name in repo.config.actors)) throw new LockerError("NO_ACTOR", `${actor.name} is not an actor in ${CONFIG} on ${repo.configFrom}`);
  const t = await truthState(repo);
  if (t.stale) throw new LockerError("STALE", `${truth} is behind the remote; pull first`);
  if (t.ahead > 0) throw new LockerError("DIVERGED", `${truth} has local commits the remote does not; this needs a person`);
  if (!(await isClean(repo.top))) throw new LockerError("DIRTY", "uncommitted changes; save or discard them before accepting");
  if (!(await holdsLease(repo, actor))) throw new LockerError("NO_LEASE", `accepting needs the lease on ${truth}; run sl lease acquire`);
  const head = await revParse(repo.top, `refs/heads/${slice}`); if (!head) throw new LockerError("NO_SLICE", `no local branch ${slice}`);
  if (await revParse(repo.top, `refs/heads/done/${slice}`)) throw new LockerError("NAME_TAKEN", `done/${slice} already exists; a slice name is used once`);
  const base = await git(repo.top, ["merge-base", truth, slice]);
  const r = await committedReview(repo, head, reviewId);
  if (!(r.reviewer in repo.config.actors)) throw new LockerError("REVIEW_ACTOR", `review ${reviewId} names reviewer "${r.reviewer}", who is not an actor`);
  if (r.reviewer === actor.name) throw new LockerError("REVIEW_SELF", `review ${reviewId} was written by ${actor.name}; a slice is not accepted by its own reviewer`);
  if (r.range.from !== base) throw new LockerError("REVIEW_RANGE", `review ${reviewId} starts at ${String(r.range.from).slice(0, 7)} but the merge base is ${base.slice(0, 7)}`);
  if (r.range.to !== head) {
    // the review record itself is committed after the review, so commits after range.to may only ADD files under locker/reviews/
    const ancestor = await git(repo.top, ["merge-base", "--is-ancestor", r.range.to, head], { allowFail: true });
    if (ancestor === null) throw new LockerError("REVIEW_STALE", `review ${reviewId} covers ${String(r.range.to).slice(0, 7)}, which is not in the history of ${slice}`);
    const z = (await git(repo.top, ["diff", "--name-status", "--no-renames", "-z", `${r.range.to}..${head}`])).split("\0").filter(Boolean);
    const since = []; for (let i = 0; i + 1 < z.length; i += 2) since.push({ st: z[i], file: z[i + 1] });
    const trailing = repo.config.accept.trailing.map(globToRegExp);
    const outside = since.filter(({ st, file }) => !((st === "A" && /^locker\/reviews\/rev_[0-9a-f]{12}\.json$/.test(file)) || (!NEVER_TRAILING.test(file) && trailing.some((re) => re.test(file)))));
    if (outside.length) throw new LockerError("REVIEW_STALE", `review ${reviewId} covers up to ${String(r.range.to).slice(0, 7)} but ${slice} is now at ${head.slice(0, 7)} and changed ${outside.slice(0, 5).map((x) => `${x.st} ${x.file}`).join(", ")}; review the new commits`);
  }
  for (const [file, blob] of Object.entries(r.cited ?? {})) if ((await blobAt(repo.top, head, file)) !== blob) throw new LockerError("REVIEW_STALE", `review ${reviewId} cites ${file} at ${String(blob).slice(0, 7)} but the slice has a different version`);
  if (r.verdict !== "pass") throw new LockerError("REVIEW_BLOCKS", `review ${reviewId} says ${r.verdict}: ${String(r.findings).slice(0, 200)}`);
  const commits = await range(repo.top, base, head);
  const pending = await requireConfirm(repo, actor, "accept", { slice, head, reviewId }, confirm);
  if (pending) return { ...pending, slice, head, commits: commits.length, review: reviewId, ...(bootstrap ? { bootstrap: true } : {}), gate: repo.config.accept.gate ? `${repo.config.accept.gate.join(" ")} will run on ${head.slice(0, 7)} at the confirm step` : null };
  if (repo.config.accept.gate) {
    const gate = await runGate(repo, head, actor);
    if (gate.code !== 0) throw new LockerError("GATE_FAILED", `the project's own gate refused (${repo.config.accept.gate.join(" ")} on ${head.slice(0, 7)}, exit ${gate.code}):\n${gate.output.trim().split("\n").slice(-12).join("\n")}`, { output: gate.output });
  }
  const was = await currentBranch(repo.top);
  await git(repo.top, ["checkout", "--quiet", truth]);
  try {
    await git(repo.top, [...ident(actor), "merge", "--squash", "--quiet", head]);
    const body = `${message ?? `accept ${slice}`}\n\n${trailers({ Slice: slice, "Range-Head": head, "Range-Base": base, Review: reviewId, Actor: `${actor.name} (${actor.kind})`, Session: actor.session })}\n`;
    await git(repo.top, [...ident(actor), "commit", "--quiet", "-F", "-"], { input: body });
    const merge = await revParse(repo.top, "HEAD");
    // last look before the only write that matters: the lease must still be ours and the remote must not have moved
    await freshen(repo, { force: true });
    const stillMine = await holdsLease(repo, actor), remoteTruth = await revParse(repo.top, `${remote}/${truth}`);
    if (!stillMine || remoteTruth !== t.remote) { await git(repo.top, ["reset", "--quiet", "--hard", `${remote}/${truth}`]); throw new LockerError(stillMine ? "STALE" : "NO_LEASE", stillMine ? "the remote truth branch moved while accepting; the local merge was undone. Pull and try again" : "the lease was lost while accepting; the local merge was undone"); }
    const pushed = await git(repo.top, ["push", "--quiet", remote, `${truth}:refs/heads/${truth}`], { allowFail: true });
    if (pushed === null) { await git(repo.top, ["reset", "--quiet", "--hard", `${remote}/${truth}`]); throw new LockerError("PUSH_REFUSED", "the remote refused the push (it moved, or it cannot be reached); the local merge was undone. Pull and try again"); }
    const onRemote = await remoteRef(repo, `refs/heads/${truth}`);
    if (onRemote !== merge) throw new LockerError("NOT_BACKED_UP", `after the push the remote ${truth} is ${onRemote}, not ${merge}; look before doing anything else`);
    await freshen(repo, { force: true });
    await git(repo.top, ["branch", "-m", slice, `done/${slice}`]);
    const kept = await git(repo.top, ["push", "--quiet", remote, `done/${slice}:refs/heads/done/${slice}`], { allowFail: true });
    return { accepted: true, merge, slice, keptAs: `done/${slice}`, keptOnRemote: kept !== null, commits: commits.length, review: reviewId, ...(bootstrap ? { bootstrap: `${CONFIG} was not on ${remote}/${truth}; this slice's copy ruled this acceptance and is now on the truth branch` } : {}) };
  } finally {
    if (was !== slice && was !== truth) await git(repo.top, ["checkout", "--quiet", was], { allowFail: true });
  }
}

/** A way down: a new commit that undoes an accepted one. History is never rewritten. Agents revert on slices only. */
export async function revert(repo, actor, { commit, confirm }) {
  const sha = await revParse(repo.top, commit); if (!sha) throw new LockerError("BAD_COMMIT", `cannot resolve ${commit}`);
  const branch = await currentBranch(repo.top);
  if (branch === "HEAD") throw new LockerError("DETACHED", "not on a branch");
  if (branch === repo.config.truth && actor.kind !== "human") throw new LockerError("AGENT_ON_TRUTH", `an agent does not revert on ${repo.config.truth}; do it on a slice and accept that`);
  if (!(await isClean(repo.top))) throw new LockerError("DIRTY", "uncommitted changes; save or discard them first");
  const pending = await requireConfirm(repo, actor, "revert", { sha, branch }, confirm);
  if (pending) return { ...pending, commit: sha, branch };
  const out = await git(repo.top, [...ident(actor), "revert", "--no-edit", sha], { allowFail: true });
  if (out === null) { await git(repo.top, ["revert", "--abort"], { allowFail: true }); throw new LockerError("REVERT_CONFLICT", "the revert does not apply cleanly; this needs a person"); }
  return { reverted: sha, head: await revParse(repo.top, "HEAD"), branch };
}

/** Make a clone managed. If the project already has a locker.json, nothing is rewritten; only this clone's driver and registration are set. */
export async function init(cwd, { project, truth = "main", remote = "origin", actors, live } = {}) {
  const top = await topLevel(cwd); if (!top) throw new LockerError("UNMANAGED", `${cwd} is not a git work tree; clone first`);
  const url = await git(top, ["remote", "get-url", remote], { allowFail: true });
  if (url === null) throw new LockerError("CONFIG", `remote "${remote}" is not set; add it first (git remote add ${remote} <url>)`);
  let wrote = false;
  try { await stat(join(top, CONFIG)); }
  catch {
    const config = { project: project ?? top.split(/[\\/]/).pop(), truth, remote, actors: actors ?? { rick: "human", claude: "agent", astra: "agent", percept: "model" }, lease: { ttlMinutes: 30 }, fetch: { maxAgeSeconds: 300 }, live: live ?? { kind: "none" }, confirm: ["accept", "revert"] };
    await writeFile(join(top, CONFIG), JSON.stringify(config, null, 2) + "\n"); wrote = true;
  }
  let attrs = ""; try { attrs = await readFile(join(top, ".gitattributes"), "utf8"); } catch { /* none */ }
  if (!attrs.includes("merge=locker-record")) await writeFile(join(top, ".gitattributes"), attrs + (attrs && !attrs.endsWith("\n") ? "\n" : "") + "*.record.json merge=locker-record\nlocker/**/*.json merge=locker-record\n");
  const sl = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sl.js");
  await git(top, ["config", "merge.locker-record.name", "Sim Locker record merge (per top-level key)"]);
  await git(top, ["config", "merge.locker-record.driver", `"${process.execPath}" "${sl}" merge-record %O %A %B %P`]);
  const repo = await openRepo(top);
  return { top, config: repo.config, wroteConfig: wrote, configFrom: repo.configFrom };
}

/** Find records whose text matches. */
export async function find(repo, query) {
  const q = query.toLowerCase(); const hits = [];
  for (const kind of ["reviews", "live"]) for (const r of await listRecords(repo, kind)) if (JSON.stringify(r).toLowerCase().includes(q)) hits.push({ kind, id: r.id ?? r.path, path: r.path, verdict: r.verdict, created: r.created });
  return { query, hits };
}

// ---------- the restore drill ----------

/** Is the remote truth branch enough to get the project back with plain git and nothing else? Push it to a fresh bare repository
 *  (the "second remote"), clone from that without Sim Locker, check the commit and the config came along, then run the project's test
 *  command there. The record count is reported, not checked: the same commit is the same tree. Fails with DRILL_FAILED and leaves the folders for a look; passes and removes them unless told to keep. */
export async function drill(repo, { test = repo.config.drill.test, keep = false, dir } = {}) {
  const f = await freshen(repo, { force: true });
  if (!f.fresh) throw new LockerError("NOT_BACKED_UP", `cannot ask ${repo.config.remote}: ${f.reason}; a drill from a stale tracking ref proves nothing`);
  const { truth, remote } = repo.config;
  const head = await revParse(repo.top, `${remote}/${truth}`);
  if (!head) throw new LockerError("NOT_BACKED_UP", `${remote}/${truth} does not exist; there is nothing to restore from`);
  if ((await git(repo.top, ["rev-parse", "--is-shallow-repository"])) === "true") throw new LockerError("USAGE", "this clone is shallow, so it cannot stand in for the remote; run git fetch --unshallow first");
  let root;
  if (dir) {   // a folder the caller named must be new or empty: the drill only ever removes what it made
    root = resolve(dir); await mkdir(root, { recursive: true });
    if ((await readdir(root)).length) throw new LockerError("USAGE", `${root} is not empty; the drill wants a new or empty folder`);
  } else root = await mkdtemp(join(tmpdir(), "sl-drill-"));
  const bare = join(root, "second.git"), clone = join(root, "restored");
  await git(root, ["init", "--bare", "--quiet", "-b", truth, bare]);
  await git(repo.top, ["push", "--quiet", bare, `${head}:refs/heads/${truth}`]);
  await git(root, ["clone", "--quiet", bare, clone]);
  const restored = await revParse(clone, "HEAD");
  const records = (await git(clone, ["ls-tree", "-r", "--name-only", "HEAD", "locker/"], { allowFail: true }) ?? "").split("\n").filter(Boolean).length;
  const problems = [];
  if (restored !== head) problems.push(`the restored clone is at ${restored}, not ${head}`);
  if (!(await blobAt(clone, "HEAD", CONFIG))) problems.push(`${CONFIG} is not on ${remote}/${truth}`);
  let ran = null;
  if (test) {
    const r = await runCommand(test, clone, { SL_DRILL_COMMIT: head }, repo.config.drill.timeoutSeconds);
    ran = { command: test.join(" "), code: r.code, lastLines: r.output.trim().split("\n").slice(-12).join("\n") };
    if (r.code !== 0) problems.push(`the test command exited ${r.code}:\n${ran.lastLines}`);
  }
  const result = { truth: `${remote}/${truth}`, commit: head, secondRemote: bare, restoredClone: clone, records, test: ran ?? "none (no drill.test on the truth branch's locker.json and no command given)" };
  if (problems.length) throw new LockerError("DRILL_FAILED", `restore drill failed: ${problems.join("; ")}\n(folders kept under ${root})`, { ...result, problems });
  if (!keep) { await rm(dir ? bare : root, { recursive: true, force: true }); if (dir) await rm(clone, { recursive: true, force: true }); result.secondRemote = result.restoredClone = `removed (${root}; pass --keep to keep them)`; }
  return { drilled: true, ...result };
}
