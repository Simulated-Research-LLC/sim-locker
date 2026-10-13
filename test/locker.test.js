// End to end against real git: a bare remote standing in for GitHub, two clones standing in for two machines or two sessions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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
  const claude = await L.actorFromEnv(repoA, env("claude", "c1")), rick = await L.actorFromEnv(repoA, env("rick", "r1"));
  sh(A, "checkout", "--quiet", "main");
  await rejects(L.save(repoA, rick, { message: "while stale, on main" }), "STALE");   // a save on the stale truth branch itself is refused
  await L.pull(repoA);
  st = await L.status(repoA);
  assert.ok(!st.problems.some((p) => p.startsWith("STALE")));
  assert.equal(sh(A, "rev-parse", "main"), sh(A, "rev-parse", "origin/main"));
  sh(A, "checkout", "--quiet", "slice/bump");
  await writeFile(join(A, "game.js"), "export const v = 2;\n");
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
  assert.ok(noConfig.notes.some((p) => p.startsWith("NO CONFIG")), "a before-commit without locker.json trusts no author, and says so without failing on its own");
  assert.ok(!noConfig.problems.some((p) => p.startsWith("NO CONFIG")));
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
  const script = fileURLToPath(new URL("../bin/sl-guard.js", import.meta.url));
  const res = spawnSync(process.execPath, [script, sh(A, "rev-parse", "main~2"), "main"], { cwd: A, encoding: "utf8" });
  assert.equal(res.status, 1); assert.match(res.stdout, /guard: 2 problem\(s\)/);
  const good = spawnSync(process.execPath, [script, sh(A, "rev-parse", "main~3"), "main~2"], { cwd: A, encoding: "utf8" });
  assert.equal(good.status, 0, good.stdout);
  sh(A, "reset", "--quiet", "--hard", "main~2");
});

