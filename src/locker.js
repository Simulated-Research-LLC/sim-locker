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

/** A refusal: a stable code, one plain sentence, and where there is one, the next command (details.next; the CLI and the MCP
 *  server put it beside the message, so a person and an agent see the same). */
export class LockerError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; this.next = details.next ?? null; }
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
  if (!top) throw new LockerError("UNMANAGED", `${cwd} is not inside a git clone; Sim Locker works only in a clone of the project`, { next: "sl clone <url>" });
  let local; try { local = JSON.parse(await readFile(join(top, CONFIG), "utf8")); }
  catch (e) { throw new LockerError("UNMANAGED", `${top} is a git clone with no ${CONFIG}; run sl init here to make it managed`, { cause: String(e), next: "sl init" }); }
  for (const key of ["project", "truth", "remote", "actors"]) if (!(key in local)) throw new LockerError("CONFIG", `${CONFIG} lacks "${key}"`);
  const remoteUrl = await git(top, ["remote", "get-url", local.remote], { allowFail: true });
  if (remoteUrl === null) throw new LockerError("UNMANAGED", `remote "${local.remote}" is not set in ${top}`, { next: `git remote add ${local.remote} <url>` });
  const { config, configFrom } = await loadConfig(top, local);
  const repo = { top, config, configFrom, remoteUrl, gitDir: await gitDir(top) };
  await registerClone(repo);                                           // every clone that runs the tool is known to the registry
  return repo;
}

/** The actor is stamped by the tool from SL_ACTOR, never taken from a payload. The session is SL_SESSION, or one id per clone. */
export async function actorFromEnv(repo, env = process.env) {
  const name = env.SL_ACTOR, config = repo.config;
  const names = Object.keys(config.actors).join(", ");
  if (!name) throw new LockerError("NO_ACTOR", `SL_ACTOR is not set; it says who you are, one of: ${names}`, { next: "export SL_ACTOR=<name>" });
  const kind = config.actors[name];
  if (!kind) throw new LockerError("NO_ACTOR", `SL_ACTOR="${name}" is not an actor in ${CONFIG} on ${repo.configFrom}; the actors are ${names}`, { next: "export SL_ACTOR=<name>" });
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
  if (pushed === null) throw new LockerError("LEASE_RACE", "someone else changed the lease at the same moment; look at sl status before trying again", { next: "sl status" });
  await git(repo.top, ["update-ref", LEASE_REF, commit]);
  return commit;
}

export async function lease(repo, actor, action) {
  const f = await freshen(repo, { force: true });
  if (!f.fetched) throw new LockerError("NOT_FETCHED", `cannot reach ${repo.config.remote}, and the lease lives there; check the connection`, { next: "sl status" });
  const { sha, lease: cur } = await readLease(repo);
  const mine = cur && cur.owner === actor.name && cur.session === actor.session;
  if (action === "status") return { lease: cur, mine: !!mine };
  if (action === "release") {
    if (!cur || cur.owner === null) return { released: false, reason: "no lease is held" };
    if (!mine && !cur.expired) throw new LockerError("LEASE_HELD", `the lease is held by ${cur.owner} (session ${cur.session}) for another ${minutesLeft(cur)} min, until ${cur.expires}`, { next: "wait for it to expire, or its owner runs sl lease release" });
    await writeLeaseRef(repo, { owner: null, session: null, expires: new Date().toISOString(), releasedBy: actor.name }, sha);
    return { released: true };
  }
  if (cur && cur.owner && !cur.expired && !mine) throw new LockerError("LEASE_HELD", `the lease is held by ${cur.owner} (session ${cur.session}) for another ${minutesLeft(cur)} min, until ${cur.expires}`, { next: "wait for it to expire, or its owner runs sl lease release" });
  if (action === "renew" && !mine) throw new LockerError("LEASE_NOT_MINE", "nothing to renew: this session does not hold the lease", { next: "sl lease acquire" });
  const expires = new Date(Date.now() + repo.config.lease.ttlMinutes * 60 * 1000).toISOString();
  const next = { owner: actor.name, kind: actor.kind, session: actor.session, acquired: mine ? cur.acquired : new Date().toISOString(), expires };
  await writeLeaseRef(repo, next, sha);
  return { lease: { ...next, expired: false }, action: mine ? "renewed" : "acquired" };
}

const minutesLeft = (lease) => Math.max(0, Math.ceil((Date.parse(lease.expires) - Date.now()) / 60000));

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
  if (!toSha || !fromRef) throw new LockerError("BAD_RANGE", `cannot find ${!fromRef ? from : to} in this folder; the range is <truth branch>..<slice>`, { next: `sl review ${repo.config.truth}..<slice> --verdict pass|fix|block -f "<findings>"` });
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
    if (!hit || hit.key !== key) throw new LockerError("BAD_CONFIRM", "that confirm token does not match this command, actor and session, or it expired (10 minutes)", { next: "run the command again without --confirm to get a new token" });
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

