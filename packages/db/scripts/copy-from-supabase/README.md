# Copying Supabase into Neon (step 7a)

Three scripts, run from the repo root with `pnpm --filter @transpera-flow/db <script>`. Arguments follow the script name, with no `--`.

| Script | What it does |
|---|---|
| `copy:export` | Reads the Supabase database (migration row 72) into a directory of JSON files, and downloads the public `branding` logos. Read-only. |
| `copy:import` | Loads an export into a database already at the current head, in **one transaction**. Nothing is written if anything fails. |
| `copy:verify` | Compares the target with the export: row counts, every exported row's values (compared in SQL from the file's own text), the Better Auth copies, access rules, logos, sequences, triggers, and a full check of every foreign key. Exits 1 on any problem. |

The export directory holds real people's data. It must be **outside the repo** (`export.ts` refuses a path inside it), is created `0700`
with `0600` files, and is deleted when the cutover is done (`rm -rf <dir>`).

## Before you start

- `SUPABASE_ACCESS_TOKEN` is in the environment (never typed into a command line or printed). It needs read access to the project's database.
- `DATABASE_URL` is the Neon **owner** connection of the target (the direct, unpooled host if there is one), also from the environment.
  `import.ts` and `verify.ts` read it when `--url` is not given; prefer that to `--url`, which shows in the process list.
- From the cloud container, where Neon's port 5432 is closed, add `--driver neon-ws` to `copy:import` and `copy:verify`: they then
  connect through `@neondatabase/serverless` over a WebSocket (through `HTTPS_PROXY` when it is set), on one connection, so the
  single transaction is the same. The migrations need the same route (docs/supabase-notes.md, "Checked on Neon").
