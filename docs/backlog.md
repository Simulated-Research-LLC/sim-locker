# Backlog

Findings from reviews that were not fixed in the slice that found them, with the reason, and polish nobody has taken yet. A row leaves when a slice fixes it (say which) or when Rick says to drop it. Review records under `locker/reviews/` hold the full findings; this file is the short list.

| found | what | why not yet | status |
|---|---|---|---|
| 0.2.3 review | STALE REVIEW stays in `status`, with exit 2, after a new review is saved; it clears at accept | wording only; the new review is listed below it | open |
| 0.2.3 review | NO REMOTE TRUTH's fix line says `sl backup`, which is refused DIRTY in the state `init` leaves (locker.json unsaved); the CONFIG FROM WORKING TREE line below carries the full fix | two problems that always co-occur; one line could carry both steps | open |
| 0.2.3 review | some jargon is left in messages: "the remote refused the push", "the local merge was undone", "after the push the remote" | each is true and the codes are stable; a pass over every message is its own slice | open |
| 0.2.3 review | LEASE HELD is a PROBLEM even for the session that holds it, and the fix tells the holder to wait for itself | pre-existing; needs a "your lease" wording | open |
| 0.2.3 review | the "reviewed" step in `status` mirrors accept's add-only rule for one review-only save; a trailing-file save after the review reads as "not reviewed" | `status` would need the accept.trailing patterns; cheap, not done | open |
| 0.2.4 review | a modify/delete conflict during `sl update` left no textual mark: with nothing else touched the update was stuck ("nothing to save"), with something else touched `sl save` kept the slice's copy silently | fixed in 0.2.5: `update`, `status` and the next step name the file as changed on one side and deleted on the other, keep it or delete it; a save during an update is never "nothing to save". A binary conflict is still a one-sided-style entry with no mark and is reported the same way | done, 0.2.5 |
| 0.2.5 review | a `=======` line that is content (a Markdown underline) in a file the update touched read as a mark, and the update could never be finished | fixed in 0.2.5 before acceptance: a mark counts only when neither parent's copy has the line | done, 0.2.5 |
| 0.2.5 review | `status` counted a file settled in the editor but not yet added as still to settle, while `save` took it | fixed in 0.2.5 before acceptance: the unstaged view counts a both-changed file only while its copy holds a mark | done, 0.2.5 |
| 0.2.5 review | settling by keeping the slice's side made `save` say "nothing to save" and left the update waiting for good | fixed in 0.2.5 before acceptance: a save during an update always finishes it, with two parents | done, 0.2.5 |
| 0.2.4 review | the MCP tools had no tests | fixed in 0.2.5: `test/mcp.test.js` over the in-memory transport | done, 0.2.5 |
| 0.2.4 review | `status` did not scan for marks, so a staged marked file read "settled but not yet saved" while `save` refused | fixed in 0.2.5: `status`, `save` and `update` share `unsettled()` | done, 0.2.5 |
| 0.2.4 review | `sl save` with paths that leave the conflicted file out, or `--slice` during an update, was a raw git error | fixed in 0.2.5: refused as UPDATE_CONFLICT before anything moves | done, 0.2.5 |
| 0.2.4 review | `git clean -fd` on the failed-squash path removed empty untracked folders | kept as it is: the tree had nothing untracked before the squash (DIRTY refused), so what `clean -fd` removes is the squash's own debris; `clean -f` was tried in 0.2.5 and left debris in new folders, which made the checkout back to the slice fail (0.2.5 review, blocking) | closed, no change |