/** The truth about where this folder stands. Problems first, each with the command that fixes it; with no problem, the next step
 *  toward the next of the four words. `next` is a list the same length as `problems` plus one, so a caller never parses prose. */
export async function status(repo, { fetch = true } = {}) {
  const { truth: truthName, remote: remoteName } = repo.config;
  const problems = [], next = [];
  const problem = (code, text, fix) => { problems.push(text); next.push({ code, fix }); };
  const humans = Object.entries(repo.config.actors).filter(([, k]) => k === "human").map(([n]) => n).join(" or ") || "<a human actor>";
  const freshness = fetch ? await freshen(repo) : { fetched: false, fresh: false, reason: "fetch skipped by request", ageSeconds: await lastFetchAge(repo).then((a) => (a === null ? null : Math.round(a))) };
  if (!freshness.fresh) problem("NOT FETCHED", `NOT FETCHED: ${freshness.reason}; everything below about the remote and the lease may be out of date`, fetch ? `check the connection to ${repo.remoteUrl}, then sl status again` : "sl status without --no-fetch (over MCP: status with fetch true)");
  const truth = await truthState(repo);
  const branch0 = await currentBranch(repo.top), dirty0 = branch0 === truthName && !(await isClean(repo.top));
  if (truth.stale) problem("STALE", `STALE: ${truthName} is ${truth.behind} save(s) behind ${remoteName}/${truthName}; pull before saving on it or accepting`, dirty0 ? `sl save -m "<what and why>" --slice <name> (a new slice starts from ${remoteName}/${truthName}), then sl pull` : "sl pull");
  if (!truth.remote) problem("NO REMOTE TRUTH", `NO REMOTE TRUTH: ${remoteName}/${truthName} does not exist; nothing has ever been backed up`, `on ${truthName}, as ${humans}: sl backup`);
  if (repo.configFrom === "working tree") problem("CONFIG FROM WORKING TREE", `CONFIG FROM WORKING TREE: ${CONFIG} is not on ${truthName} yet; save and back it up`, `as ${humans}, on ${truthName}: sl save -m "manage with sim locker" ${CONFIG} .gitattributes, then sl backup`);
  const others = await otherClones(repo);
  if (others.length) problem("TWO CLONES", `TWO CLONES: this project is also cloned at ${others.join(", ")}; one machine, one clone`, `keep one folder (this one is ${repo.top}) and move the other aside; a folder that is gone is forgotten on the next sl status`);
  const { lease: cur, corrupt } = await readLease(repo);
  if (corrupt) problem("LEASE CORRUPT", "LEASE CORRUPT: refs/heads/locker/lease does not hold valid JSON", "sl lease acquire writes a fresh one");
  if (cur?.owner && !cur.expired) problem("LEASE HELD", `LEASE HELD BY ${cur.owner} (${cur.kind}, session ${cur.session}) until ${cur.expires}`, `it expires in ${minutesLeft(cur)} min; wait, or ${cur.owner} runs sl lease release`);
  const branch = await currentBranch(repo.top);
  const reviewCmd = `sl review ${truthName}..${branch === "HEAD" ? "<slice>" : branch} --verdict pass|fix|block -f "<findings>"`;
  for (const s of await staleReviews(repo)) problem("STALE REVIEW", `STALE REVIEW ${s.id}: ${s.moved.length} cited file(s) changed since: ${s.moved.slice(0, 5).join(", ")}${s.moved.length > 5 ? ", ..." : ""}`, `locker/reviews/${s.id}.json no longer matches the files; a different actor reviews again: ${reviewCmd}`);
  if (await mergeInProgress(repo)) { const files = await unsettled(repo); problem("UPDATE WAITING", files.length ? `UPDATE WAITING: an update left ${files.length} file(s) with lines to settle: ${files.slice(0, 5).join(", ")}` : "UPDATE WAITING: an update is settled but not yet saved", settleNext(files)); }
  if (branch === "HEAD") problem("DETACHED", "DETACHED: not on any branch; check out a slice or the truth branch", `sl save -m "<what and why>" --slice <name> puts the folder on a slice branch`);
  const dirty = await changedFiles(repo.top);
  const slice = await sliceState(repo, branch);
  const ab = await aheadBehind(repo.top, branch, `${remoteName}/${branch}`);
  const reviews = (await listRecords(repo, "reviews")).map((r) => ({ id: r.id, verdict: r.verdict, reviewer: r.reviewer, to: r.range?.to }));
  // a review stays current when the only save after the head it covers added the record itself
  const lastFiles = ((await git(repo.top, ["show", "--name-only", "--format=", "HEAD"], { allowFail: true })) ?? "").split("\n").filter(Boolean);
  const reviewedHead = lastFiles.length && lastFiles.every((f) => f.startsWith("locker/reviews/")) ? await revParse(repo.top, "HEAD~1") : slice.head;
  const onTruth = branch === truthName, passed = reviews.find((r) => (r.to === slice.head || r.to === reviewedHead) && r.verdict === "pass");
  let step;
  if (branch === "HEAD") step = `not on a branch: sl save -m "<what and why>" --slice <name> (a new slice starts from ${remoteName}/${truthName})`;
  else if (onTruth && truth.stale) step = dirty.length ? `${truthName} is behind and ${dirty.length} file(s) not saved: sl save -m "<what and why>" --slice <name> (a new slice starts from ${remoteName}/${truthName}), then sl pull` : `${truthName} is behind: sl pull first`;
  else if (dirty.length) step = `${dirty.length} file(s) not saved: sl save -m "<what and why>"${onTruth ? ` --slice <name> (only ${humans} saves on ${truthName} itself)` : ""}`;
  else if (!slice.backedUp) step = `saved, not backed up: sl backup`;
  else if (onTruth) step = slice.live.applies && slice.live.commit !== slice.head ? `${truthName} is backed up; when this version is what people use: sl live ${slice.head.slice(0, 7)}` : `nothing waiting; ${truthName} is backed up`;
  else if (slice.accepted) step = `accepted as ${slice.accepted.slice(0, 7)} on ${truthName}; nothing waiting on this slice`;
  else if (passed) step = `reviewed (${passed.id}, pass); to accept: sl lease acquire, then sl accept ${branch} --review ${passed.id}`;
  else step = `backed up, not reviewed: a different actor runs ${reviewCmd}, then sl save the record and sl accept ${branch} --review <id>`;
  next.push({ step });
  return { project: repo.config.project, path: repo.top, remote: repo.remoteUrl, configFrom: repo.configFrom, freshness, problems, next, truth: { branch: truthName, ...truth }, current: { ...slice, onTruth, ahead: ab.ahead, behind: ab.behind, uncommitted: dirty }, lease: cur ?? null, reviews };
}

