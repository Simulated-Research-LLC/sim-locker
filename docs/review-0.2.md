# Adversarial rerun of the attack lists against 0.2.6, 2026-10-14

Reviewer: a fresh-context agent on the session's model (configured claude-fable-5-1), following `docs/review-0.1.md`, `docs/audit-0.1.md` and `ASTRA_BRIEF.md` "Where to attack", against main 099c28d (0.2.6), after the 0.2.3 to 0.2.6 changes to accept, save, status and the lease. The report is kept as it was written, with the fix status added in brackets; the fixes are 0.2.7 (`locker/reviews/rev_e819d8ef54b2.json` is the same reviewer's record of the fixed branch) and 0.2.8.

## Findings

1. **Blocking. A committed review record can be rewritten in a later save and accept does not see it; REVIEW_BLOCKS is defeatable by the acceptor.** accept's "only adds under locker/reviews/ after the reviewed head" rule was a two-dot tree diff (`git diff --name-status --no-renames range.to..head`). Between the reviewed head (where the record did not exist) and the slice head the record always showed as `A`, however many times it was edited in between. So the hole in CLAUDE.md's open question ("the acceptor can rewrite a reviewer's verdict before the record's first commit") was wider than stated: the rewrite worked after the first commit too, with a plain `sl save`. Command: `sl review --verdict fix` by astra, saved and backed up; `sed -i 's/"fix"/"pass"/'` on the record; `sl save -m "tidy the record"`; lease; accept with the record's id: `accepted: true`. Repeated with block to pass: token issued. `sl status` for the same head said "backed up, not reviewed" (its walk-back was per commit), so status and accept disagreed, status the stricter. [fixed in 0.2.7: `savesAfter` judges each save in range.to..head on its own, shared by accept and status; an edit or removal of a record is a change; test "the attacks of 2026-10-14"]
2. **Material. A conflict in a record file (the merge driver's keyed marks, or a driver failure) was not seen by `unsettled`**, so UPDATE_CONFLICT came back with an empty reason, status said "an update is settled but not yet saved", MARKERS_LEFT never fired, and `sl save` saved the conflict as content. A record one side left as broken JSON made the driver throw; git kept ours; `sl save` saved ours and main's side was dropped without a word. [fixed in 0.2.7: the keys `"<<<<<<< ours"` and `">>>>>>> theirs"` count as marks; a both-changed unmerged file with no mark whose copy is still HEAD's is named as "changed on both sides and not merged"; test]
3. **Material. NAME_TAKEN was checked only against the local `refs/heads/done/<slice>`**, so a used slice name was accepted again from any other clone, and the second slice's history was then not kept on the remote (`keptOnRemote: false`). [fixed in 0.2.7: the remote's `done/<slice>` is asked at accept and at `save --slice` for a new name; tests in 0.2.7 and 0.2.8]
4. **Material (by design; stating what it allows). The lease is not a secret and `mine` is only a string match.** `sl lease status` shows the holder's session; a clone that sets `SL_SESSION` to it accepted under the holder's lease. The same trust class as `SL_ACTOR=rick`. [documented in README's lease paragraph, 0.2.7]
5. **Polish. `sl status` said "reviewed" for a record that existed only in the working tree** (hidden with `.git/info/exclude`): status read records from disk, accept from the head. [fixed in 0.2.7: status and staleReviews read records at HEAD; test]
6. **Polish. A remote that rejects pushes to refs/heads/locker/* made `sl lease acquire` say LEASE_RACE.** [fixed in 0.2.7: PUSH_REFUSED naming the branch when the remote lease is unchanged]
7. **Polish. When accept was started from the slice and failed at the last look, the folder was left on main.** [fixed in 0.2.7; tested in 0.2.8 with a 3 s lease, a 4 s gate and another session taking the lease during it]
8. **Polish. A refused save with `--slice <new>` had already created and checked out the new branch; `sl review slice/x..main` wrote a record with from == to and `cited: {}`.** [fixed in 0.2.7: BAD_PATH before the checkout; BAD_RANGE for a review of nothing]
9. **Polish. "a new slice starts from the remote's main" is only as fresh as the last fetch.** [wording "as last fetched", 0.2.7]

## Attack by attack

| attack (source) | result at 0.2.6 |
|---|---|
| C1 save --slice HEAD / main / refs/heads/main / origin/main / heads/main / ../main / main.lock / -b / --force / done/x / slice/ (review, brief) | held: BAD_SLICE for all, branch stays main |
| C2 edit working-tree locker.json kind to human; also committed on local main (review) | held: AGENT_ON_TRUTH, configFrom origin/main |
| C3 record not committed; hidden by info/exclude; self review (review) | held in accept: DIRTY / NO_REVIEW / REVIEW_SELF; status misled on the hidden one (finding 5) |
| C4 agent revert on main (review) | held: AGENT_ON_TRUTH |
| SL_ACTOR=mallory; GIT_AUTHOR_NAME=rick (review, L1) | held: NO_ACTOR; commit stamped claude |
| H1 rename README.md into locker/reviews/ after review (review, brief) | held: REVIEW_STALE "D README.md" |
| H2 lease across CLI calls without SL_SESSION | held (session file) |
| H3/H4 fetch and backed-up proof | held: backup verifies by ls-remote; PUSH_REFUSED when main moved |
| M1 lease expires and is taken during a 4 s gate; remote main moves during the gate (review, brief) | held: NO_LEASE / reset to origin/main, nothing half done, remote main untouched |
| M2 reused slice name (review) | broke across clones (finding 3); held within one clone |
| M3 stale review cleared by accept | held (suite) |
| L3 confirm token from another clone; token reused for revert (review, brief) | held: BAD_CONFIRM both |
| mixed commit: record plus game.js after review (brief) | held: REVIEW_STALE "M game.js" |
| record edited after its commit (brief) | broke (finding 1) |
| record edited before its first commit (CLAUDE.md open question) | accepted, as documented |
| forged record from nothing, reviewer rick (brief) | accepted (same trust class as SL_ACTOR; records are trusted as written) |
| review whose from is not the merge base: rebase after review; `sl update` after review (brief, audit 11) | held: REVIEW_RANGE both |
| sl update: pushes anything? | held: ls-remote identical before and after |
| sl update settled with an extra file slipped into the settling save | held: the next review's diff and cited list include it |
| NEVER_TRAILING through update's merge then accept | held: an update after the review forces REVIEW_RANGE; a review after the update covers main..head |
| MARKERS_LEFT / merge in progress: save --slice other, save with paths, plain save with marks, raw `git checkout main` during the conflict, human save on main with MERGE_HEAD | held: UPDATE_CONFLICT, UPDATE_CONFLICT, MARKERS_LEFT, git refuses the checkout, MARKERS_LEFT |
| record-file conflict through update, then save (brief, merge driver) | broke (finding 2) |
| merge driver: nested keys, arrays, delete vs change, `---` in a frontmatter value, broken JSON one side, top-level array | nested and array conflicts kept whole-key (documented L5); delete vs unchanged deleted correctly; `---` in a value fine; broken JSON and array throw (finding 2 follows) |
| stale main, dirty, save --slice new (0.2.3 rule) | held: slice from origin/main or local main, main never moves; wording (finding 9) |
| status walk-back: trailing file also cited; cited trailing file renamed; new trailing file; hidden record | held, held (STALE REVIEW and REVIEW_STALE agree), reviewed and accepted by design, status wrong (finding 5) |
| lease mine with copied SL_SESSION in a second clone | accepts under the other's lease (finding 4) |
| sl drill pushes to the real remote? --dir inside the work tree | held: ls-remote identical; --dir inside the tree leaves an untracked folder when --keep |
| lease race, 6 clones, 3 rounds | held: exactly one "acquired" per round, the rest LEASE_RACE or LEASE_HELD, remote holder matched the winner each time |
| remote rejects refs/heads/locker/* | works as a refusal, wrong code (finding 6) |
| option-shaped args: review main..--all, main..--output=x, revert --all, revert -h, live --output=x, accept --all; paths ../B/README.md and /etc/hostname | held: BAD_RANGE / BAD_COMMIT / NO_LIVE / BAD_SLICE; git refuses paths outside the tree; no file written |
| maxAgeSeconds huge | human save on a stale main proceeds without a fetch, backup then PUSH_REFUSED (by design) |

## What held up

Slice name validation and the re-read of the branch after checkout; the remote's locker.json ruling; AGENT_ON_TRUTH for save and revert; records read from the head at accept; self-review refused; rename into locker/reviews/ refused; mixed commits after the reviewed head refused; rebase and `sl update` after a review both forcing a new review; cited blobs catching a changed or renamed trailing file in both status and accept; the lease compare-and-swap under six racing clones in three rounds; the lease and remote-main re-check right before the push, with the truth branch left exactly where the remote has it; confirm tokens bound to clone, actor, session and arguments; `update` and `drill` pushing nothing to the real remote; the merge-in-progress state refusing partial saves, slice switches and saves with line marks; option-shaped arguments never reaching git as options; paths unable to leave the work tree.

Not reproduced then: a wrong clock (fixed in 0.2.8 anyway: the stamp's own time, a future time counts as never fetched), and the raw-git / SL_ACTOR=rick paths, which only branch protection stops.
