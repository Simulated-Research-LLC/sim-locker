// End to end against real git: a bare remote standing in for GitHub, two clones standing in for two machines or two sessions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

let tmp, remote, A, B, L, G;
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const env = (actor, session) => ({ SL_ACTOR: actor, SL_SESSION: session });
const rejects = async (p, code) => { try { await p; } catch (e) { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return e; } assert.fail(`expected ${code}, nothing was thrown`); };

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "simlocker-"));
  process.env.HOME = join(tmp, "home"); await mkdir(process.env.HOME);   // the clone registry lives under HOME
  L = await import("../src/locker.js"); G = await import("../src/git.js");
  remote = join(tmp, "remote.git"); sh(tmp, "init", "--bare", "--quiet", "-b", "main", remote);
  A = join(tmp, "A"); sh(tmp, "clone", "--quiet", remote, A);
  sh(A, "checkout", "--quiet", "-b", "main");
  await writeFile(join(A, "README.md"), "# demo\n");
  sh(A, "add", "-A"); sh(A, "commit", "--quiet", "-m", "first");
  sh(A, "push", "--quiet", "-u", "origin", "main");
});
after(async () => { await rm(tmp, { recursive: true, force: true }); });

test("a plain folder and an unmanaged clone are refused", async () => {
  const plain = join(tmp, "plain"); await mkdir(plain);
  await rejects(L.openRepo(plain), "UNMANAGED");
  await rejects(L.openRepo(A), "UNMANAGED");
});

test("init makes the clone managed and a human can save and back up on the truth branch", async () => {
  const r = await L.init(A, { project: "demo" });
  assert.equal(r.config.truth, "main");
  const repo = await L.openRepo(A);
  const rick = L.actorFromEnv(repo.config, env("rick", "s1"));
  assert.equal(rick.kind, "human");
  assert.throws(() => L.actorFromEnv(repo.config, {}), (e) => e.code === "NO_ACTOR");
  assert.throws(() => L.actorFromEnv(repo.config, env("mallory", "x")), (e) => e.code === "NO_ACTOR");
  const s = await L.save(repo, rick, { message: "manage with sim locker" });
  assert.equal(s.saved, true); assert.ok(s.files.includes("locker.json"));
  const body = sh(A, "log", "-1", "--format=%B");
  assert.match(body, /Locker-Actor: rick \(human\)/); assert.match(body, /Locker-Session: s1/);
  const b = await L.backup(repo);
  assert.equal(b.backedUp, true); assert.equal(sh(A, "rev-parse", "origin/main"), b.head);
  const st = await L.status(repo);
  assert.deepEqual(st.problems, []); assert.equal(st.current.backedUp, true); assert.equal(st.current.onTruth, true);
});

test("an agent cannot save on the truth branch; on a slice it can, and the status shows the states", async () => {
  const repo = await L.openRepo(A);
  const claude = L.actorFromEnv(repo.config, env("claude", "c1"));
  await writeFile(join(A, "game.js"), "export const v = 1;\n");
  await rejects(L.save(repo, claude, { message: "bump" }), "AGENT_ON_TRUTH");
  const s = await L.save(repo, claude, { message: "bump v", slice: "slice/bump" });
  assert.equal(s.branch, "slice/bump"); assert.equal(sh(A, "rev-parse", "--abbrev-ref", "HEAD"), "slice/bump");
  let st = await L.status(repo);
  assert.equal(st.current.saved, true); assert.equal(st.current.backedUp, false); assert.equal(st.current.accepted, null);
  await L.backup(repo);
  st = await L.status(repo);
  assert.equal(st.current.backedUp, true);
  assert.equal((await L.save(repo, claude, { message: "nothing" })).saved, false);
});

