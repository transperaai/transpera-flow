# Client capacity app: build briefs

Written 31 Oct 2026. The work packages are in `docs/plans/client-build-handover.md`; decisions D1–D37 are in
`docs/plans/client-requirements.md`.

## Shared rules for every builder

**Read first:**
- `CLAUDE.md` and `apps/web/AGENTS.md`;
- the handover above;
- "How to work in this repo" in `docs/plans/client-refocus-handover.md`;
- your own brief.

`docs/plans/builder-brief.md` still applies for wording, (i) help, migrations and tests, with three exceptions:
- there are no GitHub tickets;
- there are no production apply files (the database is Neon now; the orchestrator applies migrations);
- the Postgres start command is the one below.

**Branches.** The integration branch is `claude/relaxed-babbage-51ysen`. You work in your own git worktree, on the
branch your brief names. **Commit after every chunk** (a container restart kills agents; committed work survives). Do
not push and do not open a PR: the orchestrator reviews and merges your branch. **Never** commit the client's
transcripts or extracts.

**Tests.** Start Postgres with `pg_ctlcluster 16 main start`. Then run:

```sh
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
```

- **Known noise:** `apps/web/test/format.test.ts` always fails in this container (an ICU difference), and timing tests
  can time out under load. Re-run those alone before reporting.
- Never skip, loosen or delete a test to get green. A test that covers removed code goes with the code.

**Generated files.** Other packages run in parallel, so `db-types.ts`, the seed and the bootstrap will conflict. Run
`gen:types` / `gen:seed` / `gen:bootstrap` and commit their output anyway. The orchestrator regenerates them on merge.

**Wording.** Plain English, copied from the prototype `docs/prototypes/client-capacity-app.PROTOTYPE.html` where it
has a screen. Use they/them in docs. The prototype is a reference only: never import from it.

**If the code doesn't match your brief, stop and say so in your report; don't guess.** Every open question in a
brief has a default: use it.

**Report back** (your final message) with:
- the commits;
- what you built, against each numbered item;
- anything you skipped or found different from the brief;
- the test commands and their results.

## Packages in flight

| Brief | Branch | Migration versions |
|---|---|---|
| `p0-cuts-brief.md` | `claude/cap-p0-cuts` | `20270118000000`–`20270118009999` |
| `p1-setup-brief.md` | `claude/cap-p1-setup` | `20270119000000`–`20270119009999` |
| `p23-interface-brief.md` | `claude/cap-p23-interface` | none (engine types only) |