/** saved: commit the work on the current slice branch, stamped with the actor. Refuses a stale folder, and refuses agents on the truth branch. */
export async function save(repo, actor, { message, paths = [], slice } = {}) {
  if (!message) throw new LockerError("NO_MESSAGE", "save needs a message that says what changed and why", { next: `sl save -m "<what and why>"` });
  const f = await freshen(repo);
  const truth = await truthState(repo);
  const before = await currentBranch(repo.top);
  if (slice !== undefined) checkSliceName(repo, slice);
  // a stale truth branch refuses a save on itself; a slice is its own line, and a new one starts from the remote's truth, so it is never stale
  if (truth.stale && (slice ?? before) === repo.config.truth) {
    const dirty = !(await isClean(repo.top));
    throw new LockerError("STALE", `${repo.config.truth} here is ${truth.behind} save(s) behind the remote${dirty ? ", and it has changes not yet saved" : ""}`, { next: dirty ? `sl save -m "<what and why>" --slice <name> (a new slice starts from the remote's ${repo.config.truth}), then sl pull` : "sl pull" });
  }
  if (await mergeInProgress(repo) && (paths.length || (slice && slice !== before))) throw new LockerError("UPDATE_CONFLICT", "an update is waiting; it is finished with one save of everything, on this branch", { next: `sl save -m "<what and why>" (no paths, no --slice)` });
  let note;
  if (slice && slice !== before) {
    const exists = await revParse(repo.top, `refs/heads/${slice}`);
    if (exists) await git(repo.top, ["checkout", "--quiet", slice]);
    else if (truth.remote && (await git(repo.top, ["checkout", "--quiet", "-b", slice, truth.remote], { allowFail: true })) === null) {
      // the unsaved change touches a file the remote also changed, so the new slice cannot start from the remote's truth; it starts
      // from the local one instead and is simply behind, which accept handles from the merge base
      await git(repo.top, ["checkout", "--quiet", "-b", slice, repo.config.truth]);
      note = `the slice starts from the local ${repo.config.truth}, ${truth.behind} save(s) behind the remote, because the unsaved change touches a file the remote also changed`;
    } else if (!truth.remote) await git(repo.top, ["checkout", "--quiet", "-b", slice, repo.config.truth]);
  }
  const branch = await currentBranch(repo.top);                       // what git says, not what the caller said
  if (branch === "HEAD") throw new LockerError("DETACHED", "this folder is not on a branch, so there is nowhere to save to", { next: `sl save -m "<what and why>" --slice <name>` });
  if (branch === repo.config.truth && actor.kind !== "human") throw new LockerError("AGENT_ON_TRUTH", `an agent does not save on ${repo.config.truth}; it saves on a slice branch and the slice is accepted after a review`, { next: `sl save -m "<what and why>" --slice <name>` });
  if (branch === repo.config.truth && !f.fresh) throw new LockerError("NOT_FETCHED", `cannot reach the remote, so it is unknown whether ${repo.config.truth} is behind; saving on the truth branch waits`, { next: "check the connection, then sl status" });
  await git(repo.top, ["add", "-A", "--", ...(paths.length ? paths : ["."])]);
  if (await mergeInProgress(repo)) {   // finishing an update: every marked line must be settled, or the markers would be saved as content
    const left = await unsettled(repo, { staged: true });
    if (left.length) throw new LockerError("MARKERS_LEFT", `${left.join(", ")} still holds git's marks; the update is not finished`, { files: left, next: settleNext(left) });
  }
  if (await isClean(repo.top)) return { saved: false, reason: "nothing to save", branch, head: await revParse(repo.top, "HEAD") };
  const body = `${message}\n\n${trailers({ Actor: `${actor.name} (${actor.kind})`, Session: actor.session })}\n`;
  await git(repo.top, [...ident(actor), "commit", "--quiet", "-F", "-"], { input: body });
  const head = await revParse(repo.top, "HEAD");
  const files = (await git(repo.top, ["show", "--name-only", "--format=", head])).split("\n").filter(Boolean);
  return { saved: true, branch, head, actor: actor.name, files, ...(note ? { note } : {}), ...(f.fresh ? {} : { warning: `NOT FETCHED: ${f.reason}` }) };
}