test("a second clone is reported, and a truth branch that moved makes the first clone STALE until it pulls", async () => {
  B = join(tmp, "B"); sh(tmp, "clone", "--quiet", remote, B);
  const repoB = await L.openRepo(B); await L.registerClone(repoB);
  const repoA = await L.openRepo(A);
  let st = await L.status(repoA);
  assert.ok(st.problems.some((p) => p.startsWith("TWO CLONES")), st.problems.join("|"));
  await writeFile(join(B, "notes.md"), "from B\n"); sh(B, "add", "-A"); sh(B, "commit", "--quiet", "-m", "B moves main"); sh(B, "push", "--quiet", "origin", "main");
  st = await L.status(repoA, { fetch: true });
  // status fetched within maxAge? force a fresh look
  await L.freshen(repoA, { force: true }); st = await L.status(repoA);
  assert.ok(st.problems.some((p) => p.startsWith("STALE")), st.problems.join("|"));
  const claude = L.actorFromEnv(repoA.config, env("claude", "c1"));
  await writeFile(join(A, "game.js"), "export const v = 2;\n");
  await rejects(L.save(repoA, claude, { message: "while stale" }), "STALE");
  await L.pull(repoA);
  st = await L.status(repoA);
  assert.ok(!st.problems.some((p) => p.startsWith("STALE")));
  assert.equal(sh(A, "rev-parse", "main"), sh(A, "rev-parse", "origin/main"));
  await L.save(repoA, claude, { message: "v2" });
  await rm(join(tmp, "B"), { recursive: true });                            // B is gone; the registry entry must not count
  st = await L.status(repoA); assert.ok(!st.problems.some((p) => p.startsWith("TWO CLONES")));
});

test("the lease: one holder, no release by others, taken when expired", async () => {
  const repo = await L.openRepo(A);
  const claude = L.actorFromEnv(repo.config, env("claude", "c1"));
  const astra = L.actorFromEnv(repo.config, env("astra", "a1"));
  const got = await L.lease(repo, claude, "acquire");
  assert.equal(got.action, "acquired"); assert.equal(got.lease.owner, "claude");
  assert.equal(sh(A, "rev-parse", "refs/locker/lease"), sh(A, "--git-dir", remote, "rev-parse", "refs/locker/lease"));
  await rejects(L.lease(repo, astra, "acquire"), "LEASE_HELD");
  await rejects(L.lease(repo, astra, "release"), "LEASE_HELD");
  await rejects(L.lease(repo, astra, "renew"), "LEASE_HELD");
  assert.equal((await L.lease(repo, claude, "renew")).action, "renewed");
  const st = await L.status(repo); assert.ok(st.problems.some((p) => p.startsWith("LEASE HELD BY claude")));
  const short = { ...repo, config: { ...repo.config, lease: { ttlMinutes: 0 } } };
  await L.lease(short, claude, "acquire");
  assert.equal((await L.lease(repo, astra, "acquire")).action, "acquired");
  assert.equal((await L.lease(repo, astra, "release")).released, true);
  assert.equal((await L.lease(repo, claude, "status")).lease.owner, null);
});

