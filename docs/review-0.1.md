# Adversarial review of Sim Locker 0.1 (first commit 748589e), 2026-10-12

Reviewer: a fresh-context Opus agent that had not seen the code being written, following `ASTRA_BRIEF.md`. It ran `npm test` and about 18 scenarios against real bare remotes. Verdict: **block**. Every critical and high finding was fixed in the commit after this one, each with a test; the medium and low ones that were fixed are marked. The report is kept as it was written, with the fix status added in brackets.

## Critical

- **C1** `save` with `slice: "HEAD"` (or `refs/heads/main`, `origin/main`) let an agent commit on main: the check compared the string the caller passed, not the branch git was on. [fixed: slice names are validated before any checkout, and the branch is re-read from git after it; test "attacks from the audit"]
- **C2** `locker.json` was read from the working tree, so an agent could edit its own kind to `human`. [fixed: the config that rules is the one on `origin/<truth>`; the working tree copy only bootstraps a project that has never been backed up, and `status` says CONFIG FROM WORKING TREE until then; test]
- **C3** A review record written into the working tree and never committed, or hidden with `.git/info/exclude`, was enough for `accept`; the acceptor could also be the reviewer. [fixed: the record is read from the slice head itself, the reviewer must be a configured actor and not the acceptor (REVIEW_SELF), and cited blobs are re-checked at the head; test]
- **C4** `revert` had no agent check, and a refused `save --slice main` had already moved HEAD onto main. [fixed: AGENT_ON_TRUTH in revert; the slice name is refused before the checkout; test]
- The reviewer's note that nothing stops an agent from setting `SL_ACTOR=rick` or using raw git is right. [documented at the top of `src/locker.js` and in README: enforcement needs GitHub branch protection; the tool makes the honest path easy and the dishonest path visible, not impossible]

## High

- **H1** Renaming any file into `locker/reviews/` after the review passed the "only review records" rule, and deleted the file from main. [fixed: `--no-renames --name-status`, and only `A locker/reviews/rev_<12 hex>.json` is allowed; test]
- **H2** Without `SL_SESSION`, each CLI call got a random session, so the lease holder could not accept or release. [fixed: one session id per clone in `.git/locker-session`; test; the README flow was rerun by hand]
- **H3** "backed up" compared against the tracking ref the push itself wrote; a failed fetch was ignored. [fixed: `git ls-remote` asks the remote; a failed ask is NOT_BACKED_UP; test with a push URL that works and a fetch URL that does not]
- **H4** `save` never fetched; `FETCH_HEAD` was fooled by a fetch of another remote; `status --no-fetch` said "no problems"; the lease was read from a possibly unfetched ref. [fixed: `save` fetches by age and refuses NOT_FETCHED on the truth branch (a slice save proceeds with a warning); the fetch time is Sim Locker's own file; `--no-fetch` always reports NOT FETCHED; `lease` forces a fetch; test for `--no-fetch`]

## Medium

- **M1** The lease was checked once, long before the push. [fixed: fetched and re-checked right before the push, together with the remote truth ref; the local merge is undone if either changed. Not tested under a timed race]
- **M2** A reused slice name or a tag pushed main and then failed. [fixed: NAME_TAKEN and "no local branch" are checked before anything moves; `keptOnRemote` is reported honestly; test]
- **M3** STALE REVIEW never cleared after an accept. [fixed: reviews consumed by an accept, or of an earlier head of an accepted slice, are not stale; test]
- **M4** The clone registry missed plain clones and URL spellings. [partly fixed: every clone that runs the tool is registered on open; URLs are normalised (file://, trailing slash, .git, case). A clone that never runs `sl` is still unknown]
- **M5** `init` and `clone` overwrote a committed `locker.json`. [fixed: an existing file is left alone]
- **M6** `pull` swallowed failures and mislabelled a dirty tree as DIVERGED. [fixed: DIVERGED only when ahead, DIRTY for a dirty tree, NOT_FETCHED when the remote is unreachable; accept's push failure message no longer guesses the cause]
- **M7** Frontmatter key order counted as content; CRLF hid keys. [fixed; tests]
- **M8** The driver `init` installed needed `sl` on PATH and was untested. [fixed: absolute node and script paths; test runs a real merge with PATH stripped]

## Low

- **L1** `GIT_AUTHOR_NAME` in the environment overrode the actor. [fixed: those variables are removed from git's environment]
- **L2** The lease belongs to a session string, not a clone. [not fixed; a session is deliberately the unit, since one agent session may use one clone]
- **L3** A confirm token can be read from `.git/locker-confirm.json` by the same agent. [not fixed; the token stops a slip, not an adversary. It is now tied to the actor and session too]
- **L4** Raw git errors came back with a numeric code. [fixed: code GIT]
- **L5** JSON merge is key-order sensitive and top level only; delete vs change shows null. [not fixed; documented as scope]
- **L6** A corrupt lease blob crashed `readLease`. [fixed: LEASE CORRUPT in status]

## Claims the reviewer could not verify

Fixed in the docs rather than the code: DESIGN.md no longer claims `done/` deletion after N days, `kept/<slice>`, `sl status --rebuild`, `sl migrate`, a heartbeat, `kind: import`, "any command marked confirm", or that `live` checks the target. README's "What is tested" now lists what the assertions cover. Codes still never asserted: REVIEW_RANGE, PUSH_REFUSED, DIVERGED, LEASE_RACE (held up under a 6-way race in the review, not in the suite), LEASE_NOT_MINE.

## What held up

Lease compare-and-swap under 6 racing clones, 3 rounds. Mixed commits after the reviewed head refused. Rebased slice refused. Block verdict refused. Confirm token from another clone refused. Option-shaped slice names refused by git. `paths` cannot leave the work tree. No force-push other than the lease line.
