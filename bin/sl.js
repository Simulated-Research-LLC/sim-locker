#!/usr/bin/env node
// sl: the Sim Locker command line. Four words: saved, backed up, accepted, live. Every command prints what it did and the evidence.
// Printing only; every decision is in src/locker.js.
import { parseArgs } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as L from "../src/locker.js";
import { git } from "../src/git.js";
import { mergeRecordFiles } from "../src/merge-record.js";

// One entry per command: the group it belongs to, its usage line, one line on what it does, its options, one example.
const COMMANDS = {
  status: { group: "where you stand", usage: "sl status [--no-fetch]", what: "problems first, each with the command that fixes it, then saved / backed up / accepted / live and the next step", options: ["--no-fetch   do not ask the remote first (the output then says NOT FETCHED)"], example: "sl status" },
  save: { group: "saved", usage: 'sl save -m "<what and why>" [--slice <name>] [paths...]', what: "save the work on the slice branch, stamped with the actor", options: ["-m, --message   what changed and why (required)", "--slice <name>  the slice branch to save on; made from the truth branch if new", "paths...        only these files; all changes when none are given"], example: 'sl save -m "boss hp x1.25" --slice slice/boss-hp' },
  backup: { group: "backed up", usage: "sl backup", what: "send the current branch to the remote, then fetch it back and prove it arrived", options: [], example: "sl backup" },
  update: { group: "accepted", usage: 'sl update [-m "<message>"]', what: "bring the truth branch's changes into this slice as a save, so it can be accepted after the truth branch moved; lines both sides changed are left marked for you to settle, then sl save", options: ["-m, --message   the save's message (default: bring main into <slice>)"], example: "sl update" },
  pull: { group: "backed up", usage: "sl pull", what: "bring the truth branch up to date from the remote (never rewrites history)", options: [], example: "sl pull" },
  review: { group: "accepted", usage: 'sl review <truth>..<slice> --verdict pass|fix|block -f "<findings>"', what: "write a review record for exactly that range, as a different actor from the one who will accept", options: ["--verdict       pass, fix or block (required)", "-f, --findings  what was found, in words"], example: 'SL_ACTOR=astra sl review main..slice/boss-hp --verdict pass -f "numbers match the probe output"' },
  lease: { group: "accepted", usage: "sl lease status|acquire|renew|release", what: "the one-writer lease on the truth branch (30 min, renew by heartbeat)", options: [], example: "sl lease acquire" },
  accept: { group: "accepted", usage: 'sl accept <slice> --review <id> [-m "<message>"] [--confirm <token>]', what: "put the reviewed slice on the truth branch as one commit, under the lease; two steps", options: ["--review <id>      the review record saved in the slice (required)", "-m, --message      the message for the accepted commit", "--confirm <token>  the token the first step printed (10 minutes)"], example: "sl accept slice/boss-hp --review rev_1a2b3c4d5e6f" },
  revert: { group: "accepted", usage: "sl revert <commit> [--confirm <token>]", what: "a new save that undoes one; two steps; agents do it on a slice", options: ["--confirm <token>  the token the first step printed"], example: "sl revert 1a2b3c4" },
  live: { group: "live", usage: "sl live <commit>", what: "record that this commit is what people use (a record, then sl save it)", options: [], example: "sl live 1a2b3c4" },
  history: { group: "live", usage: "sl history [-n <count>]", what: "the truth branch's last saves: who made each, and for an acceptance the slice, the review and its reviewer", options: ["-n <count>   how many (default 20)"], example: "sl history -n 5" },
  version: { group: "setup", usage: "sl version", what: "this Sim Locker's version", options: [], example: "sl version" },
  find: { group: "live", usage: "sl find <words>", what: "search the review and live records", options: [], example: "sl find boss hp" },
  drill: { group: "the drill", usage: "sl drill [--keep] [--dir <d>] [-- <test command...>]", what: "restore drill: the truth branch to a fresh bare repo, cloned back with plain git, the tests run there", options: ["--keep       keep the two folders to look at", "--dir <d>    put them in this new or empty folder", "-- <cmd...>  another test command this once"], example: "sl drill -- node --test" },
  init: { group: "setup", usage: "sl init [--project <name>] [--truth main] [--remote origin]", what: "make this clone managed: writes locker.json and says what to do next", options: ["--project <name>  the project name (default: the folder name)", "--truth <branch>  the truth branch (default main)", "--remote <name>   the remote (default origin)"], example: "sl init --project old-winds" },
  clone: { group: "setup", usage: "sl clone <url> [dir]", what: "clone and make it managed in one step", options: ["--project, --truth, --remote  as for sl init"], example: "sl clone https://github.com/Simulated-Research-LLC/Old-Winds" },
  "merge-record": { group: "setup", usage: "sl merge-record %O %A %B %P", what: "the git merge driver for record files; init installs it, git calls it", options: [], example: "(installed by sl init; not run by hand)" },
  help: { group: "setup", usage: "sl help [command]", what: "this list, or one command's options and an example (also sl <command> --help)", options: [], example: "sl help save" },
};
const GROUPS = ["where you stand", "saved", "backed up", "accepted", "live", "the drill", "setup"];

