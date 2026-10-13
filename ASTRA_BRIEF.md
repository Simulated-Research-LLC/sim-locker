# Brief for Astra (Codex): adversarial review of Sim Locker 0.1, then adoption

You are reviewing a tool, not helping build it. Assume it is wrong somewhere and find where. Read the code, run the tests, break it with real git. Do not take `README.md` or `DESIGN.md` as evidence of anything; they are claims. Report with file:line and with the command that showed the problem.

## What it claims

Sim Locker is git plus a thin record layer. It promises:

1. It refuses to work in a folder that is not a managed clone (`UNMANAGED`) or whose truth branch is behind the remote (`STALE`).
2. Agents cannot write to the truth branch except through `accept`, which needs a review record of exactly the slice's range, the lease, a clean tree, and a two-step confirm token.
3. One writer on the truth branch at a time: a lease in `refs/locker/lease` with a TTL, taken by compare-and-swap (`--force-with-lease`).
4. It never force-pushes anything else.
5. "backed up" means fetched back and compared, not "push exited 0".
6. Every record and every piece of state is a plain file or a git ref; a plain `git clone` without the tool has the whole project.
7. The actor on every commit, lease and record comes from the environment, never from a payload.

## Where to attack

- `src/locker.js:accept`. Can a slice reach `main` without a passing review of its full range? Try: a review of an older head followed by a commit that touches `locker/reviews/` and something else in the same commit; a review whose `from` is not the merge base; a review record edited by hand after it was written; two slices with the same name; a slice branch that was rebased after the review.
- The lease. Two processes acquiring at once against the same bare remote (write a shell loop). An expired lease taken while the old holder is mid-accept. A lease ref that exists on the remote but has never been fetched locally. A remote that rejects pushes to `refs/locker/*`.
- Staleness. `freshen` trusts the mtime of `FETCH_HEAD`. What happens when a different tool fetched a different remote? When the clock is wrong? When `maxAgeSeconds` is set to a huge value?
- The confirm token. It lives in `.git/locker-confirm.json`. Is a token from one clone usable in another? From one operation on another with the same arguments?
- `TWO CLONES`. The registry is `~/.simlocker/clones.json`. A clone made with plain `git clone` is not in it. Is that a hole the tool should close, or acceptable because the unregistered clone is `UNMANAGED` until `sl init`?
- The merge driver. Nested keys, arrays, a key deleted on one side and changed on the other, frontmatter with `---` inside a value, CRLF files, a file that is valid JSON on one side and broken on the other.
- Identity. Commits are made with `user.name=<actor>` and `user.email=<actor>@simlocker.local`. Does that break anything downstream (GitHub attribution, signing, hooks)?
- The MCP server. Does any tool argument reach git unescaped? Can `paths` on `save` escape the work tree? Can `slice` be `main` or `refs/...`?
- The promise in `README.md` "What is tested". Run the tests. Then check whether each sentence there is backed by an assertion, not just by a test name.

## How to report

One file, `docs/review-astra-0.1.md`, in this repo, with: findings ranked by severity, each with file:line and the reproducing command; a list of claims in `README.md` and `DESIGN.md` you could not verify; and your verdict (`pass`, `fix`, `block`) in the form `sl review` would want. Do not fix anything in the same change; a review that also edits the code is reviewing itself.

## After the review, if the base holds

Adopt it for the Codex projects, one at a time, in this order and not before each gate passes:

1. `sl clone` the project fresh. Do not `sl init` an existing working folder with uncommitted work.
2. Add `astra` and your other actors to `locker.json` if they are not there, and save that with `SL_ACTOR=rick` on the truth branch.
3. Run one real slice through `save`, `backup`, `review`, `accept` with your own regression or test set passing on the accepted result.
4. Confirm a plain `git clone` of the result, with no Sim Locker installed, builds and passes.
5. Only then stop using raw git for that project. Keep the old folder until the first accepted slice, then move it aside; never delete it in the same week.

If a gate fails, stop, write it in the review file, and do not move the next project.
