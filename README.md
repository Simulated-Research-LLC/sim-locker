# Sim Locker

The truth store for one person and their AI agents. Git underneath for storage and transport. On top, four words and a few rules that git does not have.

| word | means | how you get there |
|---|---|---|
| **saved** | the change is a commit on this machine | `sl save -m "what and why"` |
| **backed up** | that commit is on GitHub (or whatever the remote is), proven by fetching it back | `sl backup` |
| **accepted** | the change is on the truth branch (`main`), after a review record, under the lease | `sl accept` |
| **live** | the accepted version is what people use | `sl live <commit>` |

You never need the words commit, push, pull, merge, rebase or land. `sl status` tells you which of the four you are at, what is wrong, if anything, and what to do next: every problem line is followed by the command that fixes it (`sl pull` for STALE, when the lease expires for LEASE HELD, which is not a problem for the session that holds it, which folder to keep for TWO CLONES), and the last line is the step toward the next word (save, back up, review, accept). A refusal prints its code, one sentence, and the next command when there is one. `sl help` groups the commands by the four words and the drill; `sl help <command>` or `sl <command> --help` prints that command's options and one example.

## Install

```
git clone https://github.com/simulated-research/sim-locker
cd sim-locker && npm install && npm link      # gives you `sl`, `simlocker` and `sl-mcp` on PATH
```

Node 22 or newer. No build step. On Windows, PowerShell already has `sl` as a short name for `Set-Location`, so there the command is `simlocker` (the same program under a second name); `sl` works in cmd.exe and in Git Bash. Old Winds' tooling runs `node <sim-locker>\bin\sl.js` for the same reason.

## Use it on a project

```
sl clone https://github.com/simulated-research/old-winds     # clone and make it managed in one step
cd old-winds
export SL_ACTOR=rick                                           # who you are: rick, claude, astra or percept
sl status
```

Or make an existing clone managed with `sl init` inside it. `init` writes `locker.json` (the project name, the truth branch, the remote, the actors), a `.gitattributes` line for record files, and registers the clone, so a second clone of the same project on the same machine shows up as a problem. It prints what it wrote and what to do next (save and back up `locker.json` as a human actor). `sl status` in a clone that has no `locker.json` says in one line to run `sl init`.

## A slice, start to finish

```
export SL_ACTOR=claude
sl save -m "boss hp x1.25" --slice slice/boss-hp     # saved, on a new slice branch made from the remote's main
sl backup                                            # backed up: pushed, then fetched back and compared
sl update                                            # only if main moved since the slice began: brings main into the slice as a save (lines both changed are left for you to settle); then sl backup again
export SL_ACTOR=astra
sl review main..slice/boss-hp --verdict pass -f "numbers match the probe output"
export SL_ACTOR=claude
sl save -m "review record"                           # the review is a file; saving it is allowed after the reviewed head
sl lease acquire                                     # one writer on main at a time, 30 minutes, renewable
sl accept slice/boss-hp --review rev_1a2b3c4d5e6f    # prints a token
sl accept slice/boss-hp --review rev_1a2b3c4d5e6f --confirm <token>
sl status
```

On the remote, the slice branch stays under its old name beside the `done/` copy: the tool deletes no remote branch, and some proxies refuse deletions anyway. Delete the old name from the branches page when it bothers you.

`accept` squashes the slice onto `main` as one commit carrying trailers (`Locker-Slice`, `Locker-Range-Head`, `Locker-Range-Base`, `Locker-Review`, `Locker-Actor`, `Locker-Session`), pushes, asks the remote to prove it arrived, and keeps the slice branch as `done/<slice>`. Nothing is deleted. The reviewer must be a different actor from the one accepting.

If you set `SL_SESSION` yourself, keep it the same for all the calls of one session; without it, every call in the same clone shares one id, so the lease you acquire is the lease you accept with. The session id is not a secret: `sl lease status` shows the holder's, and a clone that sets `SL_SESSION` to it is treated as the holder. The lease stops honest sessions from colliding; it does not stop an actor who copies another's id, the same trust class as setting `SL_ACTOR` to someone else's name.

## What this does and does not enforce

