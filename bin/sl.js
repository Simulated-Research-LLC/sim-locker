#!/usr/bin/env node
// sl: the Sim Locker command line. Four words: saved, backed up, accepted, live. Every command prints what it did and the evidence.
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import * as L from "../src/locker.js";
import { git } from "../src/git.js";
import { mergeRecordFiles } from "../src/merge-record.js";

const HELP = `sl: the truth store for a person and their agents. Git underneath, four states on top.

  sl status [--no-fetch]            where this folder stands: problems first, then saved / backed up / accepted / live
  sl save -m "<what and why>" [--slice <name>] [paths...]
                                    saved: commit on the slice branch, stamped with the actor
  sl backup                         backed up: push, then fetch and prove the remote has it
  sl pull                           bring the truth branch up to date (never rewrites history)
  sl lease status|acquire|renew|release
                                    the one-writer lease on the truth branch (30 min, renew by heartbeat)
  sl review <from>..<to> --verdict pass|fix|block -f "<findings>"
                                    write a review record for exactly that range
  sl accept <slice> --review <id> [-m "<message>"] [--confirm <token>]
                                    accepted: squash the reviewed slice onto the truth branch (two steps)
  sl revert <commit> [--confirm <token>]
                                    a new commit that undoes one; two steps
  sl live <commit>                  record that this commit is what people use
  sl find <words>                   search the records
  sl drill [--keep] [--dir <d>] [-- <test command...>]
                                    restore drill: push the truth branch to a fresh bare repo, clone it with plain git, run the tests there
  sl init [--project <name>] [--truth main] [--remote origin]
                                    make this clone managed (writes locker.json)
  sl clone <url> [dir]              clone and make it managed in one step
  sl merge-record %O %A %B %P       git merge driver for record files (installed by init)

Every command needs SL_ACTOR set to one of the actors in locker.json. Add --json for machine output.
Codes you will see: UNMANAGED, STALE, NOT FETCHED, TWO CLONES, LEASE HELD, STALE REVIEW, PUSH_REFUSED, NOT_BACKED_UP, DRILL_FAILED.`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true, strict: false,
  options: { json: { type: "boolean" }, "no-fetch": { type: "boolean" }, message: { type: "string", short: "m" }, slice: { type: "string" }, verdict: { type: "string" }, findings: { type: "string", short: "f" }, review: { type: "string" }, confirm: { type: "string" }, keep: { type: "boolean" }, dir: { type: "string" }, project: { type: "string" }, truth: { type: "string" }, remote: { type: "string" }, help: { type: "boolean", short: "h" } },
});
const [cmd, ...args] = positionals;

const out = (o) => process.stdout.write((opt.json ? JSON.stringify(o, null, 1) : plain(o)) + "\n");

function plain(o) {
  if (o && o.problems) {
    const s = o.current, lines = [];
    for (const p of o.problems) lines.push(`PROBLEM  ${p}`);
    if (!o.problems.length) lines.push("no problems");
    lines.push(`${o.project}  ${o.path}`);
    lines.push(`branch ${s.branch}${s.onTruth ? " (the truth branch)" : ""}  head ${s.head?.slice(0, 7) ?? "none"}  ${s.uncommitted.length} file(s) not saved`);
    lines.push(`saved      ${s.saved ? "yes" : "no"}`);
    lines.push(`backed up  ${s.backedUp ? "yes, on " + o.remote : "no" + (s.remoteHead ? ` (remote has ${s.remoteHead.slice(0, 7)}, ${s.ahead ?? "?"} ahead, ${s.behind ?? "?"} behind)` : " (never pushed)")}`);
    lines.push(`accepted   ${s.accepted ? "yes, as " + s.accepted.slice(0, 7) + " on " + o.truth.branch : s.onTruth ? "n/a on the truth branch" : "no"}`);
    lines.push(`live       ${!s.live.applies ? "n/a (this project has no live target)" : s.live.commit ? `${s.live.commit.slice(0, 7)} set by ${s.live.setBy} ${s.live.at}` : "never set"}`);
    lines.push(`lease      ${o.lease?.owner ? `${o.lease.owner} until ${o.lease.expires}${o.lease.expired ? " (expired)" : ""}` : "free"}`);
    if (o.reviews.length) lines.push(`reviews    ${o.reviews.map((r) => `${r.id} ${r.verdict} by ${r.reviewer}`).join("; ")}`);
    return lines.join("\n");
  }
  if (o && o.confirmRequired) return o.message;
  return Object.entries(o).filter(([, v]) => v !== undefined && typeof v !== "object").map(([k, v]) => `${k}: ${v}`).join("\n") + (o.files ? `\nfiles: ${o.files.join(", ")}` : "") + (o.hits ? `\n${o.hits.map((h) => `${h.kind} ${h.id} ${h.verdict ?? ""} ${h.path}`).join("\n")}` : "") + (o.lease ? `\nlease: ${JSON.stringify(o.lease)}` : "") + (o.truth && typeof o.truth === "object" ? `\ntruth: ${JSON.stringify(o.truth)}` : "") + (o.test && typeof o.test === "object" ? `\ntest: ${o.test.command} exited ${o.test.code}\n${o.test.lastLines}` : "");
}