/** backed up: push the current branch and prove it arrived by asking the remote for the ref. The push exit code alone is not evidence. */
export async function backup(repo) {
  const branch = await currentBranch(repo.top), head = await revParse(repo.top, "HEAD");
  if (branch === "HEAD") throw new LockerError("DETACHED", "this folder is not on a branch, so there is nothing to back up", { next: `sl save -m "<what and why>" --slice <name>` });
  if (!(await isClean(repo.top))) throw new LockerError("DIRTY", "there are changes not yet saved; save first, then back up", { next: `sl save -m "<what and why>"` });
  const pushed = await git(repo.top, ["push", "--quiet", repo.config.remote, `${branch}:refs/heads/${branch}`], { allowFail: true });
  if (pushed === null) throw new LockerError("PUSH_REFUSED", `the remote refused the backup of ${branch}: it has saves this folder does not, or it cannot be reached; Sim Locker never forces`, { next: branch === repo.config.truth ? "sl pull, then sl backup" : "check the connection, then sl status" });
  const onRemote = await remoteRef(repo, `refs/heads/${branch}`);
  if (onRemote === null) throw new LockerError("NOT_BACKED_UP", `the backup was sent but the remote could not be asked for ${branch} afterwards, so it does not count as backed up`, { next: "sl backup again when the remote answers" });
  if (onRemote !== head) throw new LockerError("NOT_BACKED_UP", `after the backup the remote ${branch} is ${onRemote}, not ${head}`, { next: "sl status" });
  await freshen(repo, { force: true });
  return { backedUp: true, branch, head, remote: repo.remoteUrl, verifiedBy: "ls-remote" };
}

/** Bring the truth branch up to date, fast-forward only. */
export async function pull(repo) {
  const f = await freshen(repo, { force: true });
  if (!f.fetched) throw new LockerError("NOT_FETCHED", `cannot reach ${repo.config.remote}`, { next: "check the connection, then sl pull" });
  const { truth, remote } = repo.config;
  const t = await truthState(repo);
  if (t.ahead > 0) throw new LockerError("DIVERGED", `${truth} here has ${t.ahead} save(s) the remote does not; a person decides which side to keep`);
  const branch = await currentBranch(repo.top);
  if (branch !== truth) await git(repo.top, ["fetch", "--quiet", repo.config.remote, `${truth}:${truth}`]);
  else {
    if (!(await isClean(repo.top))) throw new LockerError("DIRTY", "there are changes not yet saved on the truth branch; save or discard them before pulling", { next: `sl save -m "<what and why>"` });
    await git(repo.top, ["merge", "--ff-only", "--quiet", `${remote}/${truth}`]);
  }
  return { truth: await truthState(repo) };
}

/** Bring the truth branch's changes into the current slice, as a save stamped with the actor, so the slice can be accepted after the
 *  truth branch moved. A line both sides changed is left in the file with git's marks for a person to settle, then saved. */