The rules are enforced in the tool: on the honest path an agent cannot reach `main` except through `accept`. Every critical and high finding of the review (`docs/review-0.1.md`) is refused with a test. Still open from that review: M1 is not tested under a timed race, M4 is only partly fixed, and L2, L3 and L5 are not fixed. But nothing here runs on GitHub. An agent that sets `SL_ACTOR=rick`, or uses raw `git push`, is stopped only by branch protection on the repo (require a pull request or restrict who can push to `main`). Turn that on for any project where it matters. On a public repo they are enforced on the free plan. On a private repo under a personal account GitHub's docs say rulesets need GitHub Pro (About rulesets: "in public and private repositories with GitHub Pro, GitHub Team, and GitHub Enterprise Cloud"); the settings page for this repo, while it was private on 2026-10-12, showed the form with the warning "Your rulesets won't be enforced on this private repository until you move to GitHub Team organization account". Either way, not enforced on a free private repo. This repo is public and has ruleset 24973232 on `main`: no deletion, no force pushes, linear history, active, no bypass list (confirmed from the API: `gh api repos/simulated-research/sim-locker/rules/branches/main`). The ruleset targets `main` only; the lease branch `locker/lease` must stay outside any rule that blocks force pushes, or the lease stops working. Sim Locker makes the honest path easy and the dishonest path visible; branch protection is what makes the raw-git path refuse.

The repo also carries a tripwire, kept because the ruleset does not look inside commits: `.github/workflows/guard-main.yml` runs `bin/sl-guard.js` on every push to `main`. It fails the run and opens an issue when the push was forced, or when any new commit on `main` has no `Locker-Actor` trailer and was not written by a configured human actor. It cannot undo the push; it makes sure nobody misses it. The failing path was exercised once on GitHub with a deliberate raw push to a new `guard-test/` branch, which the workflow also watches for that purpose: run 38348747072 failed and opened issue 1. Because the branch was new, that run took the first-push path (actor list from the pushed commit, whole history checked) and would have failed on the two pre-tool commits alone. The path a bad push to `main` takes (before..after, actor list from the commit before) has run green once on GitHub and failed only in the test suite. `bin/sl-guard.js` stands alone (no imports from `src/`), so those two files are all a project needs to copy. The human check matches the commit's author name to an actor name: `sl save` sets that, but a raw commit by Rick under another git name is flagged like any other. The guard reads the actor list from the commit before the push, so a push cannot add itself to the list. It does not catch a hand-typed trailer or a push that also edits the guard; the design accepts visible, not impossible.

The lease lives on the branch `locker/lease`, not a custom ref, because some proxies and server hooks allow pushes only under `refs/heads/`. It is the one branch the tool pushes with `--force-with-lease`, and it holds one small JSON file. A remote that refuses pushes under `refs/heads/locker/` makes `sl lease acquire` say `PUSH_REFUSED` and name the branch.

## What it refuses, and why

