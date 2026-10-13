# Adversarial review of Sim Locker 0.2.0 (commit 0a7ca4c), 2026-10-13

Reviewer: a fresh-context Opus agent in a cloud session that had not written the code, following `ASTRA_BRIEF.md`. Method: ran `npm test` (17/17 pass), drove the full flow (`save`, `backup`, `review` by a different actor, `lease acquire`, the project gate, the two-step confirm, `accept`) against a real bare remote with a project gate configured, and read the new 0.2 surface (`accept.gate` and `accept.trailing`) against `docs/review-0.1.md` so fixed findings are not re-reported.

Verdict: **pass with findings.** No new critical or high. Every 0.1 critical and high fix still holds. There are two findings worth acting on, both medium, one verified with a proof of concept and one already recorded as open in `CLAUDE.md`, plus one low config footgun. The tool's stance, make the honest path easy and the dishonest path visible, is intact.

## Medium

- **M1 (new, verified) The accept gate runs slice-controlled code with the acceptor's full environment.** `runGate` (`src/locker.js:100`) checks out the slice head in a detached worktree and spawns the project's gate command there with `env: { ...process.env, SL_ACTOR, SL_SESSION, SL_GATE_COMMIT }` (`src/locker.js:109`). The gate command is trusted (it comes from `locker.json` on the remote truth branch, which an agent cannot set in its own slice), but the files it runs are the slice's, which is exactly the thing under review. A proof of concept drove a real `accept` where the project gate was `node gate.js` and the slice's `gate.js` wrote `process.env` to a file: it captured `SL_SECRET=LEAKED-swordfish-7f3a` out of the acceptor's shell. So a slice that passes review but whose gate-executed code is hostile, or a reviewer who misses it, runs with whatever the acceptor's shell holds: GitHub tokens, an SSH agent socket, cloud credentials. Recommendation: run the gate with a curated environment (PATH, HOME, the platform basics and the `SL_*` variables), dropping the rest, and document which variables a gate may rely on. Tradeoff: a gate that genuinely needs an unusual variable has to have it allowlisted, which is the point.

- **M2 (known, recorded in `CLAUDE.md`) A single dishonest acceptor can forge a passing review by another actor.** `accept` reads the review from the slice head with `committedReview` (`src/locker.js:417`) and trusts whatever is committed. The only authorship check is `REVIEW_SELF` (`src/locker.js:446`), which refuses only when `r.reviewer` equals the acceptor's own name. Because the review record is just a file, and in practice the acceptor is often the one who commits it on the slice, the acceptor can write a record that names a different actor as reviewer with `verdict: "pass"`, commit it, and accept it. No second party is needed. This is the biggest remaining integrity gap, and it sits above a footgun because one actor alone can do it. `CLAUDE.md` already lists the two fixes: reviewers commit their own records from their own session or clone (then the review commit's committer or actor trailer names the reviewer, and `accept` can check it matches `r.reviewer`), or records carry a signature. Until then the records are trusted as written, which is honest but worth closing.

## Low

- **L1 (new) `accept.trailing` has no breadth limit.** `checkConfig` (`src/locker.js:43`) blocks trailing patterns that cover the protected paths (`locker.json`, `locker/`, `.gitattributes`, `.github/`, the guard), but it does not block a broad pattern like `**` or `src/**`. A project whose `locker.json` set such a pattern would let any matching file change after the reviewed head and reach the truth branch unreviewed (`src/locker.js:454`). The config lives on the truth branch and a change to it is itself review-gated, so this is a human or review mistake, not an agent attack, which is why it is low. Recommendation: cap trailing to record-shaped files (for example `*.json` and `*.md` outside code directories), or warn when a pattern could match code.

## What held up (verified this pass)

- `npm test`: 17 of 17 pass against real git.
- The full accept path works end to end: a slice saved by an agent, backed up, reviewed by a different actor, the lease acquired, the project gate run on a detached worktree of the slice head, the two-step confirm token, the squash merge, the verify-by-`ls-remote`, and the slice kept as `done/<slice>`.
- The config that rules at `accept` is re-loaded from the remote truth branch after the fetch and refused if it is not there (`src/locker.js:432`); the working-tree copy cannot promote a clone.
- The lease is re-checked, together with the remote truth ref, immediately before the only push that matters, and the local merge is reset if either moved (`src/locker.js:476`).
- No force-push anywhere except the lease compare-and-swap.
- The add-only rule after the reviewed head allows only an added `locker/reviews/rev_<12hex>.json` or a configured trailing file, and a modify of a review file is refused (`src/locker.js:452`).

## Attack list to rerun after any change to accept, the gate, save or the lease

The 0.1 list in `docs/review-0.1.md`, plus: a slice whose gate reads or writes the acceptor's environment; an `accept.trailing` broad enough to carry code; a review record forged under another actor's name and accepted by a single actor.