test("accept.trailing lets a configured record file change after the review; accept.gate runs the project's own check on the exact commit", async () => {
  const repo = await L.openRepo(A);
  const claude = await L.actorFromEnv(repo, env("claude", "c1"));
  const astra = await L.actorFromEnv(repo, env("astra", "a1"));
  const rick = await L.actorFromEnv(repo, env("rick", "s1"));
  sh(A, "checkout", "--quiet", "main");
  const cfg = JSON.parse(await readFile(join(A, "locker.json"), "utf8"));
  cfg.accept = { gate: [process.execPath, "gate.js"], trailing: ["**/rows.md"], gateTimeoutSeconds: 20 };
  await writeFile(join(A, "locker.json"), JSON.stringify(cfg, null, 2) + "\n");
  // the gate passes only when the committed tree has feature.txt and no gate-block; it must never see the working tree
  await writeFile(join(A, "gate.js"), "const fs = require('fs'); const ok = fs.existsSync('feature.txt') && !fs.existsSync('gate-block'); console.log(ok ? 'gate: fine' : 'gate: NOT FINE'); process.exit(ok ? 0 : 3);\n");
  await mkdir(join(A, "ledger"), { recursive: true }); await writeFile(join(A, "ledger/rows.md"), "| v | outcome |\n");
  await L.save(repo, rick, { message: "gate and ledger" }); await L.backup(repo);
  // a trailing pattern that would cover locker/ is refused at load
  const bad = { ...cfg, accept: { ...cfg.accept, trailing: ["**"] } };
  await writeFile(join(A, "locker.json"), JSON.stringify(bad, null, 2) + "\n");
  await L.save(repo, rick, { message: "bad trailing" }); await L.backup(repo);
  await rejects(L.openRepo(A), "CONFIG");
  await L.revert(await L.openRepo(A).catch(() => repo), rick, { commit: "HEAD", confirm: (await L.revert(repo, rick, { commit: "HEAD" })).token });
  await L.backup(repo);
  const repo2 = await L.openRepo(A); assert.deepEqual(repo2.config.accept.trailing, ["**/rows.md"]);
  // the slice: a change plus a blocker, a review, then the ledger row after the review (allowed)
  await writeFile(join(A, "feature.txt"), "f\n"); await writeFile(join(A, "gate-block"), "");
  await L.save(repo2, claude, { message: "feature with a blocker", slice: "slice/gated" });
  const rv = await L.review(repo2, astra, { from: "main", to: "slice/gated", verdict: "pass", findings: "fine" });
  await writeFile(join(A, "ledger/rows.md"), "| v | outcome |\n| 1 | feature |\n");
  await L.save(repo2, claude, { message: "review and ledger row" });
  await L.backup(repo2); await L.lease(repo2, claude, "acquire");
  let first = await L.accept(repo2, claude, { slice: "slice/gated", reviewId: rv.id });
  assert.equal(first.confirmRequired, true); assert.match(first.gate, /gate\.js will run/);
  // the gate runs at the confirm step, on the committed tree: gate-block is in it, so it refuses with its own words
  const g = await rejects(L.accept(repo2, claude, { slice: "slice/gated", reviewId: rv.id, confirm: first.token }), "GATE_FAILED");
  assert.match(g.message, /NOT FINE/);
  assert.equal(sh(A, "rev-parse", "main"), sh(A, "rev-parse", "origin/main"), "a failed gate moves nothing");
  // committing the removal after the review is a code change, so the review is stale until a new one
  sh(A, "rm", "-q", "gate-block"); await L.save(repo2, claude, { message: "remove the blocker" });
  await rejects(L.accept(repo2, claude, { slice: "slice/gated", reviewId: rv.id }), "REVIEW_STALE");
  const rv2 = await L.review(repo2, astra, { from: "main", to: "slice/gated", verdict: "pass", findings: "fine now" });
  await L.save(repo2, claude, { message: "review 2" }); await L.backup(repo2);
  // a forged local origin/main with the gate switched off changes nothing: accept re-reads the config from the remote after its fetch
  const forged = { ...repo2.config, accept: { gate: null, trailing: ["**/rows.md"] } };
  const tmpCfg = join(tmp, "forged.json"); await writeFile(tmpCfg, JSON.stringify(forged));
  const fblob = execFileSync("git", ["hash-object", "-w", tmpCfg], { cwd: A, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["mktree"], { cwd: A, encoding: "utf8", input: `100644 blob ${fblob}\tlocker.json\n` }).trim();
  const fcommit = execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@f", "commit-tree", tree, "-p", sh(A, "rev-parse", "origin/main"), "-m", "forged"], { cwd: A, encoding: "utf8" }).trim();
  sh(A, "update-ref", "refs/remotes/origin/main", fcommit);
  const repo3 = await L.openRepo(A); assert.equal(repo3.config.accept.gate, null, "the forged tracking ref is what openRepo sees");
  await writeFile(join(A, "gate-block"), "");                                             // untracked and excluded, so the tree stays clean: the gate must not see it
  await writeFile(join(A, ".git/info/exclude"), "gate-block\n");
  first = await L.accept(repo3, claude, { slice: "slice/gated", reviewId: rv2.id });
  assert.match(first.gate ?? "", /gate\.js will run/, "the real config, fetched from the remote, still has the gate");
  const done = await L.accept(repo3, claude, { slice: "slice/gated", reviewId: rv2.id, confirm: first.token });
  assert.equal(done.accepted, true);
  assert.match(sh(A, "show", "main:ledger/rows.md"), /feature/);
  assert.throws(() => sh(A, "show", "main:gate-block"));
  await L.lease(repo3, claude, "release");
});

test("a gate that hangs is killed with everything it started, and protected files are never trailing whatever the pattern says", async () => {
  const repo = await L.openRepo(A);
  const claude = await L.actorFromEnv(repo, env("claude", "c1"));
  const astra = await L.actorFromEnv(repo, env("astra", "a1"));
  const rick = await L.actorFromEnv(repo, env("rick", "s1"));
  sh(A, "checkout", "--quiet", "main");
  const cfg = JSON.parse(await readFile(join(A, "locker.json"), "utf8"));
  for (const bad of ["locker/reviews/rev_a*.json", "locker/live/live.json", ".github/workflows/guard-main.yml", "bin/sl-guard.js", "*.json", "locker/*.record.json"])
    assert.throws(() => L.checkConfig({ ...cfg, accept: { trailing: [bad] } }), (e) => e.code === "CONFIG", bad);
  for (const bad of [0, 1.5, 1e9, "9"]) assert.throws(() => L.checkConfig({ ...cfg, accept: { gateTimeoutSeconds: bad } }), (e) => e.code === "CONFIG", String(bad));
  assert.equal(L.checkConfig({ ...cfg, accept: { trailing: ["**/rows.md", "vault/00 Start/Delivery ledger.md"] } }).accept.gateTimeoutSeconds, 900);
  // a pattern that passes the load check (it starts with a glob) but reaches a protected file: the file is still refused at accept
  cfg.accept = { gate: ["sh", "-c", "sleep 30; echo done"], gateTimeoutSeconds: 1, trailing: ["**/*.md", "**/guard-main.yml"] };
  await writeFile(join(A, "locker.json"), JSON.stringify(cfg, null, 2) + "\n");
  await mkdir(join(A, ".github/workflows"), { recursive: true }); await writeFile(join(A, ".github/workflows/guard-main.yml"), "on: push\n");
  await L.save(repo, rick, { message: "slow gate, wide trailing" }); await L.backup(repo);
  const repo2 = await L.openRepo(A);
  await writeFile(join(A, "thing.txt"), "t\n"); await L.save(repo2, claude, { message: "thing", slice: "slice/slow" });
  const rv = await L.review(repo2, astra, { from: "main", to: "slice/slow", verdict: "pass", findings: "ok" });
  await writeFile(join(A, ".github/workflows/guard-main.yml"), "on: workflow_dispatch\n");     // matches **/guard-main.yml, but the workflow is protected
  await L.save(repo2, claude, { message: "review and a workflow change" }); await L.backup(repo2); await L.lease(repo2, claude, "acquire");
  await rejects(L.accept(repo2, claude, { slice: "slice/slow", reviewId: rv.id }), "REVIEW_STALE");
  sh(A, "reset", "--quiet", "--hard", "HEAD^");
  const rv2 = await L.review(repo2, astra, { from: "main", to: "slice/slow", verdict: "pass", findings: "ok" });
  await writeFile(join(A, "notes.md"), "n\n");
  await L.save(repo2, claude, { message: "review and a note" });
  await rejects(L.backup(repo2), "PUSH_REFUSED");                                          // the slice diverged from its backed-up copy; the tool never forces
  const first = await L.accept(repo2, claude, { slice: "slice/slow", reviewId: rv2.id });
  const t0 = Date.now();
  const g = await rejects(L.accept(repo2, claude, { slice: "slice/slow", reviewId: rv2.id, confirm: first.token }), "GATE_FAILED");
  assert.match(g.message, /killed after 1 s/); assert.ok(Date.now() - t0 < 5000, `accept returned after ${Date.now() - t0} ms`);
  await L.lease(repo2, claude, "release");
});

test("bootstrap: a project whose truth branch has no locker.json yet accepts the slice that brings it, once", async () => {
  const R2 = join(tmp, "remote2.git"); sh(tmp, "init", "--bare", "--quiet", "-b", "main", R2);
  const C = join(tmp, "C"); sh(tmp, "clone", "--quiet", R2, C); sh(C, "checkout", "--quiet", "-b", "main");
  await writeFile(join(C, "README.md"), "# fresh\n"); sh(C, "add", "-A"); sh(C, "commit", "--quiet", "-m", "first"); sh(C, "push", "--quiet", "-u", "origin", "main");
  await L.init(C, { project: "fresh" });                                   // writes locker.json in the working tree only
  const repo = await L.openRepo(C); assert.equal(repo.configFrom, "working tree");
  const claude = await L.actorFromEnv(repo, env("claude", "c9")), astra = await L.actorFromEnv(repo, env("astra", "a9"));
  await writeFile(join(C, "thing.txt"), "t\n");
  await L.save(repo, claude, { message: "manage with sim locker", slice: "slice/manage" });
  const rv = await L.review(repo, astra, { from: "main", to: "slice/manage", verdict: "pass", findings: "ok" });
  await L.save(repo, claude, { message: "review" }); await L.backup(repo); await L.lease(repo, claude, "acquire");
  const first = await L.accept(repo, claude, { slice: "slice/manage", reviewId: rv.id });
  assert.equal(first.bootstrap, true);
  const done = await L.accept(repo, claude, { slice: "slice/manage", reviewId: rv.id, confirm: first.token });
  assert.equal(done.accepted, true); assert.match(done.bootstrap, /was not on origin\/main/);
  assert.ok(sh(C, "show", "origin/main:locker.json"));
  await L.lease(repo, claude, "release");
  // from now on the remote's copy rules, and removing locker.json from the truth branch does not reopen the bootstrap
  const repo2 = await L.openRepo(C); assert.equal(repo2.configFrom, "origin/main");
  const rick = await L.actorFromEnv(repo2, env("rick", "r9"));
  sh(C, "checkout", "--quiet", "main"); sh(C, "rm", "-q", "locker.json"); await L.save(repo2, rick, { message: "drop the config" }); await L.backup(repo2);
  await writeFile(join(C, "locker.json"), JSON.stringify({ project: "fresh", truth: "main", remote: "origin", actors: { claude: "agent", mallory: "agent" }, confirm: [] }, null, 2) + "\n");
  const repo3 = await L.openRepo(C);                                        // working tree config: openRepo tolerates it, accept does not
  await L.save(repo3, claude, { message: "my own rules", slice: "slice/takeover" });
  const mallory = await L.actorFromEnv(repo3, env("mallory", "m9"));
  const rvm = await L.review(repo3, mallory, { from: "main", to: "slice/takeover", verdict: "pass", findings: "sure" });
  await L.save(repo3, claude, { message: "review" }); await L.backup(repo3); await L.lease(repo3, claude, "acquire");
  const e = await rejects(L.accept(repo3, claude, { slice: "slice/takeover", reviewId: rvm.id }), "CONFIG");
  assert.match(e.message, /was on origin\/main before/);
  await L.lease(repo3, claude, "release");
});

test("the restore drill: a plain clone from a second remote carries the commit, the config and the records, and runs the tests", async () => {
  const repo = await L.openRepo(A);
  const dir = join(tmp, "drill-pass");
  const r = await L.drill(repo, { test: [process.execPath, "-e", "console.log('tests ok'); process.exit(0)"], keep: true, dir });
  assert.equal(r.drilled, true);
  assert.equal(r.commit, sh(A, "rev-parse", "origin/main"));
  assert.equal(sh(join(dir, "restored"), "rev-parse", "HEAD"), r.commit);
  assert.ok(r.records > 0, "review records are on the restored commit");
  assert.equal(r.test.code, 0); assert.match(r.test.lastLines, /tests ok/);
  await assert.rejects(import("node:fs/promises").then((fs) => fs.stat(join(dir, "restored", ".git", "locker-session"))), "the restored clone is plain git, not a managed clone");
  assert.throws(() => L.checkConfig({ project: "x", truth: "main", remote: "origin", actors: {}, drill: { test: "npm test" } }), /drill\.test must be a list/);
  assert.throws(() => L.checkConfig({ project: "x", truth: "main", remote: "origin", actors: {}, drill: { timeoutSeconds: 0 } }), /drill\.timeoutSeconds/);
  const none = await L.drill(repo, { test: null });
  assert.match(none.test, /^none/); assert.match(none.restoredClone, /^removed/);
  // a folder of the caller's own: refused when not empty, and only the drill's two folders are removed from it afterwards
  const e = await rejects(L.drill(repo, { test: null, dir }), "USAGE"); assert.match(e.message, /not empty/);
  const own = join(tmp, "drill-own"); await mkdir(own); await writeFile(join(own, "notes.txt"), "mine\n");
  await rejects(L.drill(repo, { test: null, dir: own }), "USAGE");
  const empty = join(tmp, "drill-empty"); await mkdir(empty);
  await L.drill(repo, { test: null, dir: empty });
  assert.deepEqual(await readdir(empty), [], "the given folder is left in place, emptied of the drill's folders only");
  assert.equal(await readFile(join(own, "notes.txt"), "utf8"), "mine\n");
  // drill.test comes from the commit being restored, read after the fetch: a setting added on the truth branch by another clone applies at once
  sh(tmp, "clone", "--quiet", remote, join(tmp, "D")); const D = join(tmp, "D");
  const cfg = JSON.parse(await readFile(join(D, "locker.json"), "utf8")); cfg.drill = { test: [process.execPath, "-e", "process.exit(9)"], timeoutSeconds: 1 };
  await writeFile(join(D, "locker.json"), JSON.stringify(cfg, null, 2) + "\n"); sh(D, "commit", "--quiet", "-am", "drill.test"); sh(D, "push", "--quiet", "origin", "main");
  const nine = await rejects(L.drill(repo), "DRILL_FAILED"); assert.equal(nine.details.test.code, 9); assert.equal(nine.details.commit, sh(D, "rev-parse", "HEAD"));
  sh(D, "reset", "--quiet", "--hard", "HEAD~1"); sh(D, "push", "--quiet", "--force", "origin", "main");   // raw git in the test only, to put the remote back
  // a shallow clone cannot stand in for the remote; a file as --dir is refused with the right code
  const S = join(tmp, "shallow"); sh(tmp, "clone", "--quiet", "--depth", "1", "file://" + remote, S);
  await writeFile(join(S, "locker.json"), await readFile(join(A, "locker.json"), "utf8"));
  const shallow = await rejects(L.drill(await L.openRepo(S), { test: null }), "USAGE"); assert.match(shallow.message, /shallow/);
  await writeFile(join(tmp, "afile"), "x\n"); await rejects(L.drill(repo, { test: null, dir: join(tmp, "afile") }), "USAGE");
  // the remote cannot be asked: no drill from the tracking ref
  const url = sh(A, "remote", "get-url", "origin"); sh(A, "remote", "set-url", "origin", url + ".gone");
  try { await rejects(L.drill(repo, { test: null }), "NOT_BACKED_UP"); } finally { sh(A, "remote", "set-url", "origin", url); }
});

test("the restore drill fails on a failing test command and keeps the folders for a look", async () => {
  const repo = await L.openRepo(A);
  const dir = join(tmp, "drill-fail");
  const e = await rejects(L.drill(repo, { test: [process.execPath, "-e", "console.error('boom'); process.exit(3)"], dir }), "DRILL_FAILED");
  assert.match(e.message, /exited 3/); assert.match(e.message, /folders kept/);
  assert.match(e.details.problems[0], /^the test command exited 3:\nboom/); assert.match(e.message, /boom/);
  assert.match(e.details.test.lastLines, /boom/);
  assert.equal(sh(join(dir, "restored"), "rev-parse", "HEAD"), e.details.commit);
  // a hung test runner is a failed drill, not a hung drill; the timeout is the restored commit's drill.timeoutSeconds
  const D = join(tmp, "D"); sh(D, "pull", "--quiet", "--ff-only");
  const cfg = JSON.parse(await readFile(join(D, "locker.json"), "utf8")); cfg.drill = { timeoutSeconds: 1 };
  await writeFile(join(D, "locker.json"), JSON.stringify(cfg, null, 2) + "\n"); sh(D, "commit", "--quiet", "-am", "drill timeout"); sh(D, "push", "--quiet", "origin", "main");
  const t0 = Date.now();
  const slow = await rejects(L.drill(repo, { test: [process.execPath, "-e", "setTimeout(() => {}, 60000)"], dir: join(tmp, "drill-slow") }), "DRILL_FAILED");
  assert.equal(slow.details.test.code, 124); assert.match(slow.details.test.lastLines, /killed after 1 s/);
  assert.ok(Date.now() - t0 < 5000, "killed within the second, not after a minute");
});

test("status and refusals say what to do next, in the output and in --json alike; init says what it wrote; help knows each command", async () => {
  // its own project, so the clone registry and the state of A and B do not matter here
  const sl = fileURLToPath(new URL("../bin/sl.js", import.meta.url));
  const run = (cwd, envExtra, ...a) => spawnSync(process.execPath, [sl, ...a], { cwd, encoding: "utf8", env: { ...process.env, SL_ACTOR: "", ...envExtra } });
  const r2 = join(tmp, "qol.git"); sh(tmp, "init", "--bare", "--quiet", "-b", "main", r2);
  const C = join(tmp, "qol"); sh(tmp, "clone", "--quiet", r2, C); sh(C, "checkout", "--quiet", "-b", "main");
  await writeFile(join(C, "README.md"), "# demo2\n"); sh(C, "add", "-A"); sh(C, "commit", "--quiet", "-m", "first"); sh(C, "push", "--quiet", "-u", "origin", "main");
  // first run: a clone with no locker.json is told, in one line, how to make it managed
  let p = run(C, {}, "status");
  assert.equal(p.status, 1); assert.match(p.stderr, /^UNMANAGED: .*no locker\.json; run sl init here to make it managed\n  next: sl init\n$/);
  p = run(C, {}, "status", "--json"); let j = JSON.parse(p.stdout);
  assert.equal(j.code, "UNMANAGED"); assert.equal(j.error, "UNMANAGED"); assert.equal(j.next, "sl init"); assert.ok("message" in j && "details" in j);
  // init says what it wrote and what to do next
  const init = await L.init(C, { project: "demo2" });
  assert.equal(init.wroteConfig, true); assert.ok(init.wrote.some((w) => w.startsWith("locker.json")) && init.wrote.some((w) => w.startsWith(".gitattributes")));
  assert.match(init.next, /as rick, on main: sl save -m "manage with sim locker" locker\.json \.gitattributes, then sl backup/);
  p = run(C, {}, "status"); assert.equal(p.status, 2);
  assert.match(p.stdout, /PROBLEM  CONFIG FROM WORKING TREE.*\n   next  as rick, on main: sl save/);
  // every problem has a fix in `next`, and the last entry is the step toward the next word
  const repo = await L.openRepo(C);
  let st = await L.status(repo);
  assert.equal(st.next.length, st.problems.length + 1);
  assert.equal(st.next[0].code, "CONFIG FROM WORKING TREE"); assert.match(st.next[0].fix, /sl save -m "manage with sim locker"/);
  assert.match(st.next.at(-1).step, /not saved: sl save/);
  const rick = await L.actorFromEnv(repo, env("rick", "r2"));
  await L.save(repo, rick, { message: "manage with sim locker" }); await L.backup(repo);
  st = await L.status(await L.openRepo(C)); assert.deepEqual(st.problems, []); assert.equal(st.next.length, 1); assert.match(st.next[0].step, /nothing waiting; main is backed up/);
  p = run(C, {}, "status"); assert.equal(p.status, 0); assert.match(p.stdout, /\nnext       nothing waiting; main is backed up\n$/);
  // on a slice: saved -> back up; backed up -> review; a passing review -> lease and accept
  const claude = await L.actorFromEnv(repo, env("claude", "c2")), astra = await L.actorFromEnv(repo, env("astra", "a2"));
  await writeFile(join(C, "x.js"), "1\n"); await L.save(repo, claude, { message: "x", slice: "slice/x" });
  st = await L.status(repo); assert.equal(st.next.at(-1).step, "saved, not backed up: sl backup");
  await L.backup(repo);
  st = await L.status(repo); assert.match(st.next.at(-1).step, /^backed up, not reviewed: a different actor runs sl review main\.\.slice\/x --verdict/);
  const rev = await L.review(repo, astra, { from: "main", to: "slice/x", verdict: "pass", findings: "fine" });
  st = await L.status(repo); assert.match(st.next.at(-1).step, /^1 file\(s\) not saved: sl save/);
  await L.save(repo, claude, { message: "review record" }); await L.backup(repo);
  st = await L.status(repo); assert.equal(st.next.at(-1).step, `reviewed (${rev.id}, pass); to accept: sl lease acquire, then sl accept slice/x --review ${rev.id}`);
  // the lease problem says when it expires; STALE says sl pull; the CLI prints the same next
  await L.lease(repo, astra, "acquire");
  st = await L.status(repo); const held = st.next.find((n) => n.code === "LEASE HELD"); assert.match(held.fix, /^it expires in (29|30) min; wait, or astra runs sl lease release$/);
  const D2 = join(tmp, "qol-2"); sh(tmp, "clone", "--quiet", r2, D2);
  await writeFile(join(D2, "n.md"), "n\n"); sh(D2, "add", "-A"); sh(D2, "commit", "--quiet", "-m", "moves main"); sh(D2, "push", "--quiet", "origin", "main"); await rm(D2, { recursive: true });
  await L.freshen(repo, { force: true }); st = await L.status(repo);
  assert.deepEqual(st.next.find((n) => n.code === "STALE"), { code: "STALE", fix: "sl pull" });
  p = run(C, { SL_ACTOR: "rick" }, "status", "--no-fetch"); assert.equal(p.status, 2);
  assert.match(p.stdout, /PROBLEM  NOT FETCHED.*\n   next  sl status without --no-fetch \(over MCP: status with fetch true\)\n/); assert.match(p.stdout, /PROBLEM  STALE.*\n   next  sl pull\n/);
  j = JSON.parse(run(C, {}, "status", "--no-fetch", "--json").stdout); assert.ok(j.next.some((n) => n.code === "STALE" && n.fix === "sl pull"));
  // refusals: one sentence, then the next command, the same in --json
  sh(C, "checkout", "--quiet", "main"); await writeFile(join(C, "x.js"), "2\n");
  p = run(C, { SL_ACTOR: "rick" }, "save", "-m", "y"); assert.equal(p.status, 1); assert.match(p.stderr, /^STALE: main here is 1 save\(s\) behind the remote, and it has changes not yet saved\n  next: sl save -m "<what and why>" --slice <name> \(a new slice starts from the remote's main\), then sl pull\n$/);
  j = JSON.parse(run(C, { SL_ACTOR: "rick" }, "save", "-m", "y", "--json").stdout); assert.equal(j.code, "STALE"); assert.match(j.next, /^sl save .* then sl pull$/); assert.equal(j.details.next, j.next);
  p = run(C, {}, "save", "-m", "y"); assert.match(p.stderr, /^NO_ACTOR: .*\n  next: export SL_ACTOR=<name>\n$/);
  // the way out of a stale truth branch with unsaved work: a new slice, started from the remote's main, and the step line says pull first
  assert.match(run(C, { SL_ACTOR: "rick" }, "status", "--no-fetch").stdout, /next       main is behind and 1 file\(s\) not saved: sl save -m "<what and why>" --slice <name> \(a new slice starts from origin\/main\), then sl pull\n/);
  j = JSON.parse(run(C, { SL_ACTOR: "claude" }, "save", "-m", "y", "--slice", "slice/out", "--json").stdout); assert.equal(j.saved, true); assert.equal(j.branch, "slice/out");
  assert.equal(sh(C, "rev-parse", "slice/out~1"), sh(C, "rev-parse", "origin/main"), "the slice starts from the remote's main, not the stale local one");
  // the unsaved change touches a file the remote also changed: the slice starts from the local main instead, and the save says so
  sh(C, "checkout", "--quiet", "main"); await writeFile(join(C, "n.md"), "mine\n");
  j = JSON.parse(run(C, { SL_ACTOR: "claude" }, "save", "-m", "n", "--slice", "slice/conf", "--json").stdout); assert.equal(j.saved, true); assert.match(j.note, /starts from the local main/);
  assert.equal(sh(C, "rev-parse", "slice/conf~1"), sh(C, "rev-parse", "main")); assert.equal(sh(C, "show", "slice/conf:n.md"), "mine");
  sh(C, "checkout", "--quiet", "main"); assert.match(run(C, { SL_ACTOR: "rick" }, "status", "--no-fetch").stdout, /next       main is behind: sl pull first\n/);
  sh(C, "checkout", "--quiet", "--detach"); assert.match(run(C, {}, "status", "--no-fetch").stdout, /next       not on a branch: sl save .* --slice <name>/); sh(C, "checkout", "--quiet", "slice/x");
  await rejects(L.lease(repo, claude, "acquire"), "LEASE_HELD").then((e) => { assert.match(e.message, /for another (29|30) min/); assert.match(e.next, /sl lease release/); });
  // help: grouped by the four words, and one command's options with an example
  p = run(C, {}, "--help"); assert.equal(p.status, 0);
  for (const g of ["\nsaved\n", "\nbacked up\n", "\naccepted\n", "\nlive\n", "\nthe drill\n"]) assert.ok(p.stdout.includes(g), g);
  const one = run(C, {}, "help", "save").stdout; assert.match(one, /^sl save -m/); assert.match(one, /--slice <name>/); assert.match(one, /\nexample: sl save -m "boss hp x1.25" --slice slice\/boss-hp\n$/);
  assert.equal(run(C, {}, "save", "--help").stdout, one);
  p = run(C, {}, "help", "bogus"); assert.equal(p.status, 1); assert.match(p.stderr, /^USAGE: unknown command "bogus"\n  next: sl help\n$/);
  p = run(C, {}, "bogus"); assert.equal(p.status, 1); assert.match(p.stderr, /^USAGE: unknown command "bogus"/);
  sh(C, "checkout", "--quiet", "x.js");
});