export async function update(repo, actor, { message } = {}) {
  const { truth, remote } = repo.config;
  const branch = await currentBranch(repo.top);
  if (branch === "HEAD") throw new LockerError("DETACHED", "this folder is not on a branch", { next: `sl save -m "<what and why>" --slice <name>` });
  if (branch === truth) throw new LockerError("BAD_SLICE", `${truth} is the truth branch; update brings ${truth} into a slice`, { next: "sl pull" });
  if (await mergeInProgress(repo)) { const files = await unsettled(repo); throw new LockerError("UPDATE_CONFLICT", files.length ? `an update is already waiting on ${files.join(", ")}` : "an update is settled but not yet saved", { files, next: settleNext(files) }); }
  if (!(await isClean(repo.top))) throw new LockerError("DIRTY", "there are changes not yet saved; save them first", { next: `sl save -m "<what and why>"` });
  const f = await freshen(repo, { force: true });
  if (!f.fetched) throw new LockerError("NOT_FETCHED", `cannot reach ${remote}`, { next: "check the connection, then sl update" });
  const target = await revParse(repo.top, `${remote}/${truth}`);
  if (!target) throw new LockerError("NOT_BACKED_UP", `${remote}/${truth} does not exist; nothing to bring in`);
  if ((await git(repo.top, ["merge-base", "--is-ancestor", target, "HEAD"], { allowFail: true })) !== null) return { updated: false, reason: `${branch} already has everything on ${remote}/${truth}`, branch, head: await revParse(repo.top, "HEAD") };
  const body = `${message ?? `bring ${truth} into ${branch}`}\n\n${trailers({ Actor: `${actor.name} (${actor.kind})`, Session: actor.session })}\n`;
  try { await git(repo.top, [...ident(actor), "merge", "--no-ff", "--quiet", "-m", body, `${remote}/${truth}`]); } catch (e) {
    const files = await conflictFiles(repo);
    if (!files.length) { await git(repo.top, ["merge", "--abort"], { allowFail: true }); throw new LockerError("GIT", `bringing ${truth} into ${branch} failed: ${(e.stderr ?? String(e)).trim()}`, { next: "sl status" }); }
    throw new LockerError("UPDATE_CONFLICT", `${branch} and ${truth} changed the same lines in ${files.join(", ")}; those lines are in the files now with git's marks`, { files, next: settleNext(files) });
  }
  return { updated: true, branch, head: await revParse(repo.top, "HEAD"), from: target, actor: actor.name };
}
const mergeInProgress = async (repo) => (await stat(join(repo.gitDir, "MERGE_HEAD")).catch(() => null)) !== null;
/** While an update waits: the files still unmerged, plus files the update touched that still hold git's marks (in the index when staged is set, else in the tree). */
async function unsettled(repo, { staged = false } = {}) {
  const still = await conflictFiles(repo);
  const touched = ((await git(repo.top, ["diff", "--name-only", "HEAD", "MERGE_HEAD"], { allowFail: true })) ?? "").split("\n").filter(Boolean);
  const marked = touched.length ? ((await git(repo.top, ["grep", "-l", ...(staged ? ["--cached"] : []), "-e", "^<<<<<<< ", "-e", "^=======$", "-e", "^>>>>>>> ", "--", ...touched], { allowFail: true })) ?? "").split("\n").filter(Boolean) : [];
  return [...new Set([...still, ...marked])];
}
const conflictFiles = async (repo) => ((await git(repo.top, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true })) ?? "").split("\n").filter(Boolean);
const settleNext = (files) => files.length ? `open ${files.join(", ")}, keep the lines you want between the <<<<<<< and >>>>>>> marks and delete the marks (in a record file the two sides are keys named "<<<<<<< ours" and ">>>>>>> theirs"), then sl save -m "<what and why>"` : `the marked lines are settled; sl save -m "<what and why>" finishes the update`;

/** The review record for a slice, read from the slice head itself, never from the working tree. */
async function committedReview(repo, head, reviewId) {
  const reviewCmd = `sl review ${repo.config.truth}..<slice> --verdict pass -f "<findings>" (as a different actor), then sl save the record on the slice`;
  if (!reviewId) throw new LockerError("NO_REVIEW", "accept needs the id of a review record: --review <id>", { next: reviewCmd });
  const text = await git(repo.top, ["show", `${head}:locker/reviews/${reviewId}.json`], { allowFail: true });
  if (text === null) throw new LockerError("NO_REVIEW", `no review record ${reviewId} is saved in the slice`, { next: reviewCmd });
  try { return JSON.parse(text); } catch { throw new LockerError("NO_REVIEW", `review record ${reviewId} in the slice is not valid JSON`); }
}

