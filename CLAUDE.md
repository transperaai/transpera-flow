# Transpera Flow (transpera-flow)

Multi-tenant process-map simulator: discrete-event Monte Carlo engine, React Flow canvas, Neon (Postgres), Better Auth, MCP server. The product spec and decision log live in `docs/PRD.md`; read the relevant sections before working on a ticket.

## Agent skills

### Issue tracker

GitHub Issues on `transperaai/transpera-flow`; milestone parent issues with tracer-bullet sub-issues and `Blocked by` lines. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root, created lazily. See `docs/agents/domain.md`.

## Working in this repo

- pnpm monorepo: `apps/web`, `packages/engine`, `packages/db`, `packages/mcp`. See `README.md`.
- Database: Neon Postgres (Sydney) through Kysely and a `pg` pool; sign-in is Better Auth (Google). Apply migrations with `pnpm --filter @transpera-flow/db migrate` (needs `DATABASE_URL`, the owner). Ad hoc SQL: `bash packages/db/scripts/db-sql.sh -c "select 1"`. After changing a table or function run `pnpm --filter @transpera-flow/db gen:types` (writes `db-types.ts`, `json-columns.ts` and `function-types.ts`).
- Run `pnpm lint && pnpm typecheck && pnpm test` before pushing; database tests need Postgres at `DATABASE_URL`.
- `apps/web` uses Next.js 16: read `apps/web/AGENTS.md` and the bundled docs before writing Next code (e.g. `proxy.ts`, not middleware).
- Anything verified only against plain Postgres rather than Neon goes in `docs/supabase-notes.md`.
