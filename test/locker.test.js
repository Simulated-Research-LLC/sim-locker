// End to end against real git: a bare remote standing in for GitHub, two clones standing in for two machines or two sessions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
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
  const fresh = await L.status(await L.openRepo(A), { fetch: false });   // right after init: the two problems that always come together share one fix
  assert.match(fresh.next.find((n) => n.code === "CONFIG FROM WORKING TREE").fix, /sl save -m "manage with sim locker" locker\.json \.gitattributes, then sl backup/);
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
  let st = await L.status(repo); assert.ok(st.problems.some((p) => p.startsWith("LEASE HELD BY claude")));
  process.env.SL_SESSION = "c1";   // the holder's own session: the lease is not a problem for it
  try { st = await L.status(repo); assert.ok(!st.problems.some((p) => p.startsWith("LEASE HELD")), st.problems.join("|")); assert.equal(st.lease.mine, true); } finally { delete process.env.SL_SESSION; }
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
  // a newer review of the slice's current head replaces the stale one in status (it clears for good at accept)
  const newer = await L.review(repo, astra, { from: "main", to: "slice/bump", verdict: "pass", findings: "v3 is fine" });
  await L.save(repo, claude, { message: "review again" }); await L.backup(repo);
  st = await L.status(repo); assert.ok(!st.problems.some((p) => p.startsWith("STALE REVIEW")), "replaced: " + st.problems.join("|"));
  assert.match(st.next.at(-1).step, new RegExp(`reviewed \\(${newer.id}`));
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
  // no node and no sl on PATH, only git's own folder; the driver uses absolute paths
  const gitDir = dirname(execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0].trim());
  const path = { ...process.env, PATH: process.platform === "win32" ? `${gitDir};${process.env.SystemRoot}\\System32` : gitDir === "/usr/bin" ? "/usr/bin:/bin" : `${gitDir}:/usr/bin:/bin` };
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
  await writeFile(join(A, "ledger/rows.md"), "| v | outcome |\n| 1 | feature |\n| 1 | again |\n"); await L.save(repo2, claude, { message: "another row" });
  await L.backup(repo2); await L.lease(repo2, claude, "acquire");
  assert.match((await L.status(repo2)).next.at(-1).step, /^reviewed \(/, "a trailing-file save after the review keeps the slice reviewed in status, as accept allows it");
  // what accept refuses, status does not call reviewed: a file renamed into locker/reviews/ after the review, and a save with two parents.
  // each case on its own slice off slice/gated, reviewed and backed up first so the step reads "reviewed", then broken
  for (const [name, breakIt] of [["slice/walk-rename", async () => { sh(A, "mv", "feature.txt", "locker/reviews/rev_000000000001.json"); await L.save(repo2, claude, { message: "sneak" }); }],
                                 ["slice/walk-merge", async () => { const W = join(tmp, "W"); sh(tmp, "clone", "--quiet", remote, W); await writeFile(join(W, "ledger/other.md"), "| 9 | from main |\n"); sh(W, "add", "-A"); sh(W, "commit", "--quiet", "-m", "main row"); sh(W, "push", "--quiet", "origin", "main"); await rm(W, { recursive: true }); assert.equal((await L.update(repo2, claude, {})).updated, true); }]]) {
    sh(A, "checkout", "--quiet", "-b", name); await L.backup(repo2);
    await L.review(repo2, astra, { from: "main", to: name, verdict: "pass", findings: "fine" }); await L.save(repo2, claude, { message: "record" }); await L.backup(repo2);
    assert.match((await L.status(repo2)).next.at(-1).step, /^reviewed \(rev_/);   // both slices' reviews cover the same head, so either id may be named
    await breakIt(); await L.backup(repo2);
    assert.match((await L.status(repo2)).next.at(-1).step, /^backed up, not reviewed/, `${name}: what accept refuses, status does not call reviewed`);
    sh(A, "checkout", "--quiet", "slice/gated");
  }
  await L.pull(repo2);   // the local main caught up with the remote (the merge case moved it)
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
  // its own folder under tmp, so a failed drill leaves nothing in the system temp folder
  const nine = await rejects(L.drill(repo, { dir: join(tmp, "drill-nine") }), "DRILL_FAILED"); assert.equal(nine.details.test.code, 9); assert.equal(nine.details.commit, sh(D, "rev-parse", "HEAD"));
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
  assert.ok(Date.now() - t0 < 20000, "killed at the timeout, not after a minute (the drill's own setup takes a few seconds on a slow box)");
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

test("a slice that changed the same lines as the truth branch is refused at accept with nothing half-done, and sl update brings the truth branch in", async () => {
  // its own remote: clone E is the acceptor, clone F moves main underneath it
  const r4 = join(tmp, "conflict.git"); sh(tmp, "init", "--bare", "--quiet", "-b", "main", r4);
  const E = join(tmp, "E"); sh(tmp, "clone", "--quiet", r4, E); sh(E, "checkout", "--quiet", "-b", "main");
  await writeFile(join(E, "notes.md"), "line one\n"); sh(E, "add", "-A"); sh(E, "commit", "--quiet", "-m", "first"); sh(E, "push", "--quiet", "-u", "origin", "main");
  await L.init(E, { project: "conflict" }); const repo = await L.openRepo(E);
  const rick = await L.actorFromEnv(repo, env("rick", "r5")), claude = await L.actorFromEnv(repo, env("claude", "c5")), astra = await L.actorFromEnv(repo, env("astra", "a5"));
  await L.save(repo, rick, { message: "manage" }); await L.backup(repo);
  await writeFile(join(E, "notes.md"), "line one, the slice's way\n"); await L.save(repo, claude, { message: "slice", slice: "slice/c" }); await L.backup(repo);
  const F = join(tmp, "F"); sh(tmp, "clone", "--quiet", r4, F);
  await writeFile(join(F, "notes.md"), "line one, main's way\n"); sh(F, "commit", "--quiet", "-am", "main moves"); sh(F, "push", "--quiet", "origin", "main");
  await L.pull(repo);                                                        // on the slice: local main catches up
  const rv = await L.review(repo, astra, { from: "main", to: "slice/c", verdict: "pass", findings: "ok" });
  await L.save(repo, claude, { message: "record" }); await L.backup(repo); await L.lease(repo, claude, "acquire");
  const first = await L.accept(repo, claude, { slice: "slice/c", reviewId: rv.id });
  const e = await rejects(L.accept(repo, claude, { slice: "slice/c", reviewId: rv.id, confirm: first.token }), "ACCEPT_CONFLICT");
  assert.deepEqual(e.details.files, ["notes.md"]); assert.match(e.next, /^on slice\/c: sl update/);
  assert.equal(sh(E, "rev-parse", "main"), sh(E, "rev-parse", "origin/main"), "main is where the remote has it");
  assert.equal(sh(E, "status", "--porcelain"), "", "nothing half-done is left behind");
  assert.equal(sh(E, "rev-parse", "--abbrev-ref", "HEAD"), "slice/c", "the folder is back on the slice, where the next step runs");
  assert.ok((await L.lease(repo, claude, "status")).lease.owner === "claude", "the lease is still held; the caller releases it");
  await L.lease(repo, claude, "release");
  // sl update on the slice: refusals first, then the shared line is left with git's marks, status says so, settling and saving finishes it
  await writeFile(join(E, "scratch.txt"), "x\n"); await rejects(L.update(repo, claude, {}), "DIRTY"); await rm(join(E, "scratch.txt"));
  sh(E, "checkout", "--quiet", "--detach"); await rejects(L.update(repo, claude, {}), "DETACHED"); sh(E, "checkout", "--quiet", "slice/c");
  await rejects(L.update(repo, claude, {}), "UPDATE_CONFLICT").then((x) => { assert.deepEqual(x.details.files, ["notes.md"]); assert.match(x.next, /keep the lines you want/); });
  let st = await L.status(repo); assert.ok(st.problems.some((p) => p.startsWith("UPDATE WAITING: an update left 1 file")), st.problems.join("|"));
  // settled in the editor and not yet added: status no longer counts it (save's add -A will take it)
  const marked = await readFile(join(E, "notes.md"), "utf8"); await writeFile(join(E, "notes.md"), "line one, settled in the editor\n");
  st = await L.status(repo); assert.ok(st.problems.some((p) => p === "UPDATE WAITING: an update is settled but not yet saved"), st.problems.join("|"));
  await writeFile(join(E, "notes.md"), marked);
  await rejects(L.update(repo, claude, {}), "UPDATE_CONFLICT");
  assert.match(await readFile(join(E, "notes.md"), "utf8"), /<<<<<<< HEAD[\s\S]*>>>>>>> origin\/main/, "the marks name the sides by name");
  // saving with the marks still in the file is refused; so is saving with the file still unmerged
  await rejects(L.save(repo, claude, { message: "oops" }), "MARKERS_LEFT").then((x) => assert.deepEqual(x.details.files, ["notes.md"]));
  assert.equal(sh(E, "rev-list", "--count", "--merges", "slice/c"), "0", "nothing was saved");
  await writeFile(join(E, "notes.md"), "<<<<<<< HEAD\nstill marked\n");
  sh(E, "add", "notes.md"); await rejects(L.save(repo, claude, { message: "oops" }), "MARKERS_LEFT");
  st = await L.status(repo); assert.ok(st.problems.some((p) => p === "UPDATE WAITING: an update left 1 file(s) to settle: notes.md"), "status and save agree while a mark is staged: " + st.problems.join("|"));
  await writeFile(join(E, "notes.md"), "line one, both ways\n"); sh(E, "add", "notes.md");
  st = await L.status(repo); assert.ok(st.problems.some((p) => p === "UPDATE WAITING: an update is settled but not yet saved"), st.problems.join("|"));
  // during an update a save takes everything on this branch: paths or another slice are refused before anything moves
  await rejects(L.save(repo, claude, { message: "part", paths: ["notes.md"] }), "UPDATE_CONFLICT");
  await rejects(L.save(repo, claude, { message: "elsewhere", slice: "slice/other" }), "UPDATE_CONFLICT");
  assert.equal(sh(E, "rev-parse", "--abbrev-ref", "HEAD"), "slice/c"); assert.equal(sh(E, "branch", "--list", "slice/other"), "");
  const saved = await L.save(repo, claude, { message: "settled" }); assert.equal(saved.saved, true);
  assert.equal(sh(E, "rev-list", "--count", "--merges", "slice/c"), "1", "the settled update is one save with two parents");
  st = await L.status(repo); assert.ok(!st.problems.some((p) => p.startsWith("UPDATE WAITING")));
  assert.equal((await L.update(repo, claude, {})).updated, false, "nothing more to bring in");
  // now the slice can be accepted after a fresh review
  await L.backup(repo);
  const rv2 = await L.review(repo, astra, { from: "main", to: "slice/c", verdict: "pass", findings: "settled" });
  await L.save(repo, claude, { message: "record" }); await L.backup(repo); await L.lease(repo, claude, "acquire");
  const t2 = await L.accept(repo, claude, { slice: "slice/c", reviewId: rv2.id });
  const done = await L.accept(repo, claude, { slice: "slice/c", reviewId: rv2.id, confirm: t2.token });
  assert.equal(done.accepted, true); assert.equal(sh(E, "show", "origin/main:notes.md"), "line one, both ways");
  await L.lease(repo, claude, "release");
  // update refuses on the truth branch and a clean update on a slice is one save
  await rejects(L.update(repo, rick, {}), "BAD_SLICE");
  // a squash that fails for a reason other than a conflict is not called a conflict: git's own words, and the folder back on the slice
  await writeFile(join(E, "lost.md"), "gone soon\n"); await L.save(repo, claude, { message: "lost", slice: "slice/lost" }); await L.backup(repo);
  const rv3 = await L.review(repo, astra, { from: "main", to: "slice/lost", verdict: "pass", findings: "ok" });
  await L.save(repo, claude, { message: "record" }); await L.backup(repo); await L.lease(repo, claude, "acquire");
  const blob = sh(E, "rev-parse", "slice/lost~1:lost.md"); await rm(join(E, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const t3 = await L.accept(repo, claude, { slice: "slice/lost", reviewId: rv3.id });
  const g = await rejects(L.accept(repo, claude, { slice: "slice/lost", reviewId: rv3.id, confirm: t3.token }), "GIT");
  assert.match(g.message, /squash of slice\/lost onto main failed: .*unable to read/); assert.equal(g.next, "sl status");
  assert.equal(sh(E, "rev-parse", "--abbrev-ref", "HEAD"), "slice/lost"); assert.equal(sh(E, "rev-parse", "main"), sh(E, "rev-parse", "origin/main"));
  await L.lease(repo, claude, "release");
  const H = join(tmp, "H"); sh(tmp, "clone", "--quiet", r4, H); await writeFile(join(H, "other.md"), "o\n"); sh(H, "add", "-A"); sh(H, "commit", "--quiet", "-m", "other"); sh(H, "push", "--quiet", "origin", "main");
  await writeFile(join(E, "mine.md"), "m\n"); await L.save(repo, claude, { message: "mine", slice: "slice/d" });
  const up = await L.update(repo, claude, {}); assert.equal(up.updated, true); assert.equal(sh(E, "show", "HEAD:other.md"), "o");
  assert.match(sh(E, "log", "-1", "--format=%B"), /Locker-Actor: claude/);
});

test("an update settled by keeping the slice's side is still saved; a Markdown underline is not a mark; a one-sided conflict is named; squash debris in new folders is cleaned", async () => {
  const r5 = join(tmp, "polish.git"); sh(tmp, "init", "--bare", "--quiet", "-b", "main", r5);
  const P = join(tmp, "P"); sh(tmp, "clone", "--quiet", r5, P); sh(P, "checkout", "--quiet", "-b", "main");
  await writeFile(join(P, "readme.md"), "# demo\n"); await writeFile(join(P, "doc.md"), "Intro\n"); await writeFile(join(P, "gone.md"), "g\n");
  sh(P, "add", "-A"); sh(P, "commit", "--quiet", "-m", "first"); sh(P, "push", "--quiet", "-u", "origin", "main");
  await L.init(P, { project: "polish" }); const repo = await L.openRepo(P);
  const rick = await L.actorFromEnv(repo, env("rick", "r6")), claude = await L.actorFromEnv(repo, env("claude", "c6")), astra = await L.actorFromEnv(repo, env("astra", "a6"));
  await L.save(repo, rick, { message: "manage" }); await L.backup(repo);
  await writeFile(join(P, "readme.md"), "# demo slice\n"); await writeFile(join(P, "gone.md"), "kept here\n"); await L.save(repo, claude, { message: "slice", slice: "slice/a" });
  const Q = join(tmp, "Q"); sh(tmp, "clone", "--quiet", r5, Q);
  await writeFile(join(Q, "readme.md"), "# demo main\n"); await writeFile(join(Q, "doc.md"), "Section\n=======\nIntro\n"); sh(Q, "rm", "-q", "gone.md");
  sh(Q, "commit", "--quiet", "-am", "main moves"); sh(Q, "push", "--quiet", "origin", "main");
  const c = await rejects(L.update(repo, claude, {}), "UPDATE_CONFLICT");
  assert.deepEqual(c.details.files.sort(), ["gone.md", "readme.md"]); assert.match(c.message, /gone\.md changed on one side and deleted on the other/); assert.match(c.next, /keep the file or delete it/);
  let st = await L.status(repo); assert.ok(!st.problems.join("|").includes("doc.md"), "the underline in doc.md is content, not a mark: " + st.problems.join("|"));
  // keep the slice's side of readme.md (the tree then equals HEAD for that file), keep gone.md: the save still finishes the update
  await writeFile(join(P, "readme.md"), "# demo slice\n");
  const saved = await L.save(repo, claude, { message: "keep ours" }); assert.equal(saved.saved, true);
  assert.equal(sh(P, "rev-list", "--count", "--merges", "slice/a"), "1"); assert.equal(await readFile(join(P, "gone.md"), "utf8"), "kept here\n");
  await assert.rejects(stat(join(P, ".git", "MERGE_HEAD")), "the update is finished");
  assert.equal(sh(P, "show", "HEAD:doc.md"), "Section\n=======\nIntro");
  // a failed squash whose debris sits in a new folder: cleaned, and the folder goes back to the slice
  await mkdir(join(P, "sub", "deeper"), { recursive: true }); await writeFile(join(P, "sub", "deeper", "new.md"), "n\n"); await writeFile(join(P, "lost.md"), "soon\n");
  await L.save(repo, claude, { message: "deep", slice: "slice/deep" }); await L.backup(repo); await L.pull(repo);
  const rv = await L.review(repo, astra, { from: "main", to: "slice/deep", verdict: "pass", findings: "ok" });
  await L.save(repo, claude, { message: "record" }); await L.backup(repo); await L.lease(repo, claude, "acquire");
  const blob = sh(P, "rev-parse", "slice/deep~1:lost.md"); await rm(join(P, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const t = await L.accept(repo, claude, { slice: "slice/deep", reviewId: rv.id });
  await rejects(L.accept(repo, claude, { slice: "slice/deep", reviewId: rv.id, confirm: t.token }), "GIT");
  assert.equal(sh(P, "rev-parse", "--abbrev-ref", "HEAD"), "slice/deep"); assert.equal(sh(P, "rev-parse", "main"), sh(P, "rev-parse", "origin/main"));
  await L.lease(repo, claude, "release");
});

test("a conflict in a file whose parents hold an underline is still a conflict, and a binary file changed on both sides is named", async () => {
  const r6 = join(tmp, "marks.git"); sh(tmp, "init", "--bare", "--quiet", "-b", "main", r6);
  const M = join(tmp, "M"); sh(tmp, "clone", "--quiet", r6, M); sh(M, "checkout", "--quiet", "-b", "main");
  await writeFile(join(M, "doc.md"), "Title\n=======\nbody\n"); await writeFile(join(M, "img.bin"), Buffer.from([0, 1, 2, 255, 0, 3]));
  sh(M, "add", "-A"); sh(M, "commit", "--quiet", "-m", "first"); sh(M, "push", "--quiet", "-u", "origin", "main");
  await L.init(M, { project: "marks" }); const repo = await L.openRepo(M);
  const rick = await L.actorFromEnv(repo, env("rick", "r7")), claude = await L.actorFromEnv(repo, env("claude", "c7"));
  await L.save(repo, rick, { message: "manage" }); await L.backup(repo);
  await writeFile(join(M, "doc.md"), "Title\n=======\nbody, the slice's way\n"); await writeFile(join(M, "img.bin"), Buffer.from([9, 9, 9, 255, 0, 9]));
  await L.save(repo, claude, { message: "slice", slice: "slice/m" });
  const N = join(tmp, "N"); sh(tmp, "clone", "--quiet", r6, N);
  await writeFile(join(N, "doc.md"), "Title\n=======\nbody, main's way\n"); await writeFile(join(N, "img.bin"), Buffer.from([7, 7, 7, 255, 0, 7]));
  sh(N, "commit", "--quiet", "-am", "main moves"); sh(N, "push", "--quiet", "origin", "main");
  const c = await rejects(L.update(repo, claude, {}), "UPDATE_CONFLICT");
  assert.deepEqual(c.details.files.sort(), ["doc.md", "img.bin"]); assert.match(c.message, /same lines in doc\.md/); assert.match(c.message, /img\.bin is a binary file changed on both sides/);
  assert.match(c.next, /put the copy you want in its place/);
  let st = await L.status(repo); assert.ok(st.problems.some((p) => p.startsWith("UPDATE WAITING: an update left 2 file")), st.problems.join("|"));
  await rejects(L.save(repo, claude, { message: "forgot the marks" }), "MARKERS_LEFT").then((x) => assert.deepEqual(x.details.files, ["doc.md"]));
  await writeFile(join(M, "doc.md"), "Title\n=======\nbody, both ways\n");
  st = await L.status(repo); assert.ok(st.problems.some((p) => p === "UPDATE WAITING: an update left 1 file(s) to settle: img.bin"), st.problems.join("|"));
  await writeFile(join(M, "img.bin"), Buffer.from([7, 7, 7, 255, 0, 7]));   // main's copy, chosen by hand
  const saved = await L.save(repo, claude, { message: "settled" }); assert.equal(saved.saved, true);
  assert.equal(sh(M, "rev-list", "--count", "--merges", "slice/m"), "1"); assert.equal(sh(M, "show", "HEAD:doc.md"), "Title\n=======\nbody, both ways");
});

test("the attacks of 2026-10-14: an edited record, a reused slice name from another clone, a record conflict through update, a hidden record, a path outside the folder", async () => {
  const r7 = join(tmp, "attack.git"); sh(tmp, "init", "--bare", "--quiet", "-b", "main", r7);
  const X = join(tmp, "X"); sh(tmp, "clone", "--quiet", r7, X); sh(X, "checkout", "--quiet", "-b", "main");
  await mkdir(join(X, "recs")); await writeFile(join(X, "a.md"), "a\n"); await writeFile(join(X, "recs/x.record.json"), '{"a": 1, "b": 1}\n');
  sh(X, "add", "-A"); sh(X, "commit", "--quiet", "-m", "first"); sh(X, "push", "--quiet", "-u", "origin", "main");
  await L.init(X, { project: "attack" }); const repo = await L.openRepo(X);
  const rick = await L.actorFromEnv(repo, env("rick", "r8")), claude = await L.actorFromEnv(repo, env("claude", "c8")), astra = await L.actorFromEnv(repo, env("astra", "a8"));
  await L.save(repo, rick, { message: "manage" }); await L.backup(repo);
  // 1. a review record edited after it was saved is a change accept sees, however it is saved
  await writeFile(join(X, "a.md"), "a2\n"); await L.save(repo, claude, { message: "late", slice: "slice/late" }); await L.backup(repo);
  const fix = await L.review(repo, astra, { from: "main", to: "slice/late", verdict: "fix", findings: "needs work" });
  await L.save(repo, claude, { message: "the record as written" }); await L.backup(repo);
  const path = join(X, "locker/reviews", `${fix.id}.json`); await writeFile(path, (await readFile(path, "utf8")).replace('"fix"', '"pass"'));
  await L.save(repo, claude, { message: "tidy the record" }); await L.backup(repo);
  let st = await L.status(repo); assert.match(st.next.at(-1).step, /^backed up, not reviewed/, "status does not call an edited record a review");
  await L.lease(repo, claude, "acquire");
  const e = await rejects(L.accept(repo, claude, { slice: "slice/late", reviewId: fix.id }), "REVIEW_STALE"); assert.match(e.message, /M locker\/reviews\//);
  await L.lease(repo, claude, "release");
  // 5. a record that exists only on disk (hidden from git) is not a review in status
  sh(X, "checkout", "--quiet", "main"); await writeFile(join(X, "b.md"), "b\n"); await L.save(repo, claude, { message: "b", slice: "slice/hidden" }); await L.backup(repo);
  const ghost = await L.review(repo, astra, { from: "main", to: "slice/hidden", verdict: "pass", findings: "ghost" });
  await writeFile(join(X, ".git", "info", "exclude"), `locker/reviews/${ghost.id}.json\n`);
  st = await L.status(repo); assert.match(st.next.at(-1).step, /^backed up, not reviewed/, "a record only on disk: " + st.next.at(-1).step);
  await rm(join(X, "locker/reviews", `${ghost.id}.json`)); await writeFile(join(X, ".git", "info", "exclude"), "");
  // 8. a path outside the folder is refused before any branch is made; a review of nothing is refused
  await writeFile(join(tmp, "outside.txt"), "o\n");
  await rejects(L.save(repo, claude, { message: "hack", slice: "slice/never", paths: [join(tmp, "outside.txt")] }), "BAD_PATH");
  assert.equal(sh(X, "branch", "--list", "slice/never"), ""); assert.equal(sh(X, "rev-parse", "--abbrev-ref", "HEAD"), "slice/hidden");
  await rejects(L.review(repo, astra, { from: "slice/hidden", to: "main", verdict: "pass", findings: "nothing" }), "BAD_RANGE");
  // 3. a slice name used by another clone is refused here, at save and at accept
  const Y = join(tmp, "Y"); sh(tmp, "clone", "--quiet", r7, Y); sh(Y, "checkout", "--quiet", "-b", "done/slice/used"); sh(Y, "push", "--quiet", "origin", "done/slice/used");
  await rejects(L.save(repo, claude, { message: "reuse", slice: "slice/used" }), "NAME_TAKEN");
  assert.equal(sh(X, "branch", "--list", "slice/used"), "");
  // 2. a record file both sides changed: the driver's keyed marks count as marks, and a side the driver could not read is named
  sh(X, "checkout", "--quiet", "main"); await writeFile(join(X, "recs/x.record.json"), '{"a": 1, "b": 2}\n'); await writeFile(join(X, "recs/y.record.json"), '{"k": 2}\n');
  await L.save(repo, claude, { message: "records", slice: "slice/recs" });
  await writeFile(join(Y, "recs/x.record.json"), '{"a": 1, "b": 3}\n'); await writeFile(join(Y, "recs/y.record.json"), '{"k": 1,\n');
  sh(Y, "checkout", "--quiet", "main"); await writeFile(join(Y, "recs/x.record.json"), '{"a": 1, "b": 3}\n'); await writeFile(join(Y, "recs/y.record.json"), '{"k": 1,\n');
  sh(Y, "add", "-A"); sh(Y, "commit", "--quiet", "-m", "main's records"); sh(Y, "push", "--quiet", "origin", "main");
  const c = await rejects(L.update(repo, claude, {}), "UPDATE_CONFLICT");
  assert.deepEqual(c.details.files.sort(), ["recs/x.record.json", "recs/y.record.json"]); assert.match(c.message, /same lines in recs\/x\.record\.json/); assert.match(c.message, /recs\/y\.record\.json changed on both sides and could not be merged/);
  assert.match(await readFile(join(X, "recs/x.record.json"), "utf8"), /"<<<<<<< ours"/);
  await rejects(L.save(repo, claude, { message: "oops" }), "MARKERS_LEFT").then((x) => assert.deepEqual(x.details.files, ["recs/x.record.json"]));
  st = await L.status(repo); assert.ok(st.problems.some((p) => p.startsWith("UPDATE WAITING: an update left 2 file")), st.problems.join("|"));
  await writeFile(join(X, "recs/x.record.json"), '{"a": 1, "b": 5}\n'); await writeFile(join(X, "recs/y.record.json"), '{"k": 2}\n');
  const saved = await L.save(repo, claude, { message: "settled" }); assert.equal(saved.saved, true); assert.equal(sh(X, "rev-list", "--count", "--merges", "slice/recs"), "1");
});

test("suite gaps: a used slice name refused at accept from another clone; the lease lost during the gate puts the folder back on the slice; a fetch stamp from the future counts as never fetched", async () => {
  const r8 = join(tmp, "gaps.git"); sh(tmp, "init", "--bare", "--quiet", "-b", "main", r8);
  const G1 = join(tmp, "G1"); sh(tmp, "clone", "--quiet", r8, G1); sh(G1, "checkout", "--quiet", "-b", "main");
  await writeFile(join(G1, "a.md"), "a\n"); sh(G1, "add", "-A"); sh(G1, "commit", "--quiet", "-m", "first"); sh(G1, "push", "--quiet", "-u", "origin", "main");
  await L.init(G1, { project: "gaps" }); let repo = await L.openRepo(G1);
  const rick = await L.actorFromEnv(repo, env("rick", "r9")), claude = await L.actorFromEnv(repo, env("claude", "c9")), astra = await L.actorFromEnv(repo, env("astra", "a9"));
  const cfg = JSON.parse(await readFile(join(G1, "locker.json"), "utf8")); cfg.lease = { ttlMinutes: 0.05 }; cfg.accept = { gate: [process.execPath, "-e", "setTimeout(() => {}, 4000)"] };
  await writeFile(join(G1, "locker.json"), JSON.stringify(cfg, null, 2) + "\n");
  await L.save(repo, rick, { message: "manage, with a slow gate and a 3 s lease" }); await L.backup(repo); repo = await L.openRepo(G1);
  // a name taken on the remote by another clone is refused at accept even when this clone made the branch by hand
  const G2 = join(tmp, "G2"); sh(tmp, "clone", "--quiet", r8, G2); sh(G2, "checkout", "--quiet", "-b", "done/slice/taken"); sh(G2, "push", "--quiet", "origin", "done/slice/taken");
  sh(G1, "checkout", "--quiet", "-b", "slice/taken"); await writeFile(join(G1, "b.md"), "b\n"); await L.save(repo, claude, { message: "b" }); await L.backup(repo);
  const rv = await L.review(repo, astra, { from: "main", to: "slice/taken", verdict: "pass", findings: "ok" }); await L.save(repo, claude, { message: "record" }); await L.backup(repo);
  await L.lease(repo, claude, "acquire");
  await rejects(L.accept(repo, claude, { slice: "slice/taken", reviewId: rv.id }), "NAME_TAKEN");
  await L.lease(repo, claude, "release");
  // the lease expires during the 4 s gate and another session takes it: the acceptance is refused at the last look, nothing moves, and the folder is back on the slice
  sh(G1, "checkout", "--quiet", "main"); await writeFile(join(G1, "c.md"), "c\n"); await L.save(repo, claude, { message: "c", slice: "slice/g" }); await L.backup(repo);
  const rv2 = await L.review(repo, astra, { from: "main", to: "slice/g", verdict: "pass", findings: "ok" }); await L.save(repo, claude, { message: "record" }); await L.backup(repo);
  await L.lease(repo, claude, "acquire");
  const first = await L.accept(repo, claude, { slice: "slice/g", reviewId: rv2.id });
  const other = await L.actorFromEnv(await L.openRepo(G2), env("astra", "elsewhere"));
  const taker = new Promise((done) => setTimeout(async () => { try { done(await L.lease(await L.openRepo(G2), other, "acquire")); } catch (e) { done(e); } }, 3300));
  const lost = await rejects(L.accept(repo, claude, { slice: "slice/g", reviewId: rv2.id, confirm: first.token }), "NO_LEASE");
  assert.match(lost.message, /lost while accepting/); assert.equal((await taker).action, "acquired", "the other session took the expired lease during the gate");
  assert.equal(sh(G1, "rev-parse", "--abbrev-ref", "HEAD"), "slice/g"); assert.equal(sh(G1, "rev-parse", "main"), sh(G1, "rev-parse", "origin/main"));
  assert.equal(sh(G1, "--git-dir", r8, "rev-parse", "main"), sh(G1, "rev-parse", "origin/main"), "the remote's main did not move");
  // a fetch stamp from the future is not fresh
  await writeFile(join(G1, ".git", "locker-fetched"), new Date(Date.now() + 3600_000).toISOString() + "\n");
  const f = await L.freshen(repo); assert.equal(f.fetched, true, "a future stamp counts as never fetched, so it fetches");
});

test("history reads the truth branch's saves and acceptances from the trailers and the records", async () => {
  const repo = await L.openRepo(A);
  const h = await L.history(repo, { count: 200 });
  assert.equal(h.truth, "origin/main");
  const acc = h.rows.find((r) => r.kind === "accepted");
  assert.ok(acc, "an acceptance is on main"); assert.match(acc.slice, /^slice\//); assert.match(acc.review, /^rev_/); assert.equal(acc.verdict, "pass"); assert.equal(acc.reviewer, "astra"); assert.equal(acc.actor, "claude (agent)");
  assert.ok(h.rows.some((r) => r.kind === "saved" && r.actor === "rick (human)"), "a human save on main");
  assert.equal(h.rows.at(-1).kind, "outside the tool"); assert.equal(h.rows.at(-1).subject, "first");
  const two = await L.history(repo, { count: 2 }); assert.equal(two.rows.length, 2);
  const printed = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/sl.js", import.meta.url)), "history", "-n", "2"], { cwd: A, encoding: "utf8", env: { ...process.env, SL_ACTOR: "" } }); assert.match(printed.stdout, /^origin\/main, newest first \(as of the last fetch\)\n[0-9a-f]{7}  \d{4}-\d\d-\d\d \d\d:\d\d  (accepted|saved|outside the tool)/);
  await rejects(L.history(repo, { count: 0 }), "USAGE"); await rejects(L.history(repo, { count: Number("abc") }), "USAGE"); await rejects(L.history(repo, { count: 2.5 }), "USAGE");
  // a crafted subject cannot make a row, two hand-typed actor trailers read as one row, and an acceptance trailer with no record behind it has null reviewer and verdict
  const Z = join(tmp, "Z"); sh(tmp, "clone", "--quiet", remote, Z);
  sh(Z, "commit", "--quiet", "--allow-empty", "-m", "odd\x1esubject\x1enot a hash"); sh(Z, "commit", "--quiet", "--allow-empty", "-m", "hand typed\n\nLocker-Actor: a (agent)\nLocker-Actor: b (agent)\nLocker-Slice: slice/fake\nLocker-Review: rev_000000000009");
  sh(Z, "push", "--quiet", "origin", "main"); await L.freshen(repo, { force: true });
  const odd = await L.history(repo, { count: 2 });
  assert.equal(odd.rows.length, 2); assert.equal(odd.rows[0].kind, "accepted"); assert.equal(odd.rows[0].actor, "a (agent), b (agent)"); assert.equal(odd.rows[0].reviewer, null); assert.equal(odd.rows[0].verdict, null);
  assert.equal(odd.rows[1].subject, "odd\x1esubject\x1enot a hash", "a record separator byte in a subject stays in the subject and makes no row"); assert.equal(odd.rows[1].kind, "outside the tool");
  sh(Z, "push", "--quiet", "--force", "origin", `${sh(Z, "rev-parse", "HEAD~2")}:main`);   // raw git in the test only, to put the remote back
  await L.freshen(repo, { force: true }); sh(A, "update-ref", "refs/heads/main", sh(A, "rev-parse", "origin/main"));
});