/** accepted: squash-merge a reviewed slice onto the truth branch, under the lease, in two steps. */
export async function accept(repo0, actor, { slice, reviewId, message, confirm }) {
  let repo = repo0;
  const { truth, remote } = repo.config;
  checkSliceName(repo, slice);
  const f = await freshen(repo, { force: true });
  if (!f.fetched) throw new LockerError("NOT_FETCHED", `cannot reach ${remote}, and accepting needs it`, { next: "check the connection, then sl status" });
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
  if (t.stale) throw new LockerError("STALE", `${truth} here is behind the remote`, { next: "sl pull" });
  if (t.ahead > 0) throw new LockerError("DIVERGED", `${truth} here has saves the remote does not; a person decides which side to keep`);
  if (!(await isClean(repo.top))) throw new LockerError("DIRTY", "there are changes not yet saved; save or discard them before accepting", { next: `sl save -m "<what and why>"` });
  if (!(await holdsLease(repo, actor))) throw new LockerError("NO_LEASE", `accepting needs the lease on ${truth}`, { next: "sl lease acquire" });
  const head = await revParse(repo.top, `refs/heads/${slice}`); if (!head) throw new LockerError("NO_SLICE", `there is no branch ${slice} in this folder`, { next: "sl status" });
  if (await revParse(repo.top, `refs/heads/done/${slice}`)) throw new LockerError("NAME_TAKEN", `done/${slice} already exists; a slice name is used once`);
  const base = await git(repo.top, ["merge-base", truth, slice]);
  const r = await committedReview(repo, head, reviewId);
  if (!(r.reviewer in repo.config.actors)) throw new LockerError("REVIEW_ACTOR", `review ${reviewId} names reviewer "${r.reviewer}", who is not an actor`);
  const reviewAgain = `a different actor runs sl review ${truth}..${slice} --verdict pass -f "<findings>", then sl save the record on the slice`;
  if (r.reviewer === actor.name) throw new LockerError("REVIEW_SELF", `review ${reviewId} was written by ${actor.name}; a slice is not accepted by its own reviewer`, { next: `another actor accepts, or ${reviewAgain}` });
  if (r.range.from !== base) throw new LockerError("REVIEW_RANGE", `review ${reviewId} starts at ${String(r.range.from).slice(0, 7)} but the slice now leaves ${truth} at ${base.slice(0, 7)}`, { next: reviewAgain });
  if (r.range.to !== head) {
    // the review record itself is committed after the review, so commits after range.to may only ADD files under locker/reviews/
    const ancestor = await git(repo.top, ["merge-base", "--is-ancestor", r.range.to, head], { allowFail: true });
    if (ancestor === null) throw new LockerError("REVIEW_STALE", `review ${reviewId} covers ${String(r.range.to).slice(0, 7)}, which is not an earlier version of ${slice}`, { next: reviewAgain });
    const z = (await git(repo.top, ["diff", "--name-status", "--no-renames", "-z", `${r.range.to}..${head}`])).split("\0").filter(Boolean);
    const since = []; for (let i = 0; i + 1 < z.length; i += 2) since.push({ st: z[i], file: z[i + 1] });
    const trailing = repo.config.accept.trailing.map(globToRegExp);
    const outside = since.filter(({ st, file }) => !((st === "A" && /^locker\/reviews\/rev_[0-9a-f]{12}\.json$/.test(file)) || (!NEVER_TRAILING.test(file) && trailing.some((re) => re.test(file)))));
    if (outside.length) throw new LockerError("REVIEW_STALE", `review ${reviewId} covers up to ${String(r.range.to).slice(0, 7)} but ${slice} is now at ${head.slice(0, 7)} and changed ${outside.slice(0, 5).map((x) => `${x.st} ${x.file}`).join(", ")}; the new saves need a review`, { next: reviewAgain });
  }
  for (const [file, blob] of Object.entries(r.cited ?? {})) if ((await blobAt(repo.top, head, file)) !== blob) throw new LockerError("REVIEW_STALE", `review ${reviewId} cites ${file} at ${String(blob).slice(0, 7)} but the slice has a different version`, { next: reviewAgain });
  if (r.verdict !== "pass") throw new LockerError("REVIEW_BLOCKS", `review ${reviewId} says ${r.verdict}: ${String(r.findings).slice(0, 200)}`, { next: `fix the findings, sl save, then ${reviewAgain}` });
  const commits = await range(repo.top, base, head);
  const pending = await requireConfirm(repo, actor, "accept", { slice, head, reviewId }, confirm);
  if (pending) return { ...pending, slice, head, commits: commits.length, review: reviewId, ...(bootstrap ? { bootstrap: true } : {}), gate: repo.config.accept.gate ? `${repo.config.accept.gate.join(" ")} will run on ${head.slice(0, 7)} at the confirm step` : null };
  if (repo.config.accept.gate) {
    const gate = await runGate(repo, head, actor);
    if (gate.code !== 0) throw new LockerError("GATE_FAILED", `the project's own gate refused (${repo.config.accept.gate.join(" ")} on ${head.slice(0, 7)}, exit ${gate.code}):\n${gate.output.trim().split("\n").slice(-12).join("\n")}`, { output: gate.output });
  }
  const was = await currentBranch(repo.top); let done = false;
  await git(repo.top, ["checkout", "--quiet", truth]);
  try {
    try { await git(repo.top, [...ident(actor), "merge", "--squash", "--quiet", head]); } catch (e) {
      // nothing half-done is left on the truth branch, and the folder goes back to the slice so the next step can be run from there
      const files = await conflictFiles(repo);
      await git(repo.top, ["reset", "--quiet", "--hard", `${remote}/${truth}`]);
      await git(repo.top, ["clean", "-fq"], { allowFail: true });   // the tree had no untracked file before the squash (DIRTY refused), so any file now is the squash's debris; folders are left
      await git(repo.top, ["checkout", "--quiet", slice]); done = true;
      if (!files.length) throw new LockerError("GIT", `the squash of ${slice} onto ${truth} failed: ${(e.stderr ?? String(e)).trim()}`, { next: "sl status" });
      throw new LockerError("ACCEPT_CONFLICT", `${slice} and ${truth} changed the same lines in ${files.join(", ")}; the slice has to take ${truth}'s version of those lines first`, { files, next: `on ${slice}: sl update (brings ${truth} into the slice; a line both changed is left for you to settle), then sl backup, a new review, then sl accept` });
    }
    const body = `${message ?? `accept ${slice}`}\n\n${trailers({ Slice: slice, "Range-Head": head, "Range-Base": base, Review: reviewId, Actor: `${actor.name} (${actor.kind})`, Session: actor.session })}\n`;
    await git(repo.top, [...ident(actor), "commit", "--quiet", "-F", "-"], { input: body });
    const merge = await revParse(repo.top, "HEAD");
    // last look before the only write that matters: the lease must still be ours and the remote must not have moved
    await freshen(repo, { force: true });
    const stillMine = await holdsLease(repo, actor), remoteTruth = await revParse(repo.top, `${remote}/${truth}`);
    if (!stillMine || remoteTruth !== t.remote) { await git(repo.top, ["reset", "--quiet", "--hard", `${remote}/${truth}`]); throw new LockerError(stillMine ? "STALE" : "NO_LEASE", stillMine ? "the remote truth branch moved while accepting; the local merge was undone" : "the lease was lost while accepting; the local merge was undone", { next: stillMine ? "sl pull, then sl accept again" : "sl lease acquire, then sl accept again" }); }
    const pushed = await git(repo.top, ["push", "--quiet", remote, `${truth}:refs/heads/${truth}`], { allowFail: true });
    if (pushed === null) { await git(repo.top, ["reset", "--quiet", "--hard", `${remote}/${truth}`]); throw new LockerError("PUSH_REFUSED", "the remote refused the push (it moved, or it cannot be reached); the local merge was undone", { next: "sl pull, then sl accept again" }); }
    const onRemote = await remoteRef(repo, `refs/heads/${truth}`);
    if (onRemote !== merge) throw new LockerError("NOT_BACKED_UP", `after the push the remote ${truth} is ${onRemote}, not ${merge}; look before doing anything else`);
    await freshen(repo, { force: true });
    await git(repo.top, ["branch", "-m", slice, `done/${slice}`]);
    const kept = await git(repo.top, ["push", "--quiet", remote, `done/${slice}:refs/heads/done/${slice}`], { allowFail: true });
    return { accepted: true, merge, slice, keptAs: `done/${slice}`, keptOnRemote: kept !== null, commits: commits.length, review: reviewId, ...(bootstrap ? { bootstrap: `${CONFIG} was not on ${remote}/${truth}; this slice's copy ruled this acceptance and is now on the truth branch` } : {}) };
  } finally {
    if (!done && was !== slice && was !== truth) await git(repo.top, ["checkout", "--quiet", was], { allowFail: true });
  }
}