function help(name) {
  if (name && COMMANDS[name]) { const c = COMMANDS[name]; return [c.usage, `  ${c.what}`, ...c.options.map((o) => `  ${o}`), `example: ${c.example}`].join("\n"); }
  const lines = ["sl: the truth store for a person and their agents. Git underneath, four words on top: saved, backed up, accepted, live.", ""];
  for (const g of GROUPS) { lines.push(g); for (const [n, c] of Object.entries(COMMANDS)) if (c.group === g) lines.push(`  ${c.usage}`, `      ${c.what}`); lines.push(""); }
  lines.push("sl help <command> or sl <command> --help: that command's options and an example. Add --json to any command for machine output.");
  lines.push("Every command but status, backup, pull, find and drill needs SL_ACTOR set to one of the actors in locker.json.");
  lines.push("A refusal prints a code (STALE, NOT_FETCHED, LEASE_HELD, REVIEW_STALE, PUSH_REFUSED, ...), one sentence, and the next command when there is one.");
  return lines.join("\n");
}

const { values: opt, positionals } = parseArgs({
  allowPositionals: true, strict: false,
  options: { json: { type: "boolean" }, "no-fetch": { type: "boolean" }, message: { type: "string", short: "m" }, slice: { type: "string" }, verdict: { type: "string" }, findings: { type: "string", short: "f" }, review: { type: "string" }, confirm: { type: "string" }, keep: { type: "boolean" }, dir: { type: "string" }, n: { type: "string" }, project: { type: "string" }, truth: { type: "string" }, remote: { type: "string" }, help: { type: "boolean", short: "h" } },
});
const [cmd, ...args] = positionals;

const out = (o) => process.stdout.write((opt.json ? JSON.stringify(o, null, 1) : plain(o)) + "\n");

