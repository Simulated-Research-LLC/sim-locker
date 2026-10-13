# Sim Locker: design

Version 0.1, 2026-10-12. Written after reading morluto/rea and NationalSecurityAgency/ghidra in full (notes: `docs/reading-rea-and-ghidra.md`) and an adversarial audit of the first draft (`docs/audit-0.1.md`). Everything marked **Rick** is a question he has not answered; the tool ships with the default stated and refuses nothing it does not have to.

## What it is

One tool, used by a person and by AI agents, that holds the truth for every project. Git underneath for storage and transport. Above it a thin record layer: four states, a source on every change, leases for the one branch that matters, reviews as files, and a `status` that tells the truth about where a folder stands.

It is not a new version control system, not a GitHub replacement for storage, and not a GUI. GitHub is a remote. Everything Sim Locker knows lives in the repo as plain files, so a bare `git clone` with no Sim Locker installed still gives a complete, working project.

## The four states

| state | means | who may trigger | evidence | command |
|---|---|---|---|---|
| saved | committed on the local slice branch, by the tool | any actor | the commit hash | `sl save` |
| backed up | that commit exists on the remote | any actor | after a fetch, the remote ref equals the local ref (the push exit code is not trusted) | `sl backup` |
| accepted | merged to the truth branch (`main`) | the actor holding the lease, after a review record exists for the exact range (**Rick**: may an agent accept, or Rick only? default: an agent may, with a review record and the lease) | the review record, the lease, a clean tree, and the truth branch not having moved since the fetch | `sl accept` |
| live | the accepted version is what people use | per project | declared in `locker.json`: `none` (a research repo), `url` plus the version the site reports, or `artifact` plus a digest | `sl live` |

Draft work (an editor's autosave, a crash snapshot) is below `saved` and is not a state. There is also a way down: `sl revert <commit>` makes a new saved change that undoes an accepted one; it does not rewrite history.

## The rules the tool enforces

1. **Refuse to work in an unmanaged or stale folder.** Every command first checks: is this a Sim Locker clone (has `.git`, has `locker.json`, has the expected remote)? If not: `UNMANAGED`, and nothing runs. Is the local truth branch behind the remote? If the last fetch is older than the configured age it fetches first; if it cannot fetch it says `NOT FETCHED` on the first line. Behind means `STALE`, and `save` and `accept` refuse. This is the failure of 2026-10-12 (a folder with no `.git`, 0.41.2 on disk while GitHub was at 0.41.6) made impossible.
2. **One writer on the truth branch.** A lease is a JSON object in the git ref `refs/locker/lease`, pushed with `--force-with-lease` so acquiring is a compare-and-swap: two actors cannot both win. It has an owner, a session id, an expiry (default 30 minutes), and is renewed by heartbeat. `accept` checks the lease. An expired lease can be taken by anyone, which is how an agent's lease dies with the agent without a server. (Ghidra's TRANSIENT checkout needs a live connection; a TTL is the git-shaped version of it.)
3. **No force-push, ever**, except the compare-and-swap on the lease ref, which cannot lose anyone's work.
4. **Source is stamped by the tool, never taken from the payload.** Every save records `actor` (from `SL_ACTOR`, required, one of the configured actors), `kind` (`human | agent | import`), and the session id. An agent changing a file that a human last wrote does not overwrite it in place on the truth branch: it lands on the slice branch, and the review record names it, so acceptance is the human-visible override. (Ghidra's SourceType priority is a convention among callers, not storage; this makes it structural without blocking the fixes agents are good at.) **Rick**: which fields may an agent fix and accept without a review (links, version strings)? Default: none.
5. **A review is a file.** `sl review <from>..<to>` writes `locker/reviews/<id>.json`: the exact commit range (from the merge base of the two, so `main..slice` means the slice's own commits even after `main` has moved), the reviewer actor, findings, and the blob hashes of every file it cites. `sl status` flags any review whose cited blob is no longer at `HEAD` as `STALE REVIEW`. `accept` needs a review whose range runs from the merge base to the slice head; because the record itself is then committed on the slice, the only commits allowed after the reviewed head are ones that touch `locker/reviews/` and nothing else.
6. **Nothing is destroyed; superseded work gets a name.** When a slice is accepted its branch is kept as `done/<slice>` (configurable to delete after N days). An abandoned slice is renamed `kept/<slice>`, never deleted by the tool. (Ghidra's `.keep` copies.)
7. **Two steps for anything long or destructive.** `accept`, `revert`, and any command marked `confirm` in `locker.json` print a one-time token on the first call and act only when called again with `--confirm <token>`. A single keystroke, or a cat, cannot start it.
8. **Status tells the truth.** `sl status` prints the problems first (`UNMANAGED`, `STALE`, `NOT FETCHED`, `TWO CLONES`, `STALE REVIEW`, `LEASE HELD BY`), then the four states for the current slice, then the lease. Two clones of one project on one machine is an error, not a choice (REA's "two usable candidates is an error").
9. **Records are rebuildable.** Any index the tool keeps is derived from the files in `locker/` and the git refs, and `sl status --rebuild` recreates it (Ghidra's index rebuild from property files).
10. **Sim Locker owns no state git cannot hold** and generates nothing a project already generates. Old Winds keeps `tools/old-winds.js`, its vault and its regression set; Sim Locker wraps the saving, backing up and accepting around them. If Sim Locker ever replaces a project's tool, it deletes that tool in the same change (Old Winds rule 2).

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

CLI only: `sl init` (make a folder managed), `sl clone`, `sl live`, `sl revert`, `sl migrate` (bring a project in), and every `--confirm`. Percept does not call tools; a script feeds it `status` output and reads back a yes/no. **Rick**: does Astra's Codex harness speak MCP in your setup? If not, every MCP verb is also a CLI command, which they already are.

## Actors

`locker.json` lists them: `rick` (human), `claude` (agent), `astra` (agent, Codex), `percept` (model, read only). `SL_ACTOR` must name one. The lease and every record carry the actor and a session id.

## Migration

Nothing moves until all of these are true: Sim Locker has carried one Old Winds slice end to end (save, backup, review, accept) with the regression set passing; a plain `git clone` without Sim Locker still builds and passes regress; a restore from a second remote (a bare repo on a USB stick or a second host) has been done once. Projects move one at a time. Rollback is to stop using the tool: storage is git and records are files, so nothing is trapped. That promise is tested, not assumed.

## Size

v0.1 is under 1,500 lines of JavaScript, no build step, two runtime dependencies (the MCP SDK and nothing else if possible). **Rick**: that number is a proposal.

## What is deliberately not here

Content-addressed record ids (git already hashes blobs; records need stable ids plus revision digests, which the review records have). Effect-derived permission tables (one table of verbs and actors is enough for four actors). Hash-chained unknown registries. Process-group supervision. A web page (the page is `sl status`, and GitHub's own repo page for history).
