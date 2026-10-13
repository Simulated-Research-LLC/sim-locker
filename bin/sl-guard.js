#!/usr/bin/env node
// sl-guard: the server-side tripwire for the truth branch, run by GitHub Actions on every push to it.
// It cannot stop a push (that needs branch protection, which this account cannot set from the cloud); it makes a bad push fail loudly:
// a forced push, or a commit on the truth branch that did not come through Sim Locker (no Locker-Actor trailer) and was not made by a
// configured human actor. Exit 0 clean, exit 1 with a plain report on stdout.
//   sl-guard <before-sha> <after-sha> [--forced] [--config locker.json]
import { readFile } from "node:fs/promises";
import { git } from "../src/git.js";

export async function guard(cwd, { before, after, forced = false, configPath = "locker.json" }) {
  const problems = [];
  if (forced) problems.push("FORCED PUSH: history on the truth branch was rewritten");
  let humans = [];
  try { const c = JSON.parse(await readFile(`${cwd}/${configPath}`, "utf8")); humans = Object.entries(c.actors ?? {}).filter(([, k]) => k === "human").map(([n]) => n); } catch { problems.push(`NO CONFIG: ${configPath} missing or unreadable at the pushed commit`); }
  const empty = /^0+$/.test(before ?? "");
  const rangeArg = empty ? [after] : [`${before}..${after}`];
  const log = await git(cwd, ["log", "--format=%H%x00%an%x00%(trailers:key=Locker-Actor,valueonly)%x00%s%x1e", ...rangeArg], { allowFail: true });
  if (log === null) problems.push(`BAD RANGE: cannot list ${rangeArg[0]} (was ${before} rewritten away?)`);
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

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const args = process.argv.slice(2);
  const forced = args.includes("--forced");
  const ci = args.indexOf("--config"), configPath = ci >= 0 ? args[ci + 1] : "locker.json";
  const [before, after] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--config");
  guard(process.cwd(), { before, after, forced, configPath }).then((r) => {
    for (const p of r.problems) console.log(`PROBLEM  ${p}`);
    for (const c of r.commits) console.log(`${c.ok ? "ok      " : "BAD     "} ${c.sha} ${c.actor ?? c.author}: ${c.subject}`);
    console.log(r.ok ? "guard: every commit came through Sim Locker or a human actor" : `guard: ${r.problems.length} problem(s)`);
    process.exit(r.ok ? 0 : 1);
  }, (e) => { console.log(`guard: ${e.message}`); process.exit(1); });
}
