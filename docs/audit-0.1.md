# Adversarial audit of the Sim Locker draft, 2026-10-12

The first draft was a ten-point list written straight after reading REA and Ghidra (`docs/reading-rea-and-ghidra.md`, last section). This audit took it apart before any code was written. Each finding says what was wrong and what the design now does about it.

## Findings

**1. Slogans instead of decisions.** "Four states, named once" and "records are content-addressed" are goals, not designs. Nothing said which command moves a project between states, what evidence each state rests on, or who may trigger it. Now: the state table in `DESIGN.md` has a column for each of those, and `src/locker.js` implements exactly that table.

**2. The stale-copy failure was not actually prevented.** The failure that started this (a `Documents\Old Winds` folder at 0.41.2 with no `.git`, while GitHub was at 0.41.6) was addressed by renaming states, which does nothing to a folder nobody checks. Now: every command opens the folder first and refuses `UNMANAGED` (no `.git`, no `locker.json`, no configured remote) and `STALE` (truth branch behind the remote after a fetch). A folder that cannot be fetched says `NOT FETCHED` on the first line instead of pretending.

**3. "Four states" needs transition rules, evidence and a per-project `live`.** `live` means a different thing for a game on a web host, a research repo and a tool. Now: `locker.json` declares `live` as `none`, `url` or `artifact`; `sl live` is refused on `none`; `backed up` is proven by fetch and compare, never by the push exit code.

**4. A self-declared source is forgeable.** Taking `source: human` from the payload lets an agent write human. Ghidra's `SourceType` is a convention among callers, not storage, and it only works because all the callers are Ghidra's own. Now: the actor is stamped by the tool from `SL_ACTOR`, which must be one of the actors in `locker.json`; agents cannot save on the truth branch at all; acceptance after a review is the only path there.

**5. The minimum safety set.** The draft listed ideas; it did not say which few rules, if dropped, make the tool pointless. Now, in order: refuse unmanaged and stale folders; a single-writer lease with a TTL; no force-push; a two-step confirm token for accept and revert. Everything else is a convenience.

**6. The minimum tool surface.** Ninety-four tools (REA) is the wrong model for four actors. Now: seven MCP verbs (`status`, `save`, `backup`, `review`, `accept`, `lease`, `find`); the rest CLI only.

**7. Migration had no preconditions.** "Everything will be moved there" with no gate is how projects get trapped in a half-adopted tool. Now: nothing moves until one Old Winds slice has gone end to end through the tool with the regression set passing, a plain `git clone` without the tool still builds and passes, and a restore from a second remote has been done once. Projects move one at a time.

**8. Sprawl.** The draft could grow into a second REA. Now: under 1,500 lines, no build step, two dependencies, and a rule that if the tool ever replaces a project's own script it deletes that script in the same change.

**9. Corrections to the reading notes.** REA's Evidence authentication (hash recomputed on parse) is integrity, not provenance; it proves the record was not changed, not who wrote it. Ghidra's `MergeUtilities` works per address set, not per field, and the notes said field. Ghidra's "hijack" is a checkout whose server-side record was lost, not a revocation; the `.keep` file is the related case. The notes were corrected where they were wrong and these points are carried here so they are not lost.

## What the build then found

Two more things turned up when the code met real git in the tests, and belong in this record:

**10. A review record that lives in the repo changes the head it reviewed.** Committing `locker/reviews/<id>.json` on the slice moves the slice head past `range.to`, so a literal "review covers the head" check can never pass. Rule adopted: commits after the reviewed head may touch only `locker/reviews/`; anything else is `REVIEW_STALE`. The record's blob hashes still catch a cited file changing.

**11. "main..slice" is not what a person means by it.** When `main` has moved since the slice began, `main..slice` in git terms starts at today's `main`, not at the slice's base. The review range now starts at the merge base of the two, which is also what `accept` compares against.

## Not resolved here

Who may accept, which fields an agent may fix without a review, whether Astra's harness speaks MCP, large binaries, and the size budget are Rick's calls and are marked **Rick** in `DESIGN.md`.