- The target is at the current head and holds **no data**: `pnpm --filter @transpera-flow/db migrate` first. The import refuses a target
  that has rows in any table it copies. `deployment_access` may hold rules (a rule for an email the users have keeps its role), and
  their audit rows are allowed. A target someone has already signed in to has `auth.users` rows: use a fresh branch, not that one.
  **Neon `main` is the Preview database**, so by cutover it holds whatever QA wrote (Austin's own sign-in at least), and the import
  will refuse it: decide before the freeze how `main` is emptied (a new branch from before any sign-in, made the default, or a
  drop-and-migrate of `main`) and rehearse that too.
- The import locks every table it writes (`lock_timeout` 15 s) and checks again, inside its transaction, that they are empty, so a
  preview signing someone in at the same moment fails the import instead of mixing with it.

## 7b. Rehearsal on a Neon branch

A branch of `main` carries `main`'s data (Preview QA), which the import refuses, so the rehearsal imports into a **new, empty
database** on a throwaway branch. From the cloud container every database command takes `--driver neon-ws`; secrets come from
private files (0600, in the session's scratch directory, never in the repo) and are never echoed.

```sh
export OUT=$HOME/transpera-copy/rehearsal           # outside the repo; must not exist or be empty
SCRATCH=/path/to/the/session/scratchpad             # private (0700): holds the URL and token files
D=--driver=neon-ws                                  # drop it on a machine that reaches Neon over TCP

# 1. Neon API (key from a private file): branch `rehearsal` from `main`; on it, database `copy_rehearsal` owned by
#    neondb_owner; then its owner connection URI (`/projects/{id}/connection_uri?branch_id=…&database_name=copy_rehearsal&role_name=neondb_owner`)
#    written straight to "$SCRATCH/rehearsal-url" (0600), never printed.
export DATABASE_URL="$(cat "$SCRATCH/rehearsal-url")"
pnpm --filter @transpera-flow/db migrate $D         # compat + every migration into the empty database

# 2. Export from Supabase (needs Austin to allow the production reads).
SUPABASE_ACCESS_TOKEN="$(cat "$SCRATCH/supabase-token")" \
  pnpm --filter @transpera-flow/db copy:export --out "$OUT" --supabase vgsjkpwvxkpqvyazwcyq

# 3. Try the import and read the report. Nothing is kept. It says "path: fallback" on Neon.
pnpm --filter @transpera-flow/db copy:import --in "$OUT" $D --dry-run

# 4. Import for real, then verify (VERIFIED, exit 0).
pnpm --filter @transpera-flow/db copy:import --in "$OUT" $D
pnpm --filter @transpera-flow/db copy:verify --in "$OUT" $D

# 5. Point a local or preview check at the branch's database (sign in, open Northbeam and a client workspace), then delete the
#    branch through the Neon API, `rm -rf "$OUT"` and remove the scratch URL file.
```

Neon refuses the replica role, so the import takes the fallback path; `--no-replica` forces that path on a database that would
allow the replica role, to rehearse it elsewhere.

## 7c. Cutover (after Austin's go-ahead; nobody edits during steps 1 and 2)

```sh
export OUT=$HOME/transpera-copy/cutover-$(date +%Y%m%d)

D=--driver=neon-ws
# 1. Austin starts the freeze. 2. Fresh export, then import into the production database, then verify. DATABASE_URL is its
#    owner URL, from a private file; it must be empty (see "Before you start": Neon `main` has Preview's data).
# Start the export a minute after the freeze begins (see copy:export below on writes it reports).
SUPABASE_ACCESS_TOKEN="$(cat "$SCRATCH/supabase-token")" \
  pnpm --filter @transpera-flow/db copy:export --out "$OUT" --supabase vgsjkpwvxkpqvyazwcyq
pnpm --filter @transpera-flow/db migrate $D
pnpm --filter @transpera-flow/db copy:import --in "$OUT" $D --dry-run
pnpm --filter @transpera-flow/db copy:import --in "$OUT" $D
pnpm --filter @transpera-flow/db copy:verify --in "$OUT" $D

# 3 to 6 (Vercel Production env, merge, smoke test, rollback) are in docs/plans/supabase-exit-brief.md, 7c.
```

Do not go on to step 3 unless `copy:verify` printed `VERIFIED`. A failed or interrupted `copy:import` wrote nothing: fix the cause and run it again.

## Options

- `copy:export --out <dir> (--supabase <ref> | --url <postgres url>) [--page-size 500] [--storage-ref <ref> | --storage-base <url>]`.
  `--supabase` uses the Management API (`POST /v1/projects/<ref>/database/query`, Bearer token, only `select`s: a guard refuses any
  other statement) and downloads each `branding` object from `https://<ref>.supabase.co/storage/v1/object/public/branding/<name>`.
  `--url` reads a Postgres database in one read-only repeatable-read transaction and downloads nothing unless `--storage-ref` or
  `--storage-base` is given. Lower `--page-size` if the API answers with an error on the big tables (`reports.pdf` holds whole PDFs).
  It refuses a role that row-level security applies to (rows would be missing and the counts would still agree). The script exits 1
  when a table changed while it was read (its count moved, or Postgres counted a write to it between the start and the end of the
  export) or a logo could not be downloaded; the export is still written, and the logo is reported by the import. Postgres counts a
  write up to a few seconds late, so start the export a minute after the freeze begins; a write reported then means someone
  wrote (`api_tokens` moves on every MCP call), and the export must be run again.
- `copy:import --in <dir> [--url <postgres url>] [--driver pg|neon-ws] [--dry-run] [--no-replica]`. Numbers are read from the
  files as their own text (`JSON.rawJSON`), so a `numeric` keeps every digit and its scale, and an `int8` above 2^53 is exact.
- `copy:verify --in <dir> [--url <postgres url>] [--driver pg|neon-ws]`. It reads `import-report.json` (written by a real import into the export directory)
  to allow for what the import skipped.

## What the import does

1. Tries `set local session_replication_role = replica`: no foreign-key checks and no triggers, so tables load in any order and the
   audit and history triggers stay quiet. If the database refuses it (42501), it takes the **fallback** path: tables load parents
   first (order worked out from the foreign keys), `alter table ... disable trigger user` on every table it writes, a self-reference
   or cycle loads with its column null and is filled in by an update, and the triggers are switched back on at the end. The report's
   first line says which path ran and why (`--no-replica` forces the fallback).
2. `auth.users` and `auth.identities` copy as they are (only the columns the target has; password hashes and tokens are never
   exported). Then, with the `sync_auth_user` trigger off, one `better_auth."user"` per user with an email (same id, lower-cased
   email, name from the profile, `emailVerified` from `email_confirmed_at`, `createdAt`/`updatedAt` from the export's
   `auth.users`, whose own `created_at`/`updated_at` the target does not keep) and one `better_auth.account` per Google identity
   (`providerId` google, `accountId` the Google `sub`). Users without an email, a second user with the same email, and identities of
   other providers are reported, not copied.
3. Columns the target no longer has (the `sources` file columns, `workspaces.branding.logo_path`) are dropped and listed. Columns the
   target has that the export did not are left to their defaults.
4. Each workspace's current logo goes into `workspace_logos` with its sha256, if its bytes are in the export, are PNG, JPEG or WebP,
   and are at most 512 KB. Anything else is listed as oversized or skipped, with the reason.
5. A `deployment_access` rule per user, by name: `admin` for agency admins, `editor` for anyone who is an active owner or editor in any
   workspace, `viewer` for everyone else. Guests are not seeded. An email that already has a rule keeps it.
6. Sequences are set to the largest value in their column.

Not copied: the private `sources` bucket (listed in `storage.json` so the files can be re-hosted as links), unused branding objects,
sessions, passwords, and identities other than Google.
