// Sim Locker core: the four states, the rules, and the records. Pure functions over a repo path; the CLI and the MCP server are thin
// shells around these. Every function returns plain JSON. A refusal is a thrown LockerError with a stable code and the reason.
import { readFile, writeFile, mkdir, readdir, stat, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { git, revParse, currentBranch, isClean, changedFiles, blobAt, topLevel, range, aheadBehind, lastFetchAge } from "./git.js";

export class LockerError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}

const CONFIG = "locker.json";
const LEASE_REF = "refs/locker/lease";
const CONFIRM_TTL_MS = 10 * 60 * 1000;
const REGISTRY = join(homedir(), ".simlocker", "clones.json");

// ---------- the folder, the config, the actor ----------

/** Resolve a repo: it must be a git work tree with a locker.json at its top. Anything else is UNMANAGED. */
export async function openRepo(cwd = process.cwd()) {
  const top = await topLevel(cwd);
  if (!top) throw new LockerError("UNMANAGED", `${cwd} is not inside a git work tree. Sim Locker refuses to work in a plain folder; clone the project instead (sl clone <url>).`);
  let config;
  try { config = JSON.parse(await readFile(join(top, CONFIG), "utf8")); }
  catch (e) { throw new LockerError("UNMANAGED", `${top} has a .git but no readable ${CONFIG}. Run sl init here if this folder is meant to be managed.`, { cause: String(e) }); }
  for (const key of ["project", "truth", "remote", "actors"]) if (!(key in config)) throw new LockerError("CONFIG", `${CONFIG} lacks "${key}"`);
  const remoteUrl = await git(top, ["remote", "get-url", config.remote], { allowFail: true });
  if (remoteUrl === null) throw new LockerError("UNMANAGED", `remote "${config.remote}" is not configured in ${top}`);
  config.fetch = { maxAgeSeconds: 300, ...(config.fetch ?? {}) };
  config.lease = { ttlMinutes: 30, ...(config.lease ?? {}) };
  config.live = config.live ?? { kind: "none" };
  config.confirm = config.confirm ?? ["accept", "revert"];
  return { top, config, remoteUrl };
}

/** The actor is stamped by the tool from SL_ACTOR, never taken from a payload. */
export function actorFromEnv(config, env = process.env) {
  const name = env.SL_ACTOR;
  if (!name) throw new LockerError("NO_ACTOR", `SL_ACTOR is not set. Set it to one of: ${Object.keys(config.actors).join(", ")}`);
  const kind = config.actors[name];
  if (!kind) throw new LockerError("NO_ACTOR", `SL_ACTOR="${name}" is not an actor in ${CONFIG} (${Object.keys(config.actors).join(", ")})`);
  const session = env.SL_SESSION || (globalThis.__slSession ??= randomBytes(6).toString("hex"));
  return { name, kind, session };
}

const ident = (actor) => ["-c", `user.name=${actor.name}`, "-c", `user.email=${actor.name}@simlocker.local`];
const trailers = (fields) => Object.entries(fields).map(([k, v]) => `Locker-${k}: ${v}`).join("\n");

// ---------- fetching and staleness ----------

/** Fetch the truth branch and the lease ref if the last fetch is older than allowed. Says plainly when it did not fetch. */
export async function freshen(repo, { force = false } = {}) {
  const age = await lastFetchAge(repo.top);
  const due = force || age === null || age > repo.config.fetch.maxAgeSeconds;
  if (!due) return { fetched: false, reason: `last fetch ${Math.round(age)} s ago, within ${repo.config.fetch.maxAgeSeconds} s`, ageSeconds: Math.round(age) };
  const r = repo.config.remote;
  const out = await git(repo.top, ["fetch", "--quiet", r, `+refs/heads/*:refs/remotes/${r}/*`, `+${LEASE_REF}:${LEASE_REF}`], { allowFail: true });
  if (out === null) {
    // the lease ref may simply not exist yet; retry without it before calling the fetch failed
    const again = await git(repo.top, ["fetch", "--quiet", r, `+refs/heads/*:refs/remotes/${r}/*`], { allowFail: true });
    if (again === null) return { fetched: false, reason: "fetch failed (offline, or the remote refused)", ageSeconds: age === null ? null : Math.round(age) };
  }
  return { fetched: true, ageSeconds: 0 };
}