function plain(o) {
  if (o && o.problems) {
    const s = o.current, lines = [];
    o.problems.forEach((p, i) => { lines.push(`PROBLEM  ${p}`); lines.push(`   next  ${o.next[i].fix}`); });
    if (!o.problems.length) lines.push("no problems");
    lines.push(`${o.project}  ${o.path}`);
    lines.push(`branch ${s.branch}${s.onTruth ? " (the truth branch)" : ""}  head ${s.head?.slice(0, 7) ?? "none"}  ${s.uncommitted.length} file(s) not saved`);
    lines.push(`saved      ${s.saved ? "yes" : "no"}`);
    lines.push(`backed up  ${s.backedUp ? "yes, on " + o.remote : "no" + (s.remoteHead ? ` (remote has ${s.remoteHead.slice(0, 7)}, ${s.ahead ?? "?"} ahead, ${s.behind ?? "?"} behind)` : " (never pushed)")}`);
    lines.push(`accepted   ${s.accepted ? "yes, as " + s.accepted.slice(0, 7) + " on " + o.truth.branch : s.onTruth ? "n/a on the truth branch" : "no"}`);
    lines.push(`live       ${!s.live.applies ? "n/a (this project has no live target)" : s.live.commit ? `${s.live.commit.slice(0, 7)} set by ${s.live.setBy} ${s.live.at}` : "never set"}`);
    lines.push(`lease      ${o.lease?.owner ? `${o.lease.owner} until ${o.lease.expires}${o.lease.expired ? " (expired)" : o.lease.mine ? " (yours)" : ""}` : "free"}`);
    if (o.reviews.length) lines.push(`reviews    ${o.reviews.map((r) => `${r.id} ${r.verdict} by ${r.reviewer}`).join("; ")}`);
    lines.push(`next       ${o.next.at(-1).step}`);
    return lines.join("\n");
  }
  if (o && o.confirmRequired) return o.message;
  if (o && o.rows) return [`${o.truth}, newest first (${o.fetchedAt})`, ...o.rows.map((r) => `${r.commit}  ${r.at.slice(0, 16).replace("T", " ")}  ${r.kind.padEnd(16)} ${r.actor ?? "?"}${r.slice ? `  ${r.slice}  ${r.review} (${r.verdict ?? "?"} by ${r.reviewer ?? "?"})` : ""}  ${r.subject}`)].join("\n");
  const scalar = ([, v]) => v !== undefined && (typeof v !== "object" || (Array.isArray(v) && v.every((x) => typeof x === "string")));
  return Object.entries(o).filter(scalar).filter(([k]) => k !== "hits").map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(k === "wrote" ? "\n       " : ", ") : v}`).join("\n") + (o.hits ? `\n${o.hits.map((h) => `${h.kind} ${h.id} ${h.verdict ?? ""} ${h.path}`).join("\n")}` : "") + (o.lease ? `\nlease: ${JSON.stringify(o.lease)}` : "") + (o.truth && typeof o.truth === "object" ? `\ntruth: ${JSON.stringify(o.truth)}` : "") + (o.test && typeof o.test === "object" ? `\ntest: ${o.test.command} exited ${o.test.code}\n${o.test.lastLines}` : "");
}

async function main() {
  if (!cmd || cmd === "help" || opt.help) {
    const name = cmd === "help" ? args[0] : cmd;
    if (name && !COMMANDS[name]) throw new L.LockerError("USAGE", `unknown command "${name}"`, { next: "sl help" });
    console.log(help(name)); return 0;
  }
  if (cmd === "merge-record") return mergeRecordFiles(...args.slice(0, 4));
  if (cmd === "clone") {
    const [url, dir] = args; if (!url) throw new L.LockerError("USAGE", "clone needs the url of the project", { next: "sl clone <url> [dir]" });
    const target = resolve(dir ?? url.split("/").pop().replace(/\.git$/, ""));
    await mkdir(target, { recursive: true });
    await git(process.cwd(), ["clone", "--quiet", url, target]);
    const r = await L.init(target, { project: opt.project, truth: opt.truth, remote: opt.remote });
    out({ cloned: target, project: r.config.project, wrote: r.wrote, next: r.next });
    return 0;
  }
  if (cmd === "version") { const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")); out({ version: pkg.version }); return 0; }
  if (cmd === "init") { const r = await L.init(process.cwd(), { project: opt.project, truth: opt.truth, remote: opt.remote }); out({ managed: r.top, project: r.config.project, truth: r.config.truth, configFrom: r.configFrom, wrote: r.wrote, next: r.next }); return 0; }
  if (!COMMANDS[cmd]) throw new L.LockerError("USAGE", `unknown command "${cmd}"`, { next: "sl help" });

  const repo = await L.openRepo(process.cwd());
  const needActor = !["status", "backup", "pull", "find", "drill", "history"].includes(cmd);
  const actor = needActor ? await L.actorFromEnv(repo) : null;
  switch (cmd) {
    case "status": { const s = await L.status(repo, { fetch: !opt["no-fetch"] }); out(s); return s.problems.length ? 2 : 0; }
    case "save": out(await L.save(repo, actor, { message: opt.message, paths: args, slice: opt.slice })); return 0;
    case "backup": out(await L.backup(repo)); return 0;
    case "pull": out(await L.pull(repo)); return 0;
    case "update": out(await L.update(repo, actor, { message: opt.message })); return 0;
    case "lease": out(await L.lease(repo, actor, args[0] ?? "status")); return 0;
    case "review": {
      const [from, to] = (args[0] ?? "").split(".."); if (!from || !to) throw new L.LockerError("USAGE", "review needs the range <truth>..<slice>, a verdict and findings", { next: COMMANDS.review.example });
      out(await L.review(repo, actor, { from, to, findings: opt.findings ?? "", verdict: opt.verdict })); return 0;
    }
    case "accept": { const r = await L.accept(repo, actor, { slice: args[0], reviewId: opt.review, message: opt.message, confirm: opt.confirm }); out(r); return r.confirmRequired ? 3 : 0; }
    case "revert": { const r = await L.revert(repo, actor, { commit: args[0], confirm: opt.confirm }); out(r); return r.confirmRequired ? 3 : 0; }
    case "live": out(await L.setLive(repo, actor, args[0])); return 0;
    case "find": out(await L.find(repo, args.join(" "))); return 0;
    case "history": out(await L.history(repo, { count: opt.n ? Number(opt.n) : 20 })); return 0;
    case "drill": {
      const unknown = Object.keys(opt).filter((k) => !["json", "keep", "dir"].includes(k));   // "sl drill node --test" would run bare node and pass
      if (unknown.length) throw new L.LockerError("USAGE", `unknown option --${unknown[0]}; the test command goes after --`, { next: COMMANDS.drill.example });
      out(await L.drill(repo, { test: args.length ? args : undefined, keep: opt.keep, dir: opt.dir })); return 0;
    }
  }
}

main().then((code) => process.exit(code ?? 0), (e) => {
  const code = e instanceof L.LockerError ? e.code : "GIT", next = e.next ?? null;
  if (opt.json) process.stdout.write(JSON.stringify({ error: code, code, message: e.message, details: e.details ?? null, next }) + "\n");
  else process.stderr.write(`${code}: ${e.message}\n${next ? `  next: ${next}\n` : ""}`);
  process.exit(1);
});