async function main() {
  if (!cmd || opt.help) { console.log(HELP); return 0; }
  if (cmd === "merge-record") return mergeRecordFiles(...args.slice(0, 4));
  if (cmd === "clone") {
    const [url, dir] = args; if (!url) throw new L.LockerError("USAGE", "sl clone <url> [dir]");
    const target = resolve(dir ?? url.split("/").pop().replace(/\.git$/, ""));
    await mkdir(target, { recursive: true });
    await git(process.cwd(), ["clone", "--quiet", url, target]);
    const r = await L.init(target, { project: opt.project, truth: opt.truth, remote: opt.remote });
    out({ cloned: target, project: r.config.project, note: "locker.json written; save it when the project agrees on its actors" });
    return 0;
  }
  if (cmd === "init") { const r = await L.init(process.cwd(), { project: opt.project, truth: opt.truth, remote: opt.remote }); out({ managed: r.top, project: r.config.project, truth: r.config.truth }); return 0; }

  const repo = await L.openRepo(process.cwd());
  const needActor = !["status", "backup", "pull", "find", "drill"].includes(cmd);
  const actor = needActor ? await L.actorFromEnv(repo) : null;
  switch (cmd) {
    case "status": { const s = await L.status(repo, { fetch: !opt["no-fetch"] }); out(s); return s.problems.length ? 2 : 0; }
    case "save": out(await L.save(repo, actor, { message: opt.message, paths: args, slice: opt.slice })); return 0;
    case "backup": out(await L.backup(repo)); return 0;
    case "pull": out(await L.pull(repo)); return 0;
    case "lease": out(await L.lease(repo, actor, args[0] ?? "status")); return 0;
    case "review": {
      const [from, to] = (args[0] ?? "").split(".."); if (!from || !to) throw new L.LockerError("USAGE", "sl review <from>..<to> --verdict pass|fix|block -f <findings>");
      out(await L.review(repo, actor, { from, to, findings: opt.findings ?? "", verdict: opt.verdict })); return 0;
    }
    case "accept": { const r = await L.accept(repo, actor, { slice: args[0], reviewId: opt.review, message: opt.message, confirm: opt.confirm }); out(r); return r.confirmRequired ? 3 : 0; }
    case "revert": { const r = await L.revert(repo, actor, { commit: args[0], confirm: opt.confirm }); out(r); return r.confirmRequired ? 3 : 0; }
    case "live": out(await L.setLive(repo, actor, args[0])); return 0;
    case "find": out(await L.find(repo, args.join(" "))); return 0;
    case "drill": out(await L.drill(repo, { test: args.length ? args : undefined, keep: opt.keep, dir: opt.dir })); return 0;
    default: throw new L.LockerError("USAGE", `unknown command "${cmd}"\n${HELP}`);
  }
}

main().then((code) => process.exit(code ?? 0), (e) => {
  const code = e instanceof L.LockerError ? e.code : "GIT";
  if (opt.json) process.stdout.write(JSON.stringify({ error: code, message: e.message, details: e.details ?? null }) + "\n");
  else process.stderr.write(`${code}: ${e.message}\n`);
  process.exit(1);
});