async function truthState(repo) {
  const { truth, remote } = repo.config;
  const local = await revParse(repo.top, truth), remoteRef = await revParse(repo.top, `${remote}/${truth}`);
  const ab = local && remoteRef ? await aheadBehind(repo.top, truth, `${remote}/${truth}`) : { ahead: null, behind: null };
  return { local, remote: remoteRef, ...ab, stale: ab.behind !== null && ab.behind > 0 };
}

// ---------- clone registry (two clones of one project on one machine is an error) ----------

async function readRegistry() { try { return JSON.parse(await readFile(REGISTRY, "utf8")); } catch { return {}; } }
export async function registerClone(repo) {
  const reg = await readRegistry();
  const list = new Set(reg[repo.remoteUrl] ?? []); list.add(repo.top);
  reg[repo.remoteUrl] = [...list];
  await mkdir(join(homedir(), ".simlocker"), { recursive: true });
  await writeFile(REGISTRY, JSON.stringify(reg, null, 1));
}
async function otherClones(repo) {
  const reg = await readRegistry(); const out = [];
  for (const p of reg[repo.remoteUrl] ?? []) if (resolve(p) !== resolve(repo.top)) { try { await stat(join(p, ".git")); out.push(p); } catch { /* gone */ } }
  return out;
}

// ---------- lease: one writer on the truth branch, a TTL, compare-and-swap through git ----------