/** A way down: a new commit that undoes an accepted one. History is never rewritten. Agents revert on slices only. */
export async function revert(repo, actor, { commit, confirm }) {
  const sha = await revParse(repo.top, commit); if (!sha) throw new LockerError("BAD_COMMIT", `cannot resolve ${commit}`);
  const branch = await currentBranch(repo.top);
  if (branch === "HEAD") throw new LockerError("DETACHED", "this folder is not on a branch", { next: `sl save -m "<what and why>" --slice <name>` });
  if (branch === repo.config.truth && actor.kind !== "human") throw new LockerError("AGENT_ON_TRUTH", `an agent does not revert on ${repo.config.truth}; it reverts on a slice and the slice is accepted`, { next: `sl save -m "<what and why>" --slice <name>, then sl revert` });
  if (!(await isClean(repo.top))) throw new LockerError("DIRTY", "there are changes not yet saved; save or discard them first", { next: `sl save -m "<what and why>"` });
  const pending = await requireConfirm(repo, actor, "revert", { sha, branch }, confirm);
  if (pending) return { ...pending, commit: sha, branch };
  const out = await git(repo.top, [...ident(actor), "revert", "--no-edit", sha], { allowFail: true });
  if (out === null) { await git(repo.top, ["revert", "--abort"], { allowFail: true }); throw new LockerError("REVERT_CONFLICT", "the undo does not apply cleanly on its own; a person does it by hand"); }
  return { reverted: sha, head: await revParse(repo.top, "HEAD"), branch };
}