test("accept needs the lease, a review of the exact range, and a confirm token; then the truth branch moves and the slice is kept", async () => {
  const repo = await L.openRepo(A);
  const claude = L.actorFromEnv(repo.config, env("claude", "c1"));
  const astra = L.actorFromEnv(repo.config, env("astra", "a1"));
  await L.backup(repo);
  await rejects(L.accept(repo, claude, { slice: "slice/bump", reviewId: "rev_none" }), "NO_LEASE");
  await L.lease(repo, claude, "acquire");
  await rejects(L.accept(repo, claude, { slice: "slice/bump", reviewId: "rev_none" }), "NO_REVIEW");
  await rejects(L.review(repo, astra, { from: "main", to: "slice/bump", verdict: "maybe", findings: "" }), "BAD_VERDICT");
  // a review of an older head goes stale when the slice gains a real commit
  const old = await L.review(repo, astra, { from: "main", to: "slice/bump", verdict: "pass", findings: "v goes 1 to 2" });
  assert.equal(old.record.cited["game.js"], sh(A, "rev-parse", "slice/bump:game.js"));
  await writeFile(join(A, "game.js"), "export const v = 3;\n");
  await L.save(repo, claude, { message: "v3" });                    // commits game.js and the review record
  let st = await L.status(repo); assert.ok(st.problems.some((p) => p.startsWith("STALE REVIEW " + old.id)), st.problems.join("|"));
  await rejects(L.accept(repo, claude, { slice: "slice/bump", reviewId: old.id }), "REVIEW_STALE");
  // a blocking review blocks
  const block = await L.review(repo, astra, { from: "main", to: "slice/bump", verdict: "block", findings: "v3 breaks the build" });
  await L.save(repo, claude, { message: "review: block" });
  await rejects(L.accept(repo, claude, { slice: "slice/bump", reviewId: block.id }), "REVIEW_BLOCKS");
  // the real protocol: review the head, save the record (only locker/reviews/ changes after the reviewed head), accept in two steps
  const rv = await L.review(repo, astra, { from: "main", to: "slice/bump", verdict: "pass", findings: "v3 is fine" });
  const reviewedHead = sh(A, "rev-parse", "slice/bump");
  await L.save(repo, claude, { message: "review: pass" });
  assert.notEqual(sh(A, "rev-parse", "slice/bump"), reviewedHead);
  await rejects(L.accept(repo, claude, { slice: "slice/bump", reviewId: rv.id, confirm: "deadbeef" }), "BAD_CONFIRM");
  const first = await L.accept(repo, claude, { slice: "slice/bump", reviewId: rv.id });
  assert.equal(first.confirmRequired, true); assert.match(first.token, /^[0-9a-f]{8}$/);
  assert.equal(sh(A, "rev-parse", "main"), sh(A, "rev-parse", "origin/main"), "the first step changed nothing");
  const done = await L.accept(repo, claude, { slice: "slice/bump", reviewId: rv.id, confirm: first.token, message: "0.0.2: v is 3" });
  assert.equal(done.accepted, true); assert.equal(done.keptAs, "done/slice/bump");
  assert.equal(sh(A, "rev-parse", "main"), done.merge); assert.equal(sh(A, "--git-dir", remote, "rev-parse", "main"), done.merge);
  const body = sh(A, "log", "-1", "--format=%B", "main");
  assert.match(body, /Locker-Slice: slice\/bump/); assert.match(body, new RegExp("Locker-Review: " + rv.id));
  assert.equal(sh(A, "show", "main:game.js"), "export const v = 3;");
  assert.throws(() => sh(A, "rev-parse", "--verify", "--quiet", "slice/bump"), "the slice branch is gone under its old name");
  assert.ok(sh(A, "rev-parse", "done/slice/bump"));
  await rejects(L.accept(repo, claude, { slice: "slice/bump", reviewId: rv.id, confirm: first.token }), "NO_SLICE");
  sh(A, "checkout", "--quiet", "done/slice/bump");
  st = await L.status(repo); assert.equal(st.current.accepted, done.merge);
  sh(A, "checkout", "--quiet", "main");
});

test("revert is two steps and adds a commit instead of rewriting", async () => {
  const repo = await L.openRepo(A);
  const rick = L.actorFromEnv(repo.config, env("rick", "s1"));
  const before = sh(A, "rev-parse", "main");
  const first = await L.revert(repo, rick, { commit: "main" });
  assert.equal(first.confirmRequired, true);
  const r = await L.revert(repo, rick, { commit: "main", confirm: first.token });
  assert.equal(r.reverted, before); assert.equal(sh(A, "rev-parse", "main^"), before);
  assert.throws(() => sh(A, "show", "main:game.js"), "game.js came with the accepted slice, so the revert removes it");
  assert.equal(sh(A, "show", "main:README.md"), "# demo");
});

test("a plain git clone with no Sim Locker has the whole project and its records", async () => {
  const P = join(tmp, "plain-clone"); sh(tmp, "clone", "--quiet", remote, P);
  const files = sh(P, "ls-files").split("\n");
  assert.ok(files.includes("locker.json")); assert.ok(files.some((f) => f.startsWith("locker/reviews/rev_")));
});
