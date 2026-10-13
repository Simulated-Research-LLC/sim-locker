# Sim Locker

The truth store for one person and their AI agents. Git underneath for storage and transport. On top, four words and a few rules that git does not have.

| word | means | how you get there |
|---|---|---|
| **saved** | the change is a commit on this machine | `sl save -m "what and why"` |
| **backed up** | that commit is on GitHub (or whatever the remote is), proven by fetching it back | `sl backup` |
| **accepted** | the change is on the truth branch (`main`), after a review record, under the lease | `sl accept` |
| **live** | the accepted version is what people use | `sl live <commit>` |

You never need the words commit, push, pull, merge, rebase or land. `sl status` tells you which of the four you are at and what is wrong, if anything.

## Install

```
git clone https://github.com/simulated-research/sim-locker
cd sim-locker && npm install && npm link      # gives you `sl` and `sl-mcp` on PATH
```

Node 22 or newer. No build step.

## Use it on a project

```
sl clone https://github.com/simulated-research/old-winds     # clone and make it managed in one step
cd old-winds
export SL_ACTOR=rick                                           # who you are: rick, claude, astra or percept
sl status
```

Or make an existing clone managed with `sl init` inside it. `init` writes `locker.json` (the project name, the truth branch, the remote, the actors), a `.gitattributes` line for record files, and registers the clone, so a second clone of the same project on the same machine shows up as a problem.

## A slice, start to finish

```
export SL_ACTOR=claude
sl save -m "boss hp x1.25" --slice slice/boss-hp     # saved, on a new slice branch made from main
sl backup                                            # backed up: pushed, then fetched back and compared
export SL_ACTOR=astra
sl review main..slice/boss-hp --verdict pass -f "numbers match the probe output"
export SL_ACTOR=claude
sl save -m "review record"                           # the review is a file; saving it is allowed after the reviewed head
sl lease acquire                                     # one writer on main at a time, 30 minutes, renewable
sl accept slice/boss-hp --review rev_1a2b3c4d5e6f    # prints a token
sl accept slice/boss-hp --review rev_1a2b3c4d5e6f --confirm <token>
sl status
```

`accept` squashes the slice onto `main` as one commit carrying trailers (`Locker-Slice`, `Locker-Range-Head`, `Locker-Range-Base`, `Locker-Review`, `Locker-Actor`, `Locker-Session`), pushes, asks the remote to prove it arrived, and keeps the slice branch as `done/<slice>`. Nothing is deleted. The reviewer must be a different actor from the one accepting.

If you set `SL_SESSION` yourself, keep it the same for all the calls of one session; without it, every call in the same clone shares one id, so the lease you acquire is the lease you accept with.

## What this does and does not enforce

The rules are enforced in the tool: on the honest path an agent cannot reach `main` except through `accept`, and every attack the review found (`docs/review-0.1.md`) is now refused with a test. But nothing here runs on GitHub. An agent that sets `SL_ACTOR=rick`, or uses raw `git push`, is stopped only by branch protection on the repo (require a pull request or restrict who can push to `main`). Turn that on for any project where it matters (on a private repo under a personal account that needs GitHub Pro). Sim Locker makes the honest path easy and the dishonest path visible; it does not make it impossible.

Until branch protection is on, the repo carries a tripwire: `.github/workflows/guard-main.yml` runs `bin/sl-guard.js` on every push to `main`. It fails the run and opens an issue when the push was forced, or when any new commit on `main` has no `Locker-Actor` trailer and was not written by a configured human actor. It cannot undo the push; it makes sure nobody misses it. `bin/sl-guard.js` stands alone (no imports from `src/`), so those two files are all a project needs to copy. The human check matches the commit's author name to an actor name: `sl save` sets that, but a raw commit by Rick under another git name is flagged like any other. The guard reads the actor list from the commit before the push, so a push cannot add itself to the list. It does not catch a hand-typed trailer or a push that also edits the guard; the design accepts visible, not impossible.

The lease lives on the branch `locker/lease`, not a custom ref, because some proxies and server hooks allow pushes only under `refs/heads/`. It is the one branch the tool pushes with `--force-with-lease`, and it holds one small JSON file.

## What it refuses, and why

