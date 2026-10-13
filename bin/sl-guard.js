#!/usr/bin/env node
// sl-guard: the tripwire for the truth branch, run by GitHub Actions on every push to it. Standalone on purpose: copy this file and
// .github/workflows/guard-main.yml into any project and it runs with nothing else from Sim Locker.
// It cannot stop a push (that needs branch protection); it makes a bad push fail the run and open an issue. What it checks:
//   - the push was not forced;
//   - every new commit on the truth branch carries a Locker-Actor trailer (written by sl save and sl accept), or its author name is a
//     human actor in the locker.json of the commit BEFORE the push (so a push cannot add itself to the list it is checked against).
// What it does not catch: a hand-typed Locker-Actor trailer, a raw commit whose author name is a human actor's, or a push that also
// rewrites this file or the workflow. Those are visible in the log, not prevented.
//   sl-guard <before-sha> <after-sha> [--forced]       exit 0 clean, exit 1 with a plain report on stdout
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

function git(cwd, args) {
  return new Promise((done) => {
    const c = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); let out = "";
    c.stdout.on("data", (d) => { out += d; }); c.on("error", () => done(null)); c.on("close", (code) => done(code === 0 ? out.trimEnd() : null));
  });
}

export async function guard(cwd, { before, after, forced = false }) {
  const problems = [];
  if (forced) problems.push("FORCED PUSH: history on the truth branch was rewritten");
  const empty = !before || /^0+$/.test(before);
  // the actor list that rules is the one before the push; on the very first push there is no before, so the pushed one is used and said so
  const configRef = empty ? after : before;
  const text = await git(cwd, ["show", `${configRef}:locker.json`]);
  let humans = [];
  if (text === null) problems.push(`NO CONFIG: locker.json is not in ${configRef.slice(0, 7)}; no author counts as human`);
  else { try { humans = Object.entries(JSON.parse(text).actors ?? {}).filter(([, k]) => k === "human").map(([n]) => n); } catch { problems.push(`BAD CONFIG: locker.json in ${configRef.slice(0, 7)} is not valid JSON`); } }
  if (empty) problems.push("FIRST PUSH: no commit before this one, so the actor list comes from the pushed commit itself");
  const log = await git(cwd, ["log", "--format=%H%x00%an%x00%(trailers:key=Locker-Actor,valueonly)%x00%s%x1e", empty ? after : `${before}..${after}`]);
  if (log === null) problems.push(`BAD RANGE: cannot list ${empty ? after : `${before}..${after}`} (was ${before} rewritten away?)`);
  const commits = [];
  for (const rec of (log ?? "").split("\x1e")) {
    const [sha, author, actor, subject] = rec.split("\0").map((s) => s?.trim());
    if (!sha) continue;
    const viaTool = !!actor, byHuman = humans.includes(author);
    commits.push({ sha: sha.slice(0, 7), author, actor: actor || null, subject, ok: viaTool || byHuman });
    if (!viaTool && !byHuman) problems.push(`RAW PUSH ${sha.slice(0, 7)} by "${author}": not through Sim Locker and not a human actor (${humans.join(", ") || "none configured"}): ${subject}`);
  }
  return { ok: problems.length === 0, problems, commits };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const [before, after] = args.filter((a) => !a.startsWith("--"));
  guard(process.cwd(), { before, after, forced: args.includes("--forced") }).then((r) => {
    for (const p of r.problems) console.log(`PROBLEM  ${p}`);
    for (const c of r.commits) console.log(`${c.ok ? "ok      " : "BAD     "} ${c.sha} ${c.actor ?? c.author}: ${c.subject}`);
    console.log(r.ok ? "guard: every commit came through Sim Locker or a human actor" : `guard: ${r.problems.length} problem(s)`);
    process.exit(r.ok ? 0 : 1);
  }, (e) => { console.log(`guard: ${e.message}`); process.exit(1); });
}
