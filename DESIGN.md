# Sim Locker: design

Version 0.1, 2026-10-12. Written after reading morluto/rea and NationalSecurityAgency/ghidra in full (notes: `docs/reading-rea-and-ghidra.md`), an adversarial audit of the first draft (`docs/audit-0.1.md`), and an adversarial review of the first build (`docs/review-0.1.md`, verdict block, every critical and high item fixed with a test). Everything marked **Rick** is a question he has not answered; the tool ships with the default stated and refuses nothing it does not have to.

## What it is

One tool, used by a person and by AI agents, that holds the truth for every project. Git underneath for storage and transport. Above it a thin record layer: four states, a source on every change, leases for the one branch that matters, reviews as files, and a `status` that tells the truth about where a folder stands.

It is not a new version control system, not a GitHub replacement for storage, and not a GUI. GitHub is a remote. Everything Sim Locker knows lives in the repo as plain files, so a bare `git clone` with no Sim Locker installed still gives a complete, working project.

## The four states

| state | means | who may trigger | evidence | command |
|---|---|---|---|---|
| saved | committed on the local slice branch, by the tool | any actor | the commit hash | `sl save` |
| backed up | that commit exists on the remote | any actor | after a fetch, the remote ref equals the local ref (the push exit code is not trusted) | `sl backup` |
| accepted | merged to the truth branch (`main`) | the actor holding the lease, after a review record exists for the exact range (**Rick**: may an agent accept, or Rick only? default: an agent may, with a review record and the lease) | the review record, the lease, a clean tree, and the truth branch not having moved since the fetch | `sl accept` |
| live | the accepted version is what people use | per project | declared in `locker.json`: `none` (a research repo) or a kind with a target. In 0.1 `sl live` only records which commit was declared live, by whom and when; it does not check the target | `sl live` |

