# Backlog

Findings from reviews that were not fixed in the slice that found them, with the reason, and polish nobody has taken yet. A row leaves when a slice fixes it (say which) or when Rick says to drop it. Review records under `locker/reviews/` hold the full findings; this file is the short list.

| found | what | why not yet | status |
|---|---|---|---|
| 0.2.3 review | STALE REVIEW stays in `status`, with exit 2, after a new review is saved; it clears at accept | wording only; the new review is listed below it | open |
| 0.2.3 review | NO REMOTE TRUTH's fix line says `sl backup`, which is refused DIRTY in the state `init` leaves (locker.json unsaved); the CONFIG FROM WORKING TREE line below carries the full fix | two problems that always co-occur; one line could carry both steps | open |
| 0.2.3 review | some jargon is left in messages: "the remote refused the push", "the local merge was undone", "after the push the remote" | each is true and the codes are stable; a pass over every message is its own slice | open |
| 0.2.3 review | LEASE HELD is a PROBLEM even for the session that holds it, and the fix tells the holder to wait for itself | pre-existing; needs a "your lease" wording | open |
| 0.2.3 review | the "reviewed" step in `status` mirrors accept's add-only rule for one review-only save; a trailing-file save after the review reads as "not reviewed" | `status` would need the accept.trailing patterns; cheap, not done | open |
| 0.2.4 review | a modify/delete or binary conflict during `sl update` leaves no textual mark, so `sl save` after `git add -A` would save the half state silently | needs a check on the merge's unmerged entries before `add -A`; `unsettled()` is where it goes | open |
| 0.2.4 review | the MCP tools had no tests | fixed in 0.2.5: `test/mcp.test.js` over the in-memory transport | done, 0.2.5 |
| 0.2.4 review | `status` did not scan for marks, so a staged marked file read "settled but not yet saved" while `save` refused | fixed in 0.2.5: `status`, `save` and `update` share `unsettled()` | done, 0.2.5 |
| 0.2.4 review | `sl save` with paths that leave the conflicted file out, or `--slice` during an update, was a raw git error | fixed in 0.2.5: refused as UPDATE_CONFLICT before anything moves | done, 0.2.5 |
| 0.2.4 review | `git clean -fd` on the failed-squash path removed empty untracked folders | fixed in 0.2.5: `clean -f`, files only | done, 0.2.5 |