| code | meaning |
|---|---|
| `UNMANAGED` | not a git clone, or no `locker.json`. Sim Locker will not work in a loose folder. This is the 0.41.2 folder sitting beside a 0.41.6 repo, made impossible |
| `CONFIG FROM WORKING TREE` (status) | `locker.json` is not on the remote `main` yet, so the actors are not settled; save and back it up |
| `BAD_SLICE` | a slice name must look like `slice/boss-hp`: no `HEAD`, `refs/`, `main`, `done/`, or `..` |
| `STALE` | `main` here is behind the remote. `sl pull` first. `save` and `accept` refuse until then |
| `NOT FETCHED` | it could not reach the remote, so ahead/behind may be wrong. Said on the first line, never hidden |
| `TWO CLONES` | the same project is cloned twice on this machine. One machine, one clone |
| `AGENT_ON_TRUTH` | an agent tried to save on `main`. Agents save on slice branches; `accept` is how work reaches `main` |
| `LEASE_HELD` | someone else holds the lease on `main`. It expires on its own if their session dies |
| `NO_REVIEW`, `REVIEW_STALE`, `REVIEW_RANGE`, `REVIEW_BLOCKS`, `REVIEW_SELF`, `REVIEW_ACTOR` | accept needs a review record committed in the slice, by a different configured actor, whose range is exactly the slice (merge base to head) and whose cited files are unchanged; the only commits allowed after the reviewed head are added review records |
| `NAME_TAKEN` | `done/<slice>` already exists; a slice name is used once |
| `DETACHED` | not on a branch |
| `STALE REVIEW` (status) | a review cites a file whose content has since changed |
| `BAD_CONFIRM` | wrong or expired token. Tokens last 10 minutes and are tied to the exact operation |
| `PUSH_REFUSED`, `NOT_BACKED_UP` | the remote refused, or after the push the remote did not have the commit. Sim Locker never forces a push |
| `DIVERGED` | `main` here has commits the remote does not. A person looks at this |

## For agents: the MCP server

```
sl-mcp /path/to/project
```

with `SL_ACTOR` (and optionally `SL_SESSION`) in the server's environment. Tools: `status`, `save`, `backup`, `review`, `accept`, `lease`, `find`. Each returns JSON (also as `structuredContent`); a refusal is an error result with the same codes as above. The actor is never a tool argument. `init`, `clone`, `revert`, `live` and `pull` are CLI only.

Claude Code config, for example:

```json
{ "mcpServers": { "sim-locker": { "command": "sl-mcp", "args": ["/home/claude/old-winds"], "env": { "SL_ACTOR": "claude" } } } }
```

## Record files

`locker/reviews/*.json` and `locker/live/*.json` are plain JSON and travel with the repo. `*.record.json` and everything under `locker/` merge per top-level key (Ghidra's rule: take what only one side changed, conflict only where both changed the same key differently, keep both sides marked). YAML frontmatter in Markdown merges the same way per key; the body is one unit. The driver is `sl merge-record`, registered by `init`.

## What is tested

`npm test` runs 15 tests against real git: a bare remote standing in for GitHub and two clones standing in for two machines. Asserted: UNMANAGED for a plain folder and an unmanaged clone; NO_ACTOR; one session per clone; a human saving and backing up on `main` with the trailers present; AGENT_ON_TRUTH for save and revert; saved, backed up and accepted detection in `status`; TWO CLONES when a second clone opens, cleared when it is gone; STALE after another clone moves `main`, `save` refused, cleared by `pull`; the lease held, not releasable or renewable by others, taken when expired; accept refused for NO_LEASE, NO_REVIEW, REVIEW_STALE (new commit; a file renamed into `locker/reviews/`), REVIEW_BLOCKS, REVIEW_SELF, DIRTY, BAD_SLICE (`HEAD`, `refs/heads/main`, `main`), BAD_CONFIRM, NAME_TAKEN; the working-tree `locker.json` not changing an actor's kind; the first accept step moving nothing and the second moving `main` on the remote with the trailers, keeping `done/<slice>` locally and on the remote; stale reviews cleared by the accept; NOT_BACKED_UP when the remote cannot be asked; the two-step revert; a plain `git clone` holding `locker.json` and the review records; the merge driver through `.gitattributes`, both a hand-installed one and the one `init` installs with PATH stripped; `status --no-fetch` saying NOT FETCHED; the guard passing tool and human commits and failing a raw commit and a forced push.

Not in the suite: two actors racing for the lease in the same instant (held up under six racing clones in the review, `docs/review-0.1.md`), REVIEW_RANGE, PUSH_REFUSED, DIVERGED, LEASE_RACE, LEASE_NOT_MINE.

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
docs/review-0.1.md   the adversarial review of the first build (block) and what was done about each finding
docs/reading-rea-and-ghidra.md   what was read before the design, with file:line
ASTRA_BRIEF.md       the brief for the adversarial review by Codex (Astra) and the adoption steps
```

About 790 lines of JavaScript, two dependencies (the MCP SDK and zod).