| code | meaning |
|---|---|
| `UNMANAGED` | not a git clone, or no `locker.json`. Sim Locker will not work in a loose folder. This is the 0.41.2 folder sitting beside a 0.41.6 repo, made impossible |
| `CONFIG FROM WORKING TREE` (status) | `locker.json` is not on the remote `main` yet, so the actors are not settled; save and back it up |
| `BAD_SLICE` | a slice name must look like `slice/boss-hp`: no `HEAD`, `refs/`, `main`, `done/`, or `..` |
| `STALE` | `main` here is behind the remote. `sl pull` first. A save on `main` itself and `accept` refuse until then; a save on a slice goes ahead, and a new slice starts from the remote's `main` as last fetched (when the unsaved change touches a file the remote also changed, the slice starts from the local `main` instead and the save says so; local saves on `main` not yet backed up are not carried onto a new slice) |
| `NOT FETCHED` | it could not reach the remote, so ahead/behind may be wrong. Said on the first line, never hidden |
| `TWO CLONES` | the same project is cloned twice on this machine. One machine, one clone |
| `AGENT_ON_TRUTH` | an agent tried to save on `main`. Agents save on slice branches; `accept` is how work reaches `main` |
| `LEASE_HELD` | someone else holds the lease on `main`. It expires on its own if their session dies |
| `NO_REVIEW`, `REVIEW_STALE`, `REVIEW_RANGE`, `REVIEW_BLOCKS`, `REVIEW_SELF`, `REVIEW_ACTOR` | accept needs a review record saved in the slice, by a different configured actor, whose range is exactly the slice (merge base to head) and whose cited files are unchanged; the saves after the reviewed head are judged one by one and may only add review records (each once: an edit or a removal of a record in a later save is a change) or change the project's trailing files, and none may have two parents. `status` applies the same rule when it says "reviewed" |
| `NAME_TAKEN` | `done/<slice>` already exists here or on the remote; a slice name is used once. `save --slice` refuses it too, before any branch is made |
| `BAD_PATH` | a path given to `save` is outside the folder |
| `DRILL_FAILED` | the restore drill found a problem: the restored clone is at another commit, `locker.json` is not on the truth branch, or the test command failed or timed out; the folders are kept |
| `ACCEPT_CONFLICT` | the slice and the truth branch changed the same lines; nothing half-done is left on the truth branch. `sl update` on the slice brings the truth branch in, you settle the marked lines, save, back up, get a new review, then accept |
| `UPDATE_CONFLICT` | `sl update` found lines both sides changed; they are left in the files between git's `<<<<<<<` and `>>>>>>>` marks (in a record file, as keys named `<<<<<<< ours` and `>>>>>>> theirs`, which count as marks too); a record one side left unreadable, which the merge driver cannot merge, is named as changed on both sides and not merged, with the slice's copy in place; a file changed on one side and deleted on the other is named as such, and you keep it or delete it; a binary file changed on both sides is named too, and you put the copy you want in its place. Keep the lines you want, delete the marks, `sl save`; the save finishes the update even when you kept the slice's side of everything. `status` says `UPDATE WAITING` until then. The update moves the slice's head, so the slice needs a new review before `accept` |
| `MARKERS_LEFT` | `sl save` while an update is waiting found a file with lines still to settle or git's marks still in it; nothing was saved. While an update waits, a save takes everything on the branch: paths or `--slice` are refused as `UPDATE_CONFLICT` |
| `GATE_FAILED` | the project's own gate command (`accept.gate` in `locker.json`) exited non-zero |
| `DETACHED` | not on a branch |
| `STALE REVIEW` (status) | a review cites a file whose content has since changed, and no newer review covers the current head |
| `BAD_CONFIRM` | wrong or expired token. Tokens last 10 minutes and are tied to the exact operation |
| `PUSH_REFUSED`, `NOT_BACKED_UP` | the remote refused, or after the push the remote did not have the commit. Sim Locker never forces a push |
| `DIVERGED` | `main` here has commits the remote does not. A person looks at this |

## A project's own gates

