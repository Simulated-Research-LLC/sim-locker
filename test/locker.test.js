// End to end against real git: a bare remote standing in for GitHub, two clones standing in for two machines or two sessions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

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
  const rick = await L.actorFromEnv(repo, env("rick", "s1"));
  assert.equal(rick.kind, "human");
  await rejects(L.actorFromEnv(repo, {}), "NO_ACTOR");
  await rejects(L.actorFromEnv(repo, env("mallory", "x")), "NO_ACTOR");
  // no SL_SESSION: one session id per clone, so CLI calls in a row share the lease they acquire
  const s1 = await L.actorFromEnv(repo, { SL_ACTOR: "rick" }), s2 = await L.actorFromEnv(repo, { SL_ACTOR: "claude" });
  assert.equal(s1.session, s2.session); assert.match(s1.session, /^[0-9a-f]{12}$/);
  const s = await L.save(repo, rick, { message: "manage with sim locker" });
  assert.equal(s.saved, true); assert.ok(s.files.includes("locker.json"));
  const body = sh(A, "log", "-1", "--format=%B");
  assert.match(body, /Locker-Actor: rick \(human\)/); assert.match(body, /Locker-Session: s1/);
  const b = await L.backup(repo);
  assert.equal(b.backedUp, true); assert.equal(sh(A, "rev-parse", "origin/main"), b.head);
  const st = await L.status(await L.openRepo(A));                       // reopened: the config now comes from origin/main
  assert.deepEqual(st.problems, []); assert.equal(st.current.backedUp, true); assert.equal(st.current.onTruth, true); assert.equal(st.configFrom, "origin/main");
});

