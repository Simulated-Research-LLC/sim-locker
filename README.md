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

`accept` squashes the slice onto `main` as one commit carrying trailers (`Locker-Slice`, `Locker-Range-Head`, `Locker-Range-Base`, `Locker-Review`, `Locker-Actor`, `Locker-Session`), pushes, fetches back to prove it arrived, and keeps the slice branch as `done/<slice>`. Nothing is deleted.

## What it refuses, and why

| code | meaning |
|---|---|
| `UNMANAGED` | not a git clone, or no `locker.json`. Sim Locker will not work in a loose folder. This is the 0.41.2 folder sitting beside a 0.41.6 repo, made impossible |
| `STALE` | `main` here is behind the remote. `sl pull` first. `save` and `accept` refuse until then |
| `NOT FETCHED` | it could not reach the remote, so ahead/behind may be wrong. Said on the first line, never hidden |
| `TWO CLONES` | the same project is cloned twice on this machine. One machine, one clone |
| `AGENT_ON_TRUTH` | an agent tried to save on `main`. Agents save on slice branches; `accept` is how work reaches `main` |
| `LEASE_HELD` | someone else holds the lease on `main`. It expires on its own if their session dies |
| `NO_REVIEW`, `REVIEW_STALE`, `REVIEW_RANGE`, `REVIEW_BLOCKS` | accept needs a review record whose range is exactly the slice (merge base to head), and the only commits allowed after the reviewed head are the review records themselves |
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

`npm test` runs against real git: a bare remote standing in for GitHub and two clones standing in for two machines. It covers the unmanaged and stale refusals, agent on the truth branch, saved and backed up detection, the lease (held, not releasable by others, taken when expired), the whole accept path including a stale review, a blocking review, the confirm token and the kept `done/` branch, revert, a plain `git clone` with no Sim Locker having everything, and the merge driver through `.gitattributes`.

Not tested: two actors racing for the lease in the same instant. That path rests on git's `--force-with-lease` on the lease ref, which is git's own compare-and-swap; the tool reports `LEASE_RACE` when it loses.

## Files

```
bin/sl.js            the command line
bin/sl-mcp.js        the MCP server
src/locker.js        the four states, the rules, the records
src/git.js           a thin wrapper around the git executable
src/merge-record.js  the per-key merge driver
src/mcp.js           the MCP tool definitions
test/                node:test, real git
DESIGN.md            what it is and why; the open questions marked Rick
docs/audit-0.1.md    the adversarial audit of the first draft
docs/reading-rea-and-ghidra.md   what was read before the design, with file:line
ASTRA_BRIEF.md       the brief for the adversarial review by Codex (Astra) and the adoption steps
```

About 650 lines of JavaScript, two dependencies (the MCP SDK and zod).
