# Sim Locker: for the agents working in this repo

Read `README.md` for what it does and `DESIGN.md` for why. This file is the working rules. `CLAUDE.md` is this file under the name Claude Code reads.

## Rules

1. Node 22, no build step, two runtime dependencies. If a change needs a third, say why in the change message.
2. Under 1,500 lines of JavaScript across `src/` and `bin/`. `npm run lines` counts. Over that is a design problem, not a formatting one.
3. Everything the tool knows is a plain file in the repo or a git ref. No database, no server, no state a plain `git clone` loses.
4. The actor comes from `SL_ACTOR` in the environment. Never from a tool argument, a payload or a file.
5. No force-push anywhere except the compare-and-swap on `refs/heads/locker/lease`. `grep -n force src/` should show only that line and the `force` option of `freshen`, which means "fetch now", not a force-push.
6. A refusal is a thrown `LockerError` with a stable code. Codes are listed in `README.md`; a new code is added there in the same change.
7. The push exit code is not evidence. After every push, fetch and compare refs.
8. Tests run against real git (`npm test`). A behaviour with no test is a claim, not a feature. Fakes of git are not accepted.
9. Writing: plain words, no em dashes, no filler. Git vocabulary (commit, push, merge) stays inside the code; the user-facing words are saved, backed up, accepted, live.

## Where things are

| path | what |
|---|---|
| `src/locker.js` | the core. `openRepo`, `actorFromEnv`, `freshen`, `lease`, `review`, `status`, `save`, `backup`, `pull`, `accept`, `revert`, `init`, `setLive`, `find` |
| `src/git.js` | `git(cwd, args, {input, allowFail})` and small helpers. `allowFail` returns null instead of throwing |
| `src/merge-record.js` | `mergeKeys`, `mergeJson`, `mergeFrontmatter`, `mergeRecordFiles` (the git entry point) |
| `src/mcp.js` | `buildServer(cwd)`: seven tools over the core |
| `docs/review-0.1.md` | the adversarial review of the first build and the fix status of every finding; the attack list to rerun after any change to `accept`, `save` or the lease |
| `bin/sl.js` | argument parsing and plain-text printing only; no logic |
| `bin/sl-guard.js`, `.github/workflows/guard-main.yml` | the tripwire on pushes to main: fails and opens an issue on a forced push or a commit that bypassed the tool |
| `test/*.test.js` | temp bare remote plus two clones |

## Working on it

```
npm install
npm test
node bin/sl.js --help
```

To try a change by hand, make a temp project: `git init --bare -b main /tmp/r.git`, clone it, add a first commit, push, then `sl init` in the clone with `SL_ACTOR=rick`.

## Open questions (Rick decides; defaults in force until then)

- Who may accept: default, any actor with a review record by a different actor and the lease. `reviewer` is the actor name for a fresh-context Claude reviewer; added 2026-10-12 so a slice can be reviewed and accepted without Rick, which is Rick's to keep or remove.
- Fields an agent may fix and accept without a review (links, version strings): default, none.
- Codex / Astra over MCP or CLI: both exist; the CLI is the fallback.
- Large binaries (screenshots, zips): default, nothing special; git LFS is the obvious next step if a project needs it.
- The 1,500-line budget: a proposal.