/** Make a clone managed. If the project already has a locker.json, nothing is rewritten; only this clone's driver and registration are set. */
export async function init(cwd, { project, truth = "main", remote = "origin", actors, live } = {}) {
  const top = await topLevel(cwd); if (!top) throw new LockerError("UNMANAGED", `${cwd} is not a git clone; Sim Locker works only in a clone of the project`, { next: "sl clone <url>" });
  const url = await git(top, ["remote", "get-url", remote], { allowFail: true });
  if (url === null) throw new LockerError("CONFIG", `remote "${remote}" is not set in ${top}`, { next: `git remote add ${remote} <url>, then sl init` });
  const wrote = [];
  try { await stat(join(top, CONFIG)); }
  catch {
    const config = { project: project ?? top.split(/[\\/]/).pop(), truth, remote, actors: actors ?? { rick: "human", claude: "agent", astra: "agent", percept: "model" }, lease: { ttlMinutes: 30 }, fetch: { maxAgeSeconds: 300 }, live: live ?? { kind: "none" }, confirm: ["accept", "revert"] };
    await writeFile(join(top, CONFIG), JSON.stringify(config, null, 2) + "\n"); wrote.push(`${CONFIG} (project ${config.project}, truth branch ${truth}, remote ${remote}, actors ${Object.keys(config.actors).join(", ")})`);
  }
  let attrs = ""; try { attrs = await readFile(join(top, ".gitattributes"), "utf8"); } catch { /* none */ }
  if (!attrs.includes("merge=locker-record")) { await writeFile(join(top, ".gitattributes"), attrs + (attrs && !attrs.endsWith("\n") ? "\n" : "") + "*.record.json merge=locker-record\nlocker/**/*.json merge=locker-record\n"); wrote.push(".gitattributes (record files merge per key)"); }
  const sl = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sl.js");
  await git(top, ["config", "merge.locker-record.name", "Sim Locker record merge (per top-level key)"]);
  await git(top, ["config", "merge.locker-record.driver", `"${process.execPath}" "${sl}" merge-record %O %A %B %P`]);
  wrote.push(".git/config (the record merge driver, this clone only)");
  const repo = await openRepo(top);
  const humans = Object.entries(repo.config.actors).filter(([, k]) => k === "human").map(([n]) => n).join(" or ") || "<a human actor>";
  const next = repo.configFrom === "working tree" ? `as ${humans}, on ${truth}: sl save -m "manage with sim locker" ${CONFIG} .gitattributes, then sl backup; then every command needs SL_ACTOR set` : `${CONFIG} already rules from ${repo.configFrom}; set SL_ACTOR and run sl status`;
  return { top, config: repo.config, wroteConfig: wrote.some((w) => w.startsWith(CONFIG)), wrote, configFrom: repo.configFrom, next };
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
export async function drill(repo, { test, keep = false, dir } = {}) {
  const f = await freshen(repo, { force: true });
  if (!f.fresh) throw new LockerError("NOT_BACKED_UP", `cannot ask ${repo.config.remote}: ${f.reason}; a drill from an old copy of the remote proves nothing`, { next: "check the connection, then sl drill" });
  const { truth, remote } = repo.config;
  const head = await revParse(repo.top, `${remote}/${truth}`);
  if (!head) throw new LockerError("NOT_BACKED_UP", `${remote}/${truth} does not exist; there is nothing to restore from`, { next: `on ${truth}, as a human actor: sl backup` });
  if ((await git(repo.top, ["rev-parse", "--is-shallow-repository"])) === "true") throw new LockerError("USAGE", "this clone holds only part of the history (a shallow clone), so it cannot stand in for the remote", { next: "git fetch --unshallow, then sl drill" });
  // the drill settings come from the exact commit being restored, read after the fetch, not from the config openRepo loaded before it
  const text = await git(repo.top, ["show", `${head}:${CONFIG}`], { allowFail: true });
  let settings = { test: null, timeoutSeconds: 900 };
  if (text !== null) { try { settings = checkConfig(JSON.parse(text), head.slice(0, 7)).drill; } catch (e) { if (!(e instanceof LockerError)) throw new LockerError("CONFIG", `${CONFIG} on ${head.slice(0, 7)} is not valid JSON`); throw e; } }
  if (test === undefined) test = settings.test;
  let root;
  if (dir) {   // a folder the caller named must be new or empty: the drill only ever removes what it made
    root = resolve(dir);
    const st = await stat(root).catch(() => null);
    if (st && !st.isDirectory()) throw new LockerError("USAGE", `${root} is a file, not a folder`);
    await mkdir(root, { recursive: true });
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
    const r = await runCommand(test, clone, { SL_DRILL_COMMIT: head }, settings.timeoutSeconds);
    ran = { command: test.join(" "), code: r.code, lastLines: r.output.trim().split("\n").slice(-12).join("\n") };
    if (r.code !== 0) problems.push(`the test command exited ${r.code}:\n${ran.lastLines}`);
  }
  const result = { truth: `${remote}/${truth}`, commit: head, secondRemote: bare, restoredClone: clone, records, test: ran ?? "none (no drill.test on the truth branch's locker.json and no command given)" };
  if (problems.length) throw new LockerError("DRILL_FAILED", `restore drill failed: ${problems.join("; ")}\n(folders kept under ${root})`, { ...result, problems });
  if (!keep) { await rm(dir ? bare : root, { recursive: true, force: true }); if (dir) await rm(clone, { recursive: true, force: true }); result.secondRemote = result.restoredClone = `removed from ${root} (pass --keep to keep them)`; }
  return { drilled: true, ...result };
}