Draft work (an editor's autosave, a crash snapshot) is below `saved` and is not a state. There is also a way down: `sl revert <commit>` makes a new saved change that undoes an accepted one; it does not rewrite history.

## The rules the tool enforces

1. **Refuse to work in an unmanaged or stale folder.** Every command first checks: is this a Sim Locker clone (has `.git`, has `locker.json`, has a remote by the configured name)? If not: `UNMANAGED`, and nothing runs. `status`, `save`, `pull`, `lease` and `accept` fetch first when the last fetch Sim Locker made is older than the configured age (its own timestamp, not `FETCH_HEAD`); `backup` asks the remote directly. When the remote cannot be reached: `status` says `NOT FETCHED` first, `save` on the truth branch and `accept` refuse, and `save` on a slice goes ahead with a warning. Behind means `STALE`, and `save` and `accept` refuse. This is the failure of 2026-10-12 (a folder with no `.git`, 0.41.2 on disk while GitHub was at 0.41.6) made impossible.
2. **One writer on the truth branch.** A lease is a JSON object in the branch `locker/lease` (a branch rather than a custom ref, because some proxies and hooks allow pushes only under `refs/heads/`), pushed with `--force-with-lease` so acquiring is a compare-and-swap: two actors cannot both win (the 0.1 reviewer reports it held under six racing clones; not reproduced in the suite). It has an owner, a session id and an expiry (default 30 minutes); `sl lease renew` extends it, and nothing renews it by itself. `accept` checks the lease at the start and again, after a fetch, right before the push. An expired lease can be taken by anyone, which is how an agent's lease dies with the agent without a server. (Ghidra's TRANSIENT checkout needs a live connection; a TTL is the git-shaped version of it.)
3. **No force-push, ever**, except the compare-and-swap on the lease ref, which cannot lose anyone's work.
4. **Source is stamped by the tool, never taken from the payload.** Every save records `actor` (from `SL_ACTOR`, required) and the session id; the actor's kind (`human`, `agent`, `model`) comes from the `locker.json` on the remote truth branch, so a clone cannot promote itself by editing its own copy. Agents cannot save or revert on the truth branch at all; their work lands on a slice and reaches the truth branch only through `accept`, which needs a review by a different actor. Honest limit: nothing of Sim Locker runs on the server. An agent that sets `SL_ACTOR=rick`, or uses raw git, is stopped only by GitHub branch protection or a server hook; this repo has a ruleset on `main` (no deletion, no force push, linear history) since 2026-10-12, and the guard workflow for the rest. The tool makes the honest path easy and the dishonest path visible; it does not make it impossible. (Ghidra's SourceType priority is also a convention among callers.) **Rick**: which fields may an agent fix and accept without a review (links, version strings)? Default: none.
5. **A review is a file.** `sl review <from>..<to>` writes `locker/reviews/<id>.json`: the exact commit range (from the merge base of the two, so `main..slice` means the slice's own commits even after `main` has moved), the reviewer actor, findings, and the blob hashes of every file it cites. `sl status` flags any review whose cited blob is no longer at `HEAD` as `STALE REVIEW`. `accept` needs a review whose range runs from the merge base to the slice head; because the record itself is then committed on the slice, the only commits allowed after the reviewed head are ones that touch `locker/reviews/` and nothing else.
6. **Nothing is destroyed; superseded work gets a name.** When a slice is accepted its branch is kept as `done/<slice>`, locally and on the remote, and a slice name is used once (`NAME_TAKEN`). The tool deletes no branch. (Ghidra's `.keep` copies.) Renaming an abandoned slice to `kept/<slice>` is a convention for now, not a command.
7. **Two steps for anything long or destructive.** `accept` and `revert` print a one-time token on the first call and act only when called again with `--confirm <token>`; the token is tied to the operation, its arguments, the actor and the session, and lasts ten minutes. A single keystroke, or a cat, cannot start it. The token stops a slip, not an adversary: the same agent can read it from `.git/locker-confirm.json`.
8. **Status tells the truth.** `sl status` prints the problems first (`NOT FETCHED`, `STALE`, `NO REMOTE TRUTH`, `CONFIG FROM WORKING TREE`, `TWO CLONES`, `LEASE HELD BY`, `LEASE CORRUPT`, `STALE REVIEW`, `DETACHED`), then the four states for the current slice, then the lease. Two clones of one project on one machine is an error, not a choice (REA's "two usable candidates is an error"); the registry knows every clone that has run the tool, and nothing about one that has not.
9. **Records are rebuildable.** The tool keeps no index: everything `status` prints is read from the files in `locker/`, the commit trailers on the truth branch and the git refs, every time (Ghidra rebuilds its index from property files; here there is nothing to rebuild).
10. **Sim Locker owns no state git cannot hold** and generates nothing a project already generates. A project's own gates run from `accept` (`accept.gate` in `locker.json`), and its own records may be written at acceptance time (`accept.trailing`). Old Winds keeps `tools/old-winds.js`, its vault and its regression set; Sim Locker wraps the saving, backing up and accepting around them. If Sim Locker ever replaces a project's tool, it deletes that tool in the same change (Old Winds rule 2).

## Merging

v0.1 uses git's own merge. One addition: a merge driver for `*.record.json` files and for YAML frontmatter that merges per top-level key (about 200 lines), registered in `.gitattributes`. Everything else is a plain text merge, and a conflict stops the operation with both sides kept, never a guess. Out of scope for 0.1: Markdown bodies by section, code, "keep both" or "use for all" choices, any GUI. Ghidra's address-set rule (apply what only one side changed, conflict only where both changed and differ) is what the record driver does for keys.

## The tool surface

MCP tools, each returning JSON with the state and the evidence behind it:

| tool | returns |
|---|---|
| `status` | problems, the four states, branch, ahead/behind, lease, slices, stale reviews |
| `save` | commit hash, actor, files |
| `backup` | the remote ref after a verifying fetch |
| `review` | the review record id and path |
| `accept` | the merge commit, or the refusal and its reason, or the confirm token |
| `lease` | acquire, renew, release; owner and expiry |
| `find` | matching records |

CLI only: `sl init` (make a clone managed), `sl clone`, `sl pull`, `sl live`, `sl revert`, and every `--confirm`. Bringing a project in is `sl clone` plus saving a `locker.json` on its truth branch; there is no separate `migrate` command. Percept does not call tools; a script feeds it `status` output and reads back a yes/no. **Rick**: does Astra's Codex harness speak MCP in your setup? If not, every MCP verb is also a CLI command, which they already are.

## Actors

`locker.json` lists them: `rick` (human), `claude` (agent), `astra` (agent, Codex), `percept` (model, read only). `SL_ACTOR` must name one. The lease and every record carry the actor and a session id (`SL_SESSION`, or one id per clone kept in `.git/locker-session`).

## Migration

Nothing moves until all of these are true: Sim Locker has carried one Old Winds slice end to end (save, backup, review, accept) with the regression set passing; a plain `git clone` without Sim Locker still builds and passes regress; a restore from a second remote (a bare repo on a USB stick or a second host) has been done once. Projects move one at a time. Rollback is to stop using the tool: storage is git and records are files, so nothing is trapped. That promise is tested, not assumed.

## Size

v0.1 is under 1,500 lines of JavaScript, no build step, two runtime dependencies (the MCP SDK and nothing else if possible). **Rick**: that number is a proposal.

## What is deliberately not here

Content-addressed record ids (git already hashes blobs; records need stable ids plus revision digests, which the review records have). Effect-derived permission tables (one table of verbs and actors is enough for four actors). Hash-chained unknown registries. Process-group supervision. A web page (the page is `sl status`, and GitHub's own repo page for history).