Projects with their own checks keep them. Two settings in `locker.json` (this repo's own `locker.json` names `node --test test/locker.test.js test/merge-record.test.js` as its gate, so every acceptance here runs those two files on the exact commit in a clean checkout, whatever the acceptor ran by hand; `test/mcp.test.js` is left out because it needs the MCP SDK from `node_modules`, which a clean checkout does not have, and CI runs it on every push):

```json
"accept": {
  "gate": ["node", "tools/old-winds.js", "accept", "--check"],
  "trailing": ["vault/00 Start/Delivery ledger.md"]
}
```

`gate` is a command (no shell, so `node x.js`, not `npm.cmd test`) run at the confirm step of `accept`, in a clean temporary checkout of exactly the commit being accepted (never the working tree, so ignored or stray files there count for nothing), with `SL_ACTOR`, `SL_SESSION` and `SL_GATE_COMMIT` in its environment and a timeout (`gateTimeoutSeconds`, 1 to 86400, default 900) that kills the gate's whole process group, so a hung test runner and its browsers die with it. A non-zero exit refuses with `GATE_FAILED` and the command's last lines. `trailing` lists record files that may change after the reviewed head without making the review stale (a delivery ledger written at acceptance time). Patterns under `locker.json`, `locker/`, `.gitattributes`, `.github/` or `bin/sl-guard.js` are refused when the config loads, and a file under any of those is refused at accept whatever the pattern says; review records may only be added, never changed; a trailing file the slice changed before the review is still a cited file and still checked. `accept` re-reads `locker.json` from the remote truth branch after its own fetch, so a forged local tracking ref cannot switch the gate off. One exception, for the first acceptance of a project whose truth branch has never had `locker.json` (checked against the branch's whole history, so removing it later does not reopen this): the slice that brings it rules that one acceptance with its own actors, confirm list and gate, since the project had no rules before and the reviewer sees `locker.json` in the diff; the lease, a review by a different actor and the lease's compare-and-swap still hold. The result says `bootstrap`, and from then on the remote's copy rules.

## Who did what

```
sl history            # the truth branch's last 20 saves, newest first
sl history -n 5
```

Each line is one save on the truth branch as the remote had it at the last fetch (`history` does not fetch; `sl status` does; before the first backup it reads the local branch and says so): the commit, when, whether it was an acceptance, a save or a save made outside the tool, who made it, and for an acceptance the slice, the review id, its reviewer and verdict, read from the record at that commit (null when the trailers name a record the commit does not hold). "Accepted" and "saved" mean the `Locker-*` trailers say so; a trailer typed by hand into a raw commit reads the same way here as it does for the guard. It is the "which models touched this" view a future Sum reads from the trailers; `--json` gives the rows; `-n` takes a whole number from 1 to 500. `sl version` prints the installed version.

## The restore drill

The question a truth store has to answer is whether the remote alone is enough to get the project back. `sl drill` asks it: it fetches (and refuses with `NOT_BACKED_UP` when the remote cannot be asked, since a drill from a stale tracking ref proves nothing), pushes the remote truth branch to a fresh bare repository (the "second remote", standing in for a USB stick or a new host), clones from that with plain git and no Sim Locker, checks that the clone is at that commit and that `locker.json` is on it, reports how many record files are under `locker/` there, and runs the project's tests in that clone with `SL_DRILL_COMMIT` set to the commit. The test command comes from `drill.test` in `locker.json` (the same shape as `accept.gate`: a list, no shell, so on Windows `node --test` and not `npm test`, since `npm.cmd` cannot be started without one; `drill.timeoutSeconds`, 1 to 86400, default 900) or from the command line after `--` (the `--` is needed: options before it belong to `sl`, and an unknown one is refused rather than dropped). The two drill settings are read from the `locker.json` on the exact commit being restored, after the drill's own fetch, so a setting that reached the truth branch a minute ago applies, and one added on a slice applies after that slice is accepted. With neither, the drill restores and checks and says it ran no tests.

```json
"drill": { "test": ["node", "--test", "test/locker.test.js", "test/merge-record.test.js"] }
```

(This repo's own setting. A plain clone has no `node_modules`, so the MCP test, which needs the SDK, is not part of the drill; it runs in CI.)

```
sl drill                        # restore from a second remote and run drill.test there
sl drill --keep                 # keep the two folders to look at
sl drill --dir ../drill-1       # put them in a folder of your own (new or empty; the drill removes only what it made)
sl drill -- node tools/x.js     # another test command this once
```

A pass removes the folders (or keeps them with `--keep`) and prints the commit, the record count and the test's last lines. Any problem (a different commit, no `locker.json`, a non-zero exit, a timeout) fails with `DRILL_FAILED`, prints the test's last lines, keeps the folders (under the system temp folder as `sl-drill-*` unless `--dir` was given) and says where they are. It refuses to run from a shallow clone, which does not hold the history it would be pushing. It needs no actor. It changes nothing on the remote and nothing in the working tree, unless `--dir` points inside the working tree and the drill fails, which leaves the kept folders there as untracked files; like `status` it moves the tracking refs when it fetches. The drill is a measurement, not a gate: run it when a project moves to Sim Locker (DESIGN.md names it as a precondition) and after anything that touches how the records are stored, and keep the output with the records of that work.

## For agents: the MCP server

```
sl-mcp /path/to/project
```

with `SL_ACTOR` (and optionally `SL_SESSION`) in the server's environment. Tools: `status`, `save`, `backup`, `review`, `update`, `accept`, `lease`, `find`, `history`, `drill`. Each returns JSON (also as `structuredContent`); a refusal is an error result with `code`, `message`, `details` and `next` (the next command, or null), the same as `sl <command> --json` prints. `status` carries `next`: one `{ code, fix }` per problem, in the same order, then one `{ step }` for the next of the four words, so a caller never parses the prose. The actor is never a tool argument. `init`, `clone`, `revert`, `live`, `pull` and `version` are CLI only.

Claude Code config, for example:

```json
{ "mcpServers": { "sim-locker": { "command": "sl-mcp", "args": ["/home/claude/old-winds"], "env": { "SL_ACTOR": "claude" } } } }
```

## Record files

`locker/reviews/*.json` and `locker/live/*.json` are plain JSON and travel with the repo. `*.record.json` and everything under `locker/` merge per top-level key (Ghidra's rule: take what only one side changed, conflict only where both changed the same key differently, keep both sides marked). YAML frontmatter in Markdown merges the same way per key; the body is one unit. The driver is `sl merge-record`, registered by `init`.

## What is tested

`npm test` runs 29 tests against real git: a bare remote standing in for GitHub and two clones standing in for two machines. CI runs them on ubuntu and windows on every push (`.github/workflows/test.yml`). The first Windows run, 38516669000 on 2026-10-14, failed five tests, all of them test code that only ran on Linux: a PATH with no git on it, a hand-written driver line with unquoted backslashes, a file URL turned into a path the Linux way, a time bound too tight for a slow box, and one cascade from the first; the fixes are in the tests, and `init`'s driver line now uses forward slashes as well, which the passing run 38517337204 proves works.

What the assertions cover, by area:

- **The folder and the actors.** UNMANAGED for a plain folder and an unmanaged clone, told in one line to run `sl init`; `init` reporting what it wrote; NO_ACTOR; one session per clone; the working-tree `locker.json` not changing an actor's kind; a fetch stamp dated in the future read as never fetched.
- **Saving and backing up.** A human saving and backing up on `main` with the trailers present; AGENT_ON_TRUTH for save and revert; STALE after another clone moves `main`, a save on `main` itself refused and cleared by `pull`, a save on a slice allowed, a new slice started from the remote's `main` (or from the local one with a note when the unsaved change touches a file the remote also changed); a bad slice name (`HEAD`, `refs/heads/main`, `main`) refused at save with HEAD not moved; a path outside the folder refused before any branch is made; a slice name used by another clone refused at save and at accept; NOT_BACKED_UP when the remote cannot be asked; a plain `git clone` holding `locker.json` and the review records.
- **Status.** Saved, backed up and accepted detection; TWO CLONES when a second clone opens, cleared when it is gone; `status --no-fetch` saying NOT FETCHED; one fix per problem (CONFIG FROM WORKING TREE, LEASE HELD with the minutes left, STALE, NOT FETCHED) and the step toward the next word (save, back up, review, lease and accept, nothing waiting); the lease not a problem for its own session and `lease.mine`; a stale review replaced by a newer one of the current head; the fix line right after `init` naming the save and the backup; a trailing-file save after the review keeping the slice reviewed, while a file renamed into the records folder, an edited record, a record only on disk or a save with two parents does not (the rule is accept's); refusals printing one sentence and the next command, with `code`, `message`, `details` and `next` in `--json`; `sl help`, `sl help save` and `sl save --help`.
- **The lease.** Held, not releasable or renewable by others, taken when expired; expiring during a slow gate and taken by another session, so the acceptance is refused at its last look with the remote's `main` unmoved and the folder back on the slice.
- **Reviews and accept.** Refused for NO_LEASE, NO_REVIEW, REVIEW_STALE (a new save; a file renamed into `locker/reviews/`; a record edited after it was saved), REVIEW_BLOCKS, REVIEW_SELF, DIRTY, BAD_CONFIRM, NAME_TAKEN; a review of nothing refused; the first accept step moving nothing and the second moving `main` on the remote with the trailers, keeping `done/<slice>` locally and on the remote; stale reviews cleared by the accept; the two-step revert; a slice that changed the same lines as `main` refused with ACCEPT_CONFLICT, `main` left where the remote has it, the folder back on the slice and the lease still held; a squash that fails for another reason refused as GIT with git's own words, its debris in a new folder cleaned; the bootstrap acceptance of a project's first locker.json.
- **Gates and trailing files.** `accept.gate` refusing with the gate's own words from a clean checkout of the commit (an excluded file in the working tree counts for nothing), a forged local `origin/main` not switching the gate off, `accept.trailing` letting a ledger row through while a raw commit after the review and a workflow change under a trailing pattern are refused, the refused patterns and timeouts, and a gate that sleeps past its timeout killed within the second.
- **Updates and conflicts.** `update` refused DIRTY, DETACHED and on the truth branch; a clean `update` bringing `main` in as one save with the actor's trailer; UPDATE_CONFLICT with the marked file, `status` saying UPDATE WAITING, `save` refused with MARKERS_LEFT while a file holds git's marks, the settled file saved as one save with two parents and the slice accepted after a new review; `status` and `save` agreeing (save looks at the tree before it stages anything); a save with paths or `--slice` during an update refused before anything moves; an update settled by keeping the slice's side still saved; a `=======` underline in a touched Markdown file not read as a mark, and a conflict in a file whose parents hold one still refused while the real marks are in; a file changed on one side and deleted on the other, and a binary file changed on both sides, named; a record file both sides changed stopping with the driver's keyed marks counted as marks, and a side the driver could not read named.
- **The guard.** Passing tool and human commits, failing a raw commit and a forced push.
- **The merge driver.** Per-key JSON and frontmatter merges, CRLF, through `.gitattributes`, both a hand-installed line and the one `init` installs, with no `sl` on PATH.
- **The drill.** The exact commit restored into a plain clone with the records on it, the test command run there, DRILL_FAILED on a non-zero exit with the folders kept, a hung test command killed at its timeout, a non-empty `--dir` refused and only the drill's own two folders removed from a given one; `drill.test` and `drill.timeoutSeconds` refused when malformed.
- **History.** An acceptance's slice, review, reviewer and verdict, a human's save, and a raw commit named as made outside the tool; a crafted subject making no row; bad counts refused.
- **The MCP server** (`test/mcp.test.js`, over an in-memory transport). The ten tools listed, `status` carrying `next`, a refusal as an error result with `code`, `message`, `details` and `next`, the actor taken from the environment and a tool argument naming one ignored, a save with the trailers, `history`, and REVIEW_SELF at accept.

Not in the suite: two actors racing for the lease in the same instant (held under six racing clones in the 0.1 review and again in the 2026-10-14 rerun, three rounds each; those runs are the reviewers', not reproduced here), REVIEW_RANGE, PUSH_REFUSED at accept (backup's is tested), DIVERGED, LEASE_RACE, LEASE_NOT_MINE.

## Files

```
bin/sl.js            the command line
bin/sl-mcp.js        the MCP server
bin/sl-guard.js      the tripwire GitHub Actions runs on every push to main
.github/workflows/guard-main.yml   the workflow that runs it
src/locker.js        the four states, the rules, the records
src/git.js           a thin wrapper around the git executable
src/merge-record.js  the per-key merge driver
src/mcp.js           the MCP tool definitions
test/                node:test, real git
DESIGN.md            what it is and why; the open questions marked Rick
docs/audit-0.1.md    the adversarial audit of the first draft
docs/drills-2026-10-13.md   the restore drill's output on the three managed repos
docs/backlog.md      findings not fixed in the slice that found them, with the reason
docs/review-0.1.md   the adversarial review of the first build (block) and what was done about each finding
docs/review-0.2.md   the rerun of the attack lists against 0.2.6 (nine findings, one blocking) and what 0.2.7 and 0.2.8 did about each
docs/errata.md       wrong statements in commit messages that history keeps
docs/reading-rea-and-ghidra.md   what was read before the design, with file:line
ASTRA_BRIEF.md       the brief for the adversarial review by Codex (Astra) and the adoption steps
```

About 1,000 lines of JavaScript, two dependencies (the MCP SDK and zod).
