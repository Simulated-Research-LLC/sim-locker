# Brief for Astra (Codex): adversarial review of Sim Locker, then adoption

You are reviewing a tool, not helping build it. Assume it is wrong somewhere and find where. Read the code, run the tests, break it with real git. Do not take `README.md` or `DESIGN.md` as evidence of anything; they are claims. Report with file:line and with the command that showed the problem.

Written for 0.1 on 2026-10-12; brought up to 0.2.12 on 2026-10-14. Two Claude reviewers have already run most of the attacks below (`docs/review-0.1.md`, and the rerun recorded in the 0.2.7 review record `locker/reviews/rev_e819d8ef54b2.json`); the point of your run is a different pair of eyes and a different harness.

## What it claims

Sim Locker is git plus a thin record layer. It promises:

1. It refuses to work in a folder that is not a managed clone (`UNMANAGED`) or whose truth branch is behind the remote (`STALE`).
2. Agents cannot write to the truth branch except through `accept`, which needs a review record of exactly the slice's range, by a different actor, the lease, a clean tree, and a two-step confirm token; the saves after the reviewed head are judged one by one and may only add review records or change the project's trailing files.
3. One writer on the truth branch at a time: a lease in `refs/heads/locker/lease` with a TTL, taken by compare-and-swap (`--force-with-lease`).
4. It never force-pushes anything else.
5. "backed up" means fetched back and compared, not "push exited 0".
6. Every record and every piece of state is a plain file or a git ref; a plain `git clone` without the tool has the whole project (`sl drill` proves it from a second remote).
7. The actor on every commit, lease and record comes from the environment, never from a payload or a tool argument.
8. A slice that collides with the truth branch is refused, not half-merged (`ACCEPT_CONFLICT`); `sl update` brings the truth branch into a slice and leaves lines both sides changed for a person to settle; `sl save` refuses while marks are left (`MARKERS_LEFT`).
9. `sl status` says what to do next for every problem, and never calls a slice "reviewed" when `accept` would refuse it.
10. `sl history` says who did what on the truth branch from the trailers and the records, and names a save with no trailer as made outside the tool.

## Where to attack

- `src/locker.js:accept`. Can a slice reach `main` without a passing review of its full range? Try: a review of an older head followed by a save that touches `locker/reviews/` and something else; a record edited after it was saved (0.2.7 refuses this; find a way around `savesAfter`); a record edited in the same save that added it (accepted today, an open question); a review whose `from` is not the merge base; a rebased slice; an `sl update` after the review; two slices with the same name from two clones; a trailing file that is also cited.
- The lease. Two processes acquiring at once against the same bare remote. An expired lease taken while the old holder is mid-accept during a slow gate. A copied `SL_SESSION` (documented as the same trust class as `SL_ACTOR`; say what it allows). A remote that rejects pushes to `refs/heads/locker/*`.
- Staleness. `freshen` reads the time written in `.git/locker-fetched`. A wrong clock, a huge `maxAgeSeconds`, a fetch of another remote in between.
- The confirm token. One clone's token in another; one operation's token on another with the same arguments.
- `sl update` and the merge-in-progress state. Can a settled merge save put anything on `main` or bypass a review? Marks left in a file whose parents hold a `=======` line; a modify/delete; a binary; a record file both sides changed (the driver's keyed marks); a side the driver cannot read; `save` with paths or `--slice` mid-update.
- `status`'s "reviewed" step against `accept`'s rule: a record renamed in, a record modified then re-added, a record only on disk, a save with two parents, a cited trailing file changed.
- `sl drill`: does it push anything to the real remote? `--dir` inside the working tree, non-empty, a file; a shallow clone; a hung test command.
- `sl history`: a crafted subject or trailer (bytes 0x00, 0x1e, newlines), a hand-typed `Locker-*` trailer, an acceptance trailer with no record behind it, bad counts.
- The merge driver. Nested keys, arrays, a key deleted on one side and changed on the other, frontmatter with `---` inside a value, CRLF files, a file that is valid JSON on one side and broken on the other.
- Identity. Commits are made with `user.name=<actor>` and `user.email=<actor>@simlocker.local`. Does that break anything downstream?
- The MCP server (`test/mcp.test.js` shows the shape). Does any tool argument reach git unescaped? Can `paths` on `save` escape the work tree? Can `slice` be `main` or `refs/...`? Can an argument name an actor?
- Windows. The suite runs on windows-latest in CI; run it on a real PowerShell: `simlocker` (since `sl` is Set-Location), paths with spaces, the gate's `taskkill`, the merge driver line `init` writes.
- The promise in `README.md` "What is tested". Run the tests. Then check whether each clause there is backed by an assertion, not just by a test name.

## How to report

One file, `docs/review-astra-<version>.md`, in this repo on a slice, with: findings ranked by severity, each with file:line and the reproducing command; a list of claims in `README.md` and `DESIGN.md` you could not verify; and your verdict (`pass`, `fix`, `block`) in the form `sl review` would want, written as the `astra` actor (`SL_ACTOR=astra sl review main..<slice> ...`). Do not fix anything in the same change; a review that also edits the code is reviewing itself.

## After the review, if the base holds

Adopt it for the Codex projects, one at a time, in this order and not before each gate passes:

1. `sl clone` the project fresh. Do not `sl init` an existing working folder with uncommitted work.
2. Add `astra` and your other actors to `locker.json` if they are not there, and save that with `SL_ACTOR=rick` on the truth branch.
3. Run one real slice through `save`, `backup`, `review`, `accept` with your own regression or test set passing on the accepted result.
4. `sl drill` the result: a plain clone from a second remote, with no Sim Locker installed, builds and passes.
5. Only then stop using raw git for that project. Keep the old folder until the first accepted slice, then move it aside; never delete it in the same week.

If a gate fails, stop, write it in the review file, and do not move the next project.