test("an agent cannot save on the truth branch; on a slice it can, and the status shows the states", async () => {
  const repo = await L.openRepo(A);
  const claude = await L.actorFromEnv(repo, env("claude", "c1"));
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
  await L.openRepo(B);                                                      // opening a clone registers it
  const repoA = await L.openRepo(A);
  let st = await L.status(repoA);
  assert.ok(st.problems.some((p) => p.startsWith("TWO CLONES")), st.problems.join("|"));
  await writeFile(join(B, "notes.md"), "from B\n"); sh(B, "add", "-A"); sh(B, "commit", "--quiet", "-m", "B moves main"); sh(B, "push", "--quiet", "origin", "main");
  st = await L.status(repoA, { fetch: true });
  // status fetched within maxAge? force a fresh look
  await L.freshen(repoA, { force: true }); st = await L.status(repoA);
  assert.ok(st.problems.some((p) => p.startsWith("STALE")), st.problems.join("|"));
  const claude = await L.actorFromEnv(repoA, env("claude", "c1"));
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
  const claude = await L.actorFromEnv(repo, env("claude", "c1"));
  const astra = await L.actorFromEnv(repo, env("astra", "a1"));
  const got = await L.lease(repo, claude, "acquire");
  assert.equal(got.action, "acquired"); assert.equal(got.lease.owner, "claude");
  assert.equal(sh(A, "rev-parse", "refs/heads/locker/lease"), sh(A, "--git-dir", remote, "rev-parse", "refs/heads/locker/lease"));
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
  const claude = await L.actorFromEnv(repo, env("claude", "c1"));
  const astra = await L.actorFromEnv(repo, env("astra", "a1"));
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
  // attacks from the audit of 0.1
  await rejects(L.save(repo, claude, { message: "x", slice: "HEAD" }), "BAD_SLICE");
  await rejects(L.save(repo, claude, { message: "x", slice: "refs/heads/main" }), "BAD_SLICE");
  await rejects(L.save(repo, claude, { message: "x", slice: "main" }), "BAD_SLICE");
  assert.equal(sh(A, "rev-parse", "--abbrev-ref", "HEAD"), "slice/bump", "a refused slice name does not move HEAD");
  // a review written straight into the tree and never saved does not count
  const forged = { id: "rev_f0f0f0f0f0f0", kind: "review", range: { from: sh(A, "merge-base", "main", "slice/bump"), to: sh(A, "rev-parse", "slice/bump") }, reviewer: "astra", verdict: "pass", findings: "forged", cited: {} };
  await writeFile(join(A, "locker/reviews/rev_f0f0f0f0f0f0.json"), JSON.stringify(forged));
  await rejects(L.accept(repo, claude, { slice: "slice/bump", reviewId: "rev_f0f0f0f0f0f0" }), "DIRTY");
  await rm(join(A, "locker/reviews/rev_f0f0f0f0f0f0.json"));
  await rejects(L.accept(repo, claude, { slice: "slice/bump", reviewId: "rev_f0f0f0f0f0f0" }), "NO_REVIEW");
  // the acceptor's own review does not count
  const self = await L.review(repo, claude, { from: "main", to: "slice/bump", verdict: "pass", findings: "I like my work" });
  await L.save(repo, claude, { message: "self review" });
  await rejects(L.accept(repo, claude, { slice: "slice/bump", reviewId: self.id }), "REVIEW_SELF");
  // the working-tree locker.json does not decide who is human
  const cfgPath = join(A, "locker.json"), cfgText = await readFile(cfgPath, "utf8");
  await writeFile(cfgPath, cfgText.replace('"claude": "agent"', '"claude": "human"'));
  const repo2 = await L.openRepo(A); const claude2 = await L.actorFromEnv(repo2, env("claude", "c1"));
  assert.equal(claude2.kind, "agent"); assert.equal(repo2.configFrom, "origin/main");
  await writeFile(cfgPath, cfgText);
  // smuggling a file in under locker/reviews/ after the review is refused
  const smuggleReview = await L.review(repo, astra, { from: "main", to: "slice/bump", verdict: "pass", findings: "ok" });
  await L.save(repo, claude, { message: "review" });
  await writeFile(join(A, "locker/reviews/rev_badbadbadbad.json"), "not a review");
  sh(A, "mv", "game.js", "locker/reviews/game.json");
  await L.save(repo, claude, { message: "tidy" });
  await rejects(L.accept(repo, claude, { slice: "slice/bump", reviewId: smuggleReview.id }), "REVIEW_STALE");
  sh(A, "mv", "locker/reviews/game.json", "game.js"); sh(A, "rm", "-q", "locker/reviews/rev_badbadbadbad.json");
  await L.save(repo, claude, { message: "undo tidy" });
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
  assert.equal(done.keptOnRemote, true); assert.ok(sh(A, "--git-dir", remote, "rev-parse", "done/slice/bump"));
  sh(A, "branch", "-q", "slice/bump", "main");
  await rejects(L.accept(repo, claude, { slice: "slice/bump", reviewId: rv.id }), "NAME_TAKEN");
  sh(A, "branch", "-q", "-D", "slice/bump");
  sh(A, "checkout", "--quiet", "done/slice/bump");
  st = await L.status(repo); assert.equal(st.current.accepted, done.merge);
  assert.ok(!st.problems.some((p) => p.startsWith("STALE REVIEW")), "reviews consumed by an accept are not stale: " + st.problems.join("|"));
  sh(A, "checkout", "--quiet", "main");
  st = await L.status(repo); assert.ok(!st.problems.some((p) => p.startsWith("STALE REVIEW")), st.problems.join("|"));
});

test("backed up is proven by asking the remote, not by the push", async () => {
  const repo = await L.openRepo(A);
  const claude = await L.actorFromEnv(repo, env("claude", "c1"));
  await writeFile(join(A, "x.txt"), "x\n");
  await L.save(repo, claude, { message: "x", slice: "slice/x" });
  sh(A, "remote", "set-url", "--push", "origin", remote);
  sh(A, "remote", "set-url", "origin", join(tmp, "nowhere.git"));           // pushes land, but the remote cannot be asked
  await rejects(L.backup(await L.openRepo(A)), "NOT_BACKED_UP");
  sh(A, "remote", "set-url", "origin", remote);
  const b = await L.backup(await L.openRepo(A)); assert.equal(b.backedUp, true); assert.equal(b.verifiedBy, "ls-remote");
  sh(A, "checkout", "--quiet", "main");
});