async function readLease(repo) {
  const sha = await revParse(repo.top, LEASE_REF); if (!sha) return { sha: null, lease: null };
  const text = await git(repo.top, ["show", `${sha}:lease.json`], { allowFail: true });
  if (text === null) return { sha, lease: null };
  const lease = JSON.parse(text);
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
  await freshen(repo, { force: true });
  const { sha, lease: cur } = await readLease(repo);
  const mine = cur && cur.owner === actor.name && cur.session === actor.session;
  if (action === "status") return { lease: cur };
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

/** A review record: the exact range, the reviewer, the findings, and the blob hash of every file it cites, so status can see it go stale. */
export async function review(repo, actor, { from, to, findings, verdict }) {
  const toSha = await revParse(repo.top, to), fromRef = await revParse(repo.top, from);
  if (!toSha || !fromRef) throw new LockerError("BAD_RANGE", `cannot resolve ${from}..${to}`);
  // "main..slice" means the slice's own commits, so the range starts at the merge base, not at wherever main is today
  const fromSha = await git(repo.top, ["merge-base", fromRef, toSha]);
  if (!["pass", "fix", "block"].includes(verdict)) throw new LockerError("BAD_VERDICT", `verdict must be pass, fix or block, got "${verdict}"`);
  const files = (await git(repo.top, ["diff", "--name-only", `${fromSha}..${toSha}`])).split("\n").filter(Boolean);
  const cited = {}; for (const f of files) cited[f] = await blobAt(repo.top, toSha, f);
  const id = `rev_${createHash("sha256").update(`${fromSha}${toSha}${actor.name}${Date.now()}${randomBytes(4).toString("hex")}`).digest("hex").slice(0, 12)}`;
  const rec = { id, kind: "review", range: { from: fromSha, to: toSha }, reviewer: actor.name, reviewerKind: actor.kind, session: actor.session, verdict, findings, cited, created: new Date().toISOString() };
  await mkdir(recordsDir(repo, "reviews"), { recursive: true });
  const path = join(recordsDir(repo, "reviews"), `${id}.json`);
  await writeFile(path, JSON.stringify(rec, null, 1) + "\n");
  return { id, path: relative(repo.top, path), record: rec };
}

async function staleReviews(repo) {
  const out = [];
  for (const r of await listRecords(repo, "reviews")) {
    if (r.unreadable || !r.cited) continue;
    const moved = [];
    for (const [f, blob] of Object.entries(r.cited)) { const now = await blobAt(repo.top, "HEAD", f); if (now !== blob) moved.push(f); }
    if (moved.length) out.push({ id: r.id, moved });
  }
  return out;
}

// ---------- confirm tokens: two steps for anything long or destructive ----------

async function confirmPath(repo) { const d = await git(repo.top, ["rev-parse", "--git-dir"]); return join(resolve(repo.top, d), "locker-confirm.json"); }
async function requireConfirm(repo, op, args, given) {
  if (!repo.config.confirm.includes(op)) return null;
  const file = await confirmPath(repo);
  let table = {}; try { table = JSON.parse(await readFile(file, "utf8")); } catch { /* none yet */ }
  const key = createHash("sha256").update(JSON.stringify({ op, args })).digest("hex").slice(0, 16);
  const now = Date.now();
  for (const [t, v] of Object.entries(table)) if (now - v.created > CONFIRM_TTL_MS) delete table[t];
  if (given) {
    const hit = table[given];
    if (!hit || hit.key !== key) throw new LockerError("BAD_CONFIRM", "that confirm token does not match this operation, or it expired (10 minutes). Run the command again without --confirm to get a new one.");
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
  // accepted: the truth branch has a commit carrying this branch's name and head as trailers
  const log = await git(repo.top, ["log", "--format=%H%x00%(trailers:key=Locker-Slice,valueonly)%x00%(trailers:key=Locker-Range-Head,valueonly)%x1e", `-n`, "200", truth], { allowFail: true });
  let accepted = null;
  for (const line of (log ?? "").split("\x1e")) { const [sha, slice, rangeHead] = line.split("\0"); if ((slice?.trim() === branch || `done/${slice?.trim()}` === branch) && rangeHead?.trim() === head) { accepted = sha; break; } }
  const live = await liveState(repo);
  return { branch, head, saved: !!head, backedUp, remoteHead, accepted, live };
}

async function liveState(repo) {
  const cfg = repo.config.live;
  if (cfg.kind === "none") return { kind: "none", applies: false };
  const recs = await listRecords(repo, "live");
  const last = recs.filter((r) => !r.unreadable).at(-1) ?? null;
  return { kind: cfg.kind, applies: true, commit: last?.commit ?? null, setBy: last?.actor ?? null, at: last?.created ?? null, target: cfg.url ?? cfg.path ?? null };
}

export async function setLive(repo, actor, commit) {
  if (repo.config.live.kind === "none") throw new LockerError("NO_LIVE", `${repo.config.project} declares live: none; nothing to set`);
  const sha = await revParse(repo.top, commit); if (!sha) throw new LockerError("BAD_COMMIT", `cannot resolve ${commit}`);
  await mkdir(recordsDir(repo, "live"), { recursive: true });
  const rec = { kind: "live", commit: sha, actor: actor.name, session: actor.session, created: new Date().toISOString() };
  const path = join(recordsDir(repo, "live"), `${rec.created.replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify(rec, null, 1) + "\n");
  return { path: relative(repo.top, path), record: rec };
}

/** The truth about where this folder stands. Problems first. */
export async function status(repo, { fetch = true } = {}) {
  const problems = [];
  const freshness = fetch ? await freshen(repo) : { fetched: false, reason: "fetch skipped by request" };
  if (!freshness.fetched && (freshness.ageSeconds === null || freshness.ageSeconds > repo.config.fetch.maxAgeSeconds)) problems.push(`NOT FETCHED: ${freshness.reason}; ahead/behind below may be out of date`);
  const truth = await truthState(repo);
  if (truth.stale) problems.push(`STALE: ${repo.config.truth} is ${truth.behind} commit(s) behind ${repo.config.remote}/${repo.config.truth}; pull before saving or accepting`);
  if (!truth.remote) problems.push(`NO REMOTE TRUTH: ${repo.config.remote}/${repo.config.truth} does not exist; nothing has ever been backed up`);
  const others = await otherClones(repo);
  if (others.length) problems.push(`TWO CLONES: this project is also cloned at ${others.join(", ")}; one machine, one clone`);
  const { lease: cur } = await readLease(repo);
  if (cur?.owner && !cur.expired) problems.push(`LEASE HELD BY ${cur.owner} (${cur.kind}, session ${cur.session}) until ${cur.expires}`);
  const stale = await staleReviews(repo);
  for (const s of stale) problems.push(`STALE REVIEW ${s.id}: ${s.moved.length} cited file(s) changed since: ${s.moved.slice(0, 5).join(", ")}${s.moved.length > 5 ? ", ..." : ""}`);
  const branch = await currentBranch(repo.top);
  const dirty = await changedFiles(repo.top);
  const slice = await sliceState(repo, branch);
  const ab = await aheadBehind(repo.top, branch, `${repo.config.remote}/${branch}`);
  return { project: repo.config.project, path: repo.top, remote: repo.remoteUrl, freshness, problems, truth: { branch: repo.config.truth, ...truth }, current: { ...slice, onTruth: branch === repo.config.truth, ahead: ab.ahead, behind: ab.behind, uncommitted: dirty }, lease: cur ?? null, reviews: (await listRecords(repo, "reviews")).map((r) => ({ id: r.id, verdict: r.verdict, reviewer: r.reviewer, to: r.range?.to })) };
}

/** saved: commit the work on the current slice branch, stamped with the actor. Refuses a stale folder, and refuses agents on the truth branch. */
export async function save(repo, actor, { message, paths = [], slice } = {}) {
  if (!message) throw new LockerError("NO_MESSAGE", "save needs a message that says what changed and why");
  const truth = await truthState(repo);
  if (truth.stale) throw new LockerError("STALE", `${repo.config.truth} is ${truth.behind} commit(s) behind the remote; pull first (sl pull)`);
  let branch = await currentBranch(repo.top);
  if (slice && slice !== branch) {
    const exists = await revParse(repo.top, slice);
    await git(repo.top, exists ? ["checkout", "--quiet", slice] : ["checkout", "--quiet", "-b", slice, repo.config.truth]);
    branch = slice;
  }
  if (branch === repo.config.truth && actor.kind !== "human") throw new LockerError("AGENT_ON_TRUTH", `an agent does not save on ${repo.config.truth}; save on a slice branch (sl save --slice <name>) and accept it after a review`);
  await git(repo.top, ["add", "-A", "--", ...(paths.length ? paths : ["."])]);
  if (await isClean(repo.top)) return { saved: false, reason: "nothing to save", branch, head: await revParse(repo.top, "HEAD") };
  const body = `${message}\n\n${trailers({ Actor: `${actor.name} (${actor.kind})`, Session: actor.session })}\n`;
  await git(repo.top, [...ident(actor), "commit", "--quiet", "-F", "-"], { input: body });
  const head = await revParse(repo.top, "HEAD");
  const files = (await git(repo.top, ["show", "--name-only", "--format=", head])).split("\n").filter(Boolean);
  return { saved: true, branch, head, actor: actor.name, files };
}

/** backed up: push the current branch and prove it arrived by fetching and comparing refs. The push exit code alone is not evidence. */
export async function backup(repo) {
  const branch = await currentBranch(repo.top), head = await revParse(repo.top, "HEAD");
  if (!(await isClean(repo.top))) throw new LockerError("DIRTY", "uncommitted changes; save first, then back up");
  const pushed = await git(repo.top, ["push", "--quiet", repo.config.remote, `${branch}:refs/heads/${branch}`], { allowFail: true });
  if (pushed === null) throw new LockerError("PUSH_REFUSED", `the remote refused the push of ${branch} (it has commits you do not have, or you are offline). Sim Locker never forces; pull, then try again`);
  await freshen(repo, { force: true });
  const remoteHead = await revParse(repo.top, `${repo.config.remote}/${branch}`);
  if (remoteHead !== head) throw new LockerError("NOT_BACKED_UP", `after the push the remote ${branch} is ${remoteHead}, not ${head}`);
  return { backedUp: true, branch, head, remote: repo.remoteUrl };
}

/** Bring the truth branch up to date, fast-forward only. */
export async function pull(repo) {
  await freshen(repo, { force: true });
  const branch = await currentBranch(repo.top);
  if (branch !== repo.config.truth) {
    await git(repo.top, ["fetch", "--quiet", repo.config.remote, `${repo.config.truth}:${repo.config.truth}`], { allowFail: true });
  } else {
    const out = await git(repo.top, ["merge", "--ff-only", "--quiet", `${repo.config.remote}/${repo.config.truth}`], { allowFail: true });
    if (out === null) throw new LockerError("DIVERGED", `${repo.config.truth} has local commits the remote does not; this needs a person to look`);
  }
  return { truth: await truthState(repo) };
}

/** accepted: squash-merge a reviewed slice onto the truth branch, under the lease, in two steps. */
export async function accept(repo, actor, { slice, reviewId, message, confirm }) {
  const { truth, remote } = repo.config;
  if (!slice) throw new LockerError("NO_SLICE", "accept needs the slice branch name");
  await freshen(repo, { force: true });
  const t = await truthState(repo);
  if (t.stale) throw new LockerError("STALE", `${truth} is behind the remote; pull first`);
  if (!(await isClean(repo.top))) throw new LockerError("DIRTY", "uncommitted changes; save or discard them before accepting");
  if (!(await holdsLease(repo, actor))) throw new LockerError("NO_LEASE", `accepting needs the lease on ${truth}; run sl lease acquire`);
  const head = await revParse(repo.top, slice); if (!head) throw new LockerError("NO_SLICE", `no branch ${slice}`);
  const base = await git(repo.top, ["merge-base", truth, slice]);
  const reviews = (await listRecords(repo, "reviews")).filter((r) => r.id === reviewId);
  if (!reviews.length) throw new LockerError("NO_REVIEW", `no review record ${reviewId}; write one with sl review ${base.slice(0, 7)}..${slice}`);
  const r = reviews[0];
  if (r.range.to !== head) {
    // the review record itself is committed after the review, so commits after range.to may touch only locker/reviews/
    const ancestor = await git(repo.top, ["merge-base", "--is-ancestor", r.range.to, head], { allowFail: true });
    if (ancestor === null) throw new LockerError("REVIEW_STALE", `review ${reviewId} covers ${r.range.to.slice(0, 7)}, which is not in the history of ${slice}`);
    const since = (await git(repo.top, ["diff", "--name-only", `${r.range.to}..${head}`])).split("\n").filter(Boolean);
    const outside = since.filter((f) => !f.startsWith("locker/reviews/"));
    if (outside.length) throw new LockerError("REVIEW_STALE", `review ${reviewId} covers up to ${r.range.to.slice(0, 7)} but ${slice} is now at ${head.slice(0, 7)} and changed ${outside.slice(0, 5).join(", ")}; review the new commits`);
  }
  if (r.range.from !== base) throw new LockerError("REVIEW_RANGE", `review ${reviewId} starts at ${r.range.from.slice(0, 7)} but the merge base is ${base.slice(0, 7)}`);
  if (r.verdict === "block") throw new LockerError("REVIEW_BLOCKS", `review ${reviewId} says block: ${String(r.findings).slice(0, 200)}`);
  const commits = await range(repo.top, base, head);
  const pending = await requireConfirm(repo, "accept", { slice, head, reviewId }, confirm);
  if (pending) return { ...pending, slice, head, commits: commits.length, review: reviewId };
  const was = await currentBranch(repo.top);
  await git(repo.top, ["checkout", "--quiet", truth]);
  try {
    await git(repo.top, [...ident(actor), "merge", "--squash", "--quiet", slice]);
    const body = `${message ?? `accept ${slice}`}\n\n${trailers({ Slice: slice, "Range-Head": head, "Range-Base": base, Review: reviewId, Actor: `${actor.name} (${actor.kind})`, Session: actor.session })}\n`;
    await git(repo.top, [...ident(actor), "commit", "--quiet", "-F", "-"], { input: body });
    const merge = await revParse(repo.top, "HEAD");
    const pushed = await git(repo.top, ["push", "--quiet", remote, `${truth}:refs/heads/${truth}`], { allowFail: true });
    if (pushed === null) { await git(repo.top, ["reset", "--quiet", "--hard", `${remote}/${truth}`]); throw new LockerError("PUSH_REFUSED", `the remote moved under us; the local merge was undone. Pull and try again`); }
    await freshen(repo, { force: true });
    if ((await revParse(repo.top, `${remote}/${truth}`)) !== merge) throw new LockerError("NOT_BACKED_UP", "the merge commit did not arrive on the remote");
    await git(repo.top, ["branch", "-m", slice, `done/${slice}`]);
    await git(repo.top, ["push", "--quiet", remote, `done/${slice}:refs/heads/done/${slice}`], { allowFail: true });
    return { accepted: true, merge, slice, keptAs: `done/${slice}`, commits: commits.length, review: reviewId };
  } finally {
    if (was !== slice && was !== truth) await git(repo.top, ["checkout", "--quiet", was], { allowFail: true });
  }
}

/** A way down: a new commit that undoes an accepted one. History is never rewritten. */
export async function revert(repo, actor, { commit, confirm }) {
  const sha = await revParse(repo.top, commit); if (!sha) throw new LockerError("BAD_COMMIT", `cannot resolve ${commit}`);
  const pending = await requireConfirm(repo, "revert", { sha }, confirm);
  if (pending) return { ...pending, commit: sha };
  const out = await git(repo.top, [...ident(actor), "revert", "--no-edit", sha], { allowFail: true });
  if (out === null) { await git(repo.top, ["revert", "--abort"], { allowFail: true }); throw new LockerError("REVERT_CONFLICT", "the revert does not apply cleanly; this needs a person"); }
  return { reverted: sha, head: await revParse(repo.top, "HEAD"), branch: await currentBranch(repo.top) };
}

/** Make a folder managed: write locker.json, the merge driver, and register the clone. */
export async function init(cwd, { project, truth = "main", remote = "origin", actors, live }) {
  const top = await topLevel(cwd); if (!top) throw new LockerError("UNMANAGED", `${cwd} is not a git work tree; clone first`);
  const url = await git(top, ["remote", "get-url", remote], { allowFail: true });
  if (url === null) throw new LockerError("CONFIG", `remote "${remote}" is not set; add it first (git remote add ${remote} <url>)`);
  const config = { project: project ?? top.split(/[\\/]/).pop(), truth, remote, actors: actors ?? { rick: "human", claude: "agent", astra: "agent", percept: "model" }, lease: { ttlMinutes: 30 }, fetch: { maxAgeSeconds: 300 }, live: live ?? { kind: "none" }, confirm: ["accept", "revert"] };
  await writeFile(join(top, CONFIG), JSON.stringify(config, null, 2) + "\n");
  let attrs = ""; try { attrs = await readFile(join(top, ".gitattributes"), "utf8"); } catch { /* none */ }
  if (!attrs.includes("merge=locker-record")) await writeFile(join(top, ".gitattributes"), attrs + (attrs && !attrs.endsWith("\n") ? "\n" : "") + "*.record.json merge=locker-record\nlocker/**/*.json merge=locker-record\n");
  await git(top, ["config", "merge.locker-record.name", "Sim Locker record merge (per top-level key)"]);
  await git(top, ["config", "merge.locker-record.driver", "sl merge-record %O %A %B %P"]);
  const repo = await openRepo(top); await registerClone(repo);
  return { top, config };
}

/** Find records whose text matches. */
export async function find(repo, query) {
  const q = query.toLowerCase(); const hits = [];
  for (const kind of ["reviews", "live"]) for (const r of await listRecords(repo, kind)) if (JSON.stringify(r).toLowerCase().includes(q)) hits.push({ kind, id: r.id ?? r.path, path: r.path, verdict: r.verdict, created: r.created });
  return { query, hits };
}