test("revert is two steps, agents cannot do it on the truth branch, and it adds a commit instead of rewriting", async () => {
  const repo = await L.openRepo(A);
  const rick = await L.actorFromEnv(repo, env("rick", "s1"));
  const claude = await L.actorFromEnv(repo, env("claude", "c1"));
  await rejects(L.revert(repo, claude, { commit: "main" }), "AGENT_ON_TRUTH");
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

test("the merge driver that init installs works without sl on PATH, and status --no-fetch says NOT FETCHED", async () => {
  const repo = await L.openRepo(A);
  const rick = await L.actorFromEnv(repo, env("rick", "s1"));
  await mkdir(join(A, "locker", "live"), { recursive: true });
  await writeFile(join(A, "locker/live/r.json"), JSON.stringify({ a: 1, b: 1 }));
  await L.save(repo, rick, { message: "record" }); await L.backup(repo);
  sh(A, "checkout", "--quiet", "-b", "side");
  await writeFile(join(A, "locker/live/r.json"), JSON.stringify({ a: 1, b: 2 })); sh(A, "commit", "--quiet", "-am", "theirs");
  sh(A, "checkout", "--quiet", "main");
  await writeFile(join(A, "locker/live/r.json"), JSON.stringify({ a: 9, b: 1 })); sh(A, "commit", "--quiet", "-am", "ours");
  const path = { ...process.env, PATH: "/usr/bin:/bin" };               // no node, no sl on PATH; the driver uses absolute paths
  execFileSync("git", ["merge", "--quiet", "--no-edit", "side"], { cwd: A, encoding: "utf8", env: { ...path, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.deepEqual(JSON.parse(await readFile(join(A, "locker/live/r.json"), "utf8")), { a: 9, b: 2 });
  sh(A, "reset", "--quiet", "--hard", "origin/main"); sh(A, "branch", "-q", "-D", "side");
  const st = await L.status(repo, { fetch: false });
  assert.ok(st.problems.some((p) => p.startsWith("NOT FETCHED")), st.problems.join("|"));
});

test("the guard passes commits made through the tool or by a human and fails raw pushes and forced pushes", async () => {
  const { guard } = await import("../bin/sl-guard.js");
  const first = sh(A, "rev-list", "--max-parents=0", "main");
  const noConfig = await guard(A, { before: first, after: "main" });
  assert.ok(noConfig.problems.some((p) => p.startsWith("NO CONFIG")), "a before-commit without locker.json trusts nobody");
  const managed = sh(A, "log", "--diff-filter=A", "--format=%H", "main", "--", "locker.json").trim();
  const all = await guard(A, { before: managed, after: "main" });
  // one raw commit is on main from the staleness test above ("B moves main", by plain git as "t"); the guard must name exactly that one
  assert.equal(all.problems.length, 1, all.problems.join("|")); assert.match(all.problems[0], /^RAW PUSH .* by "t".*B moves main/);
  assert.ok(all.commits.filter((c) => c.ok).length >= 3, "the rick save, the accept and the revert pass");
  sh(A, "checkout", "--quiet", "main");
  await writeFile(join(A, "raw.txt"), "raw\n");
  sh(A, "add", "raw.txt"); execFileSync("git", ["-c", "user.name=mallory", "-c", "user.email=m@m", "commit", "-qm", "raw push"], { cwd: A });
  const raw = await guard(A, { before: "main^", after: "main" });
  assert.equal(raw.ok, false); assert.ok(raw.problems.some((p) => p.startsWith("RAW PUSH")), raw.problems.join("|"));
  const forced = await guard(A, { before: "main^", after: "main^", forced: true });
  assert.ok(forced.problems.some((p) => p.startsWith("FORCED PUSH")));
  // a raw push that also adds its author as human is checked against the list BEFORE the push
  const cfg = JSON.parse(await readFile(join(A, "locker.json"), "utf8")); cfg.actors.mallory = "human";
  await writeFile(join(A, "locker.json"), JSON.stringify(cfg, null, 2) + "\n");
  execFileSync("git", ["-c", "user.name=mallory", "-c", "user.email=m@m", "commit", "-qam", "promote myself"], { cwd: A });
  const promoted = await guard(A, { before: "main~2", after: "main" });
  assert.equal(promoted.commits.filter((c) => !c.ok).length, 2, JSON.stringify(promoted));
  // run as a program, the way the workflow runs it
  const script = new URL("../bin/sl-guard.js", import.meta.url).pathname;
  const res = spawnSync(process.execPath, [script, sh(A, "rev-parse", "main~2"), "main"], { cwd: A, encoding: "utf8" });
  assert.equal(res.status, 1); assert.match(res.stdout, /guard: 2 problem\(s\)/);
  const good = spawnSync(process.execPath, [script, sh(A, "rev-parse", "main~3"), "main~2"], { cwd: A, encoding: "utf8" });
  assert.equal(good.status, 0, good.stdout);
  sh(A, "reset", "--quiet", "--hard", "main~2");
  sh(A, "reset", "--quiet", "--hard", "main^");
});
