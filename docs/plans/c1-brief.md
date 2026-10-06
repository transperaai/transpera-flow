# C1 build brief: CSV import wizard with column mapping (#40)

Scoped 6 Oct 2026 (overnight run) against `origin/main` at a883256. C2 (#41) is merged: part 1 as #192 (row 50) and part 2
as #207 (row 57). Read `docs/plans/builder-brief.md` first. This brief adds to it and wins where they differ. Follow it
strictly. If something here is unclear or doesn't match the code, **ask; don't guess.** Austin is asleep for this run, so
every open question at the end has a default. Build with the defaults.

## The short version

C2 already reads three kinds of file on Settings → Historical data: a **step log**, a **clients file** and a **servicing
log**. It finds columns by fixed header names only and parses on the main thread. It has no way to correct a column, no
preview of the rows, and no input for the five kinds #40 names: leads, deals, jobs/tickets, time logs and invoices. C1
adds:

1. **One import wizard** (`ImportWizard`) that replaces C2's three paste/upload inputs. It has three steps: *Choose the
   file*, *Match the columns* (suggested, correctable), *Check the rows* (a preview, the rows left out with reasons, and
   names matched to the model). Files are parsed in a **Web Worker**.
2. **Eight kinds.** The five #40 kinds are read in their own columns and converted into the three shapes C2 already
   calibrates from, where that is a plain conversion:
   - deals → step log;
   - time logs → step log (hands-on time only);
   - jobs/tickets → servicing log;
   - leads → a check only (leads a week beside Settings);
   - invoices → a summary only (no cash model yet, D44 decision 5).
3. **Honest records.** Each import is recorded under its own kind with its column map, row count, date and a counts-only
   `details` object. An **Imports** card lists every past import. Re-importing a kind keeps the earlier records and
   starts from their column choices.
4. **Nothing raw is stored.** No rows, no file and no names from the file are stored, as in C2 (D27/D44). Q1 asks Austin
   whether he wants de-identified rows kept.

One migration: `20261216000000_dataset_imports` (additive). The engine is not touched and `ENGINE_VERSION` does not change.

| Step | What | Commit and push after |
|---|---|---|
| 1 | Pure module `packages/db/src/csv-import.ts`, the parser refactors and extensions, unit tests | yes |
| 2 | Migration, apply file, server actions, request checks, loaders, DB and PostgREST tests | yes |
| 3 | Worker, hook, `ImportWizard`, wiring into both panels, new cards, demo, browser tests, docs | yes |

Everything goes on one branch, `claude/c1-csv-import`, as one draft PR with `Closes #40`. If the diff passes about 3,500
lines, tell the orchestrator. It may split step 3 into its own PR.

---

## Decisions (verbatim)

**#40, "What to build":**
> Bring in the client's historical data. On the Historical data settings page, upload CSVs for leads, deals, jobs/tickets,
> time logs and invoices. A column mapper suggests mappings (date, stage, person, client, amount, duration and so on) and
> lets the user correct them, with a preview of parsed rows and validation errors. Stored datasets record the file,
> mapping, row count and import date, ready for calibration (PRD §4.1 Company model, §5 datasets).
>
> **Redesign note (1 Oct):** kept as is (`docs/plans/redesign-plan.md`). Named clients are hidden in the redesign, so a
> client column is used only to count clients per service for client groups (A55, #120), never to show named clients. The
> page follows the new Settings layout (A33, #98) with (i) help on every field.

**#40 acceptance criteria:**
> - [ ] Upload and mapping work for all five dataset kinds, with auto-suggested mappings
> - [ ] The preview shows parsed rows and flags rows that fail to parse
> - [ ] Datasets are stored with their mapping and row count, under RLS
> - [ ] Files of 50k rows import without freezing the UI (parsed in a worker)
> - [ ] Re-importing a dataset kind keeps the previous one available

**Austin, 6 Oct (#41, comment 6005455093), decision 3:**
> **Inputs:** a clients CSV (`client, service, started, ended`) and a servicing log (`task, client, due, done`). Client ids
> are used for counting only and never stored (D27).

**Decision 5:**
> **Late payments:** left out of the market baseline until the engine has a cash model.

**#30 (B1), Austin 6 Oct (HANDOVER):**
> members and viewers see "Team member N" labels, only their own row, "A team member" for other names, and **no pay
> data**.

**Per-person times** (C6, #198) are parked as phase 2 ("not wanted for now", HANDOVER).

**Overnight rules (HANDOVER):**
> **Open questions:** take the brief's default. Record each default on the issue and under "Design calls Claude made, for
> Austin to confirm". Never block waiting for an answer.

---

## Audit: what C2 provides and what #40 still needs

**What C2 already provides (reuse all of it; don't copy it):**

| Piece | Where | Notes |
|---|---|---|
| CSV splitting (quotes, CRLF, BOM; tab, `;` or `,` from the first line) | `splitCsv` in `packages/db/src/calibration.ts` | |
| Encodings: UTF-8 (BOM or not), UTF-16 LE/BE with BOM, Windows-1252 fallback with a note | `decodeLogFile` | |
| Dates: ISO with or without time and zone; slashed d/m/y or m/d/y; order detected from the whole file (`ambiguous` → ask, `mixed` → refuse) | `parseLogTime`, `detectDateOrder`, `hasTimeOfDay` | |
| A due date with no time, or exactly midnight, is the end of that day | `parseServicingLog` | |
| Header matching by alias lists | `STEP_LOG_HEADERS`, `CLIENTS_HEADERS`, `SERVICING_LOG_HEADERS`, `normHeader` | **Fixed: no correction.** A header that isn't on the list gives "The log has no step column" |
| Row errors by 1-based line, row cap | `MAX_STEP_LOG_ROWS` (200,000) | 20 MB file cap in the panels |
| Three parsers | `parseStepLog` (`calibration.ts`); `parseClientsFile`, `parseServicingLog` with a shared private `readTable` (`client-calibration.ts`) | |
| Templates | `STEP_LOG_TEMPLATE`, `CLIENTS_TEMPLATE`, `SERVICING_LOG_TEMPLATE` | |
| Inputs | `calibration-panel.tsx` card "2. Add the log"; `FileSource` and `ReadSummary` in `client-calibration-panel.tsx` | Paste or upload; a sample button on the demo |
| Records | `datasets`: insert-only; RLS read by `can_read_workspace`, insert by `can_edit_workspace`; `datasets_kind` already allows all eight kinds | `record_calibration` always inserts `step_log`. `record_client_calibration` inserts `clients` and `servicing_log` |
| History | Part 1: last 5 calibrations of the process. Part 2: last 5 client calibrations | |
| Privacy | Raw rows never stored; unmatched names stored as counts; `storedResults` / `storedClientResults` rebuild what's stored | |

**What #40 still needs (the gap, which is this brief):**

| AC | State today | C1 does |
|---|---|---|
| 1. Five kinds, suggested mappings | Not met. No leads, deals, jobs, time logs or invoices; mappings are fixed header lists | Eight kinds in one wizard; suggestions from the last import, exact aliases, then whole-word aliases; every column correctable |
| 2. Preview, failing rows flagged | Partly. Counts and "Rows left out" (first 20); no rows shown | A preview table of the first 20 parsed rows; rows left out by line (first 200, then a count) |
| 3. Stored with mapping and row count, RLS | Met for the three C2 kinds, but only once a calibration is recorded; the kind is always `step_log`, `clients` or `servicing_log` | Records under the real kind (`deals`, `time_logs`, `jobs`); `leads`/`invoices` recorded on their own; counts-only `details` |
| 4. 50k rows in a worker | Not met. Main thread (`setTimeout(0)` or `useMemo`) | `csv-import.worker.ts`, with progress and Stop |
| 5. Re-import keeps the previous | Records are insert-only, but nothing lists them by kind or reuses them | An Imports card listing every record; the latest column map per kind pre-fills the wizard |

**Surprises worth knowing:**
- `datasets_kind` already allows `leads, deals, jobs, time_logs, invoices` (row 50 reserved them for C1). The check needs
  no change.
- `record_calibration` hardcodes `'step_log'` and its signature can't take a kind. That is why there is a **new**
  function rather than a replacement (below).
- The PRD's `datasets.file_url` was never built, and C2 decided not to keep files. It stays unbuilt (Q1).
- A time log has several entries per job and step. Fed into part 1 as is, each entry would look like a redo. It must be
  aggregated first, and only hands-on time proposed.

---

## Step 1: the pure module (no UI, no DB)

### 1.1 Refactors in existing files (behaviour identical; every existing test stays green unchanged)

`packages/db/src/calibration.ts`:
- `splitCsv(text, sep?: string)`. With `sep`, split on it. Without it, auto-detect exactly as now. Move the detection
  into an exported `detectDelimiter(text): "\t" | ";" | ","` and call it from `splitCsv`.
- **Extract** `parseStepLog`'s per-row body into an exported
  `readStepLogRow(cell: (c: StepLogColumn) => string, order: DateOrder): StepLogRow | string`. It returns the row, or the
  error message. `parseStepLog` calls it, so its messages don't change.
- **Extend `parseLogTime`** (additive: anything it reads today reads the same):
  - **Month names:** `2 Mar 2026`, `02-Mar-2026`, `2 March 2026`, `Mar 2, 2026`, `March 2 2026`, each with an optional
    ` 09:30` / ` 09:30:15`. English month names, full or three letters, any case. A new `TEXTUAL` regex; these are
    never ambiguous, so `detectDateOrder` ignores them.
  - **AM/PM** after a time on slashed and month-name dates (`02/03/2026 9:30 PM`, `2 Mar 2026 9:30am`). 12 AM is 0h,
    12 PM is 12h, and an hour over 12 with AM/PM is null.
  - **Two-digit years** on slashed dates (`02/03/26`): `SLASHED` accepts `\d{2}|\d{4}`, and `yy` becomes `2000 + yy`.
    `detectDateOrder` must still see them.
  - `hasTimeOfDay` recognises a time in the new forms too, so a month-name due date with no time is still the end of
    its day.

`packages/db/src/client-calibration.ts`:
- Split the private `readTable` into two exported functions:
  - `matchHeaders(header: string[], columns, headers)` → `{ index, columns }`: the existing loop.
  - `readMappedRows<C, R>(table: string[][], index: Partial<Record<C, number>>, spec, options & { headerRow?: number; onProgress?: (done: number, total: number) => void })`:
    the existing date-order settling and row loop, given an index. Line numbers keep counting every record from the
    file's first, as now. `headerRow` (1-based, among non-blank records) says which record holds the names; records
    before it are skipped. `onProgress` is called every 5,000 data rows.

  `readTable` becomes `matchHeaders`, then `readMappedRows`.
- Export the two `readRow` lambdas as `readClientRow` and `readServicingRow`. The parsers call them unchanged.

### 1.2 New `packages/db/src/csv-import.ts`

Add the export `"./csv-import": "./src/csv-import.ts"` to `packages/db/package.json`. Pure: no I/O, no clock (`asOf` is
passed in). Header comment in the style of `client-calibration.ts`: what each kind is, what it is converted into, and
that names from the file are used only on screen and to count, and never leave the browser (D27, #30).

```ts
export type ImportKind = "step_log" | "deals" | "time_logs" | "leads" | "clients" | "servicing_log" | "jobs" | "invoices";
export type ImportShape = "step_log" | "clients" | "servicing_log" | "leads" | "invoices";
export type ColumnType = "id" | "name" | "client" | "person" | "date" | "number" | "duration" | "amount";

export interface ImportColumn {
  id: string;               // the column id stored in column_map
  label: string;            // shown in the mapper
  required: boolean;
  type: ColumnType;
  aliases: readonly string[]; // normalised with normHeader
  help: { description: string; example: string }; // for the (i)
}
export interface ImportKindSpec {
  kind: ImportKind; label: string; shape: ImportShape;
  /** The column whose values are matched to names in the model (steps, services, servicing processes, lead sources), if any. */
  nameColumn: string | null;
  columns: readonly ImportColumn[];
  template: string;         // a CSV to download, 4-6 lines
  help: { description: string; example: string };
}
export const IMPORT_KINDS: Record<ImportKind, ImportKindSpec>;
```

**The kinds** (`*` marks a required column; aliases are additional to the label, all normalised):

| Kind (label) | Shape | Columns | Name column |
|---|---|---|---|
| `step_log` "Stage history (step log)" | step_log | `item*` id, `step*` name, `started*` date, `finished` date, `hours` duration, `source` name: **the existing `STEP_LOG_HEADERS`** | `step` |
| `deals` "Deals from your CRM" | step_log | `deal*` id (deal, deal id, deal name, opportunity, opportunity id, record id, id); `stage*` name (stage, deal stage, pipeline stage, stage name, status); `entered*` date (entered, date entered, entered stage, stage entered, entered at, changed at, date changed, moved at, date); `left` date (left, date left, exited, exited at, left stage, stage left); `source` name (source, lead source, original source, deal source, channel); `amount` amount (amount, value, deal value, deal amount); `owner` person (owner, deal owner, sales rep, rep, assigned to, user) | `stage` |
| `time_logs` "Time logs" | step_log | `job*` id (job, job id, project, ticket, task id, item, reference, matter); `task*` name (task, task name, activity, step, service item, description); `date*` date (date, start date, started, day, spent on, logged on); `hours*` duration (hours, duration, time, time spent, logged hours, quantity); `person` person (person, user, member, team member, employee, staff, name); `client` client (client, customer, account, company) | `task` |
| `leads` "Leads" | leads | `lead` id (lead, lead id, contact, contact id, id); `created*` date (created, created at, create date, date created, date added, received, submitted, date); `source*` name (source, lead source, original source, channel, origin, utm source) | `source` |
| `clients` "Clients" | clients | **the existing `CLIENTS_HEADERS`** | `service` |
| `servicing_log` "Servicing log" | servicing_log | **the existing `SERVICING_LOG_HEADERS`** | `task` |
| `jobs` "Jobs or tickets" | servicing_log | `job` id (job, job id, ticket, ticket id, id, number, reference); `type*` name (type, job type, ticket type, request type, issue type, category, task, servicing); `client*` client (the `CLIENT_HEADERS` list plus organization, organisation, company name, account name, requester company); `due*` date (due, due date, due on, due by, deadline, sla due, resolution due); `closed` date (closed, closed at, resolved, resolved at, solved, solved at, completed, completed at, done); `opened` date (opened, opened at, created, created at, raised, submitted, requested, received); `assignee` person (assignee, assigned to, agent, owner, handled by) | `type` |
| `invoices` "Invoices" | invoices | `invoice` id (invoice, invoice number, invoice no, number, id, reference); `client*` client (the client aliases); `issued*` date (issued, issue date, invoice date, date, created); `due` date (due, due date, payment due); `paid` date (paid, paid on, paid date, date paid, payment date); `amount` amount (amount, total, total amount, amount due, gross, net, value) | none |

Templates use Northbeam names: take them from the fixtures, as `CLIENTS_TEMPLATE` does. The deals template uses CRM-like
stage names that **differ** from the map's (for example "Qualified lead" for "Qualify"), so the demo exercises name
matching.

**Suggesting a mapping:**

```ts
export type MatchHow = "previous" | "name" | "partial";
export function suggestMapping(headers: readonly string[], kind: ImportKind, previous?: Record<string, string> | null):
  { index: Record<string, number | null>; how: Record<string, MatchHow | null> };
```

Columns are taken in the spec's order, **required ones first**, and each header is used at most once. For each column:
1. `previous`: the earlier import's header name for this column, if a header with that exact `normHeader` is in the file.
2. `name`: a header whose `normHeader` equals the label or an alias. The first alias in list order wins, then the leftmost
   header.
3. `partial`: a header whose normalised words contain an alias's words as a contiguous whole-word run ("Deal Stage Name"
   contains "stage"; "Stagecoach" doesn't). Required columns only. Leftmost header wins.

Otherwise the column is null. **Deterministic; no content sniffing.**

**Headers as shown:** an empty header is `Column N` (1-based). Duplicates get ` (2)`, ` (3)`. `displayHeaders(raw)`
returns them, and `column_map` stores the display name.

**Reading:**

```ts
export interface ImportRead {
  kind: ImportKind;
  rows: ShapeRow[];          // StepLogRow | ClientRow | ServicingRow | LeadRow | InvoiceRow, by shape (after conversion)
  preview: Record<string, string>[]; // first 20 parsed rows, by the KIND's column ids, values formatted for display (see privacy)
  errors: { line: number; message: string }[]; // first 200
  errorCount: number;
  lines: number;
  dateOrder: DateOrder | null;
  dateProblem: "ambiguous" | "mixed" | null;
  missing: string[];          // required columns with no header chosen: rows empty
  names: { value: string; rows: number }[]; // distinct values of the name column, by rows desc then value; at most 500
  note: string | null;        // kind-specific warning (below)
}
export function readImport(table: string[][], kind: ImportKind, index: Record<string, number | null>,
  options?: { dateOrder?: DateOrder; headerRow?: number; onProgress?: (done: number, total: number) => void }): ImportRead;
```

It uses `readMappedRows` with a per-kind row reader:
- `step_log`: `readStepLogRow`.
- `clients` and `servicing_log`: `readClientRow` and `readServicingRow`.
- New kinds: readers in this file.
  - Dates go through `parseLogTime`.
  - Durations go through `parseDuration`.
  - Amounts go through `parseAmount` and are checked only for being readable.
  - id, name, client and person cells must be non-empty when required, and are at most 200 characters, as today.

`missing` and the date-order rules work exactly as `parseStepLog`.

**Conversions** (exported, pure, each with tests):
- `dealsToStepLog(rows)`: `{ item: deal, step: stage, started: entered, finished: left ?? null, hours: null, source: source || null }`.
  `note` when fewer than 10% of deals have two or more rows: "Each deal appears about once, so this looks like a list of
  deals rather than their stage history. Waits and branch odds need a row for every stage a deal went through."
- `timeLogToStepLog(rows)`: group by `job`, then sort by `date`, ties by line. Merge **consecutive** entries with the
  same `task` into one visit: `started` is the first entry's date, `finished` null, `hours` the sum, `source` null.
  Returns step log rows.
- `jobsToServicing(rows)`: `{ task: type, client, due (end of day when date-only, exactly as readServicingRow), done: closed ?? null, requested: opened ?? null }`.
  `closed < opened` is a row error ("It was closed before it was opened.").
- `leadsSummary(rows, leadSources: {id, name, volumeWeek}[], asOf)`:
  - Window: the earliest `created` to `asOf`, at least 4 weeks (`CALIBRATION_MIN_WEEKS`).
  - Per lead source matched by name (`normHeader` equality after name matching): `{ leadSourceId, name, leads, perWeek, current }`.
  - Also `unmatched` (a count) and `weeks`.
  - Under 4 weeks: `blocked: "The file covers {w} weeks; at least 4 are needed."`. Under 10 leads for a source: that
    row is `enough: false`, as in calibration.
- `invoicesSummary(rows, asOf)`: `{ invoices, clients (distinct count), window, withDue, paidLate (share of invoices with due and paid where paid > due), unpaidPastDue (count with due ≤ asOf and no paid), withAmount }`.
  No amounts are summed or stored.

**Name matching:**

```ts
export function suggestNameMap(names: readonly { value: string }[], targets: readonly string[]): Record<string, string | null>;
export function applyNameMap(read: ImportRead, map: Record<string, string | null>): ShapeRow[];
```

- A value matches the target with the same `normHeader`, else null ("Leave out").
- `applyNameMap` rewrites the shape's name field (`step`, `service`, `task`, or the lead row's `source`) to the target
  name. It **drops** rows mapped to null and returns the rows. The caller reports the dropped count.

**Durations and amounts:**
- `parseDuration(text): number | null` (hours):
  - decimal hours, with a dot or a comma: `1.5`, `1,5`;
  - `h:mm` and `hh:mm:ss`: `1:30`, `01:30:00`;
  - `1h 30m`, `1h`, `90m`, `90 min`, `90 mins`.
  - Not negative, and at most 10,000.
- `parseAmount(text): number | null`:
  - strips one leading or trailing currency symbol or code (`£ $ € A$ AUD GBP USD EUR`) and spaces;
  - reads `(123.45)` and `-123.45` as negative;
  - `1,234.50`: comma thousands with a dot decimal;
  - `1.234,50`: dot thousands with a comma decimal, decided by which comes **last**;
  - `1 234,50`: a space as thousands.

**What may be stored** (used by the server checks in step 2):

```ts
export function importDetails(read: ImportRead, extra: { delimiter: string; encoding: "utf-8" | "utf-16" | "windows-1252"; headerRow: number; nameMatches: { matched: number; leftOut: number }; summary?: LeadsSummaryStored | InvoicesSummaryStored }): ImportDetails;
```

`ImportDetails` holds `{ delimiter, encoding, headerRow, dateOrder, lines, rows, leftOut, nameMatches, window, summary }`:
numbers, enums, and lead source **ids** from the model. **No string from the file** apart from what `column_map` holds
(header names).

### 1.3 Tests (step 1)

- **New `packages/db/test/csv-import.test.ts`:**
  - `suggestMapping`:
    - previous beats name, and name beats partial;
    - a header is never used twice;
    - required columns are matched first;
    - partial matches whole words only ("Stagecoach" isn't "stage");
    - each kind's template maps fully with no `previous`;
    - a HubSpot-like deals header (`Record ID, Deal Name, Deal Stage, Date entered stage, Original Source, Amount, Deal owner`)
      maps `deal, stage, entered, source, amount, owner`.
  - `displayHeaders`: empty and duplicate headers.
  - `readImport` for each kind:
    - good rows;
    - each row error, by line, with blank lines counted;
    - `missing`;
    - `ambiguous` and `mixed`;
    - `headerRow` 3 with two title rows above;
    - an explicit `;` and `|` delimiter;
    - the 200,000-row cap;
    - `onProgress` called every 5,000 rows.
  - A generated **50,000-row** deals file reads all rows correctly. No timing assertion.
  - The conversions:
    - deals to step log, and the "list of deals" note;
    - time log aggregation: A, A, B, A for one job gives three visits with hours summed;
    - jobs to servicing: a date-only due is the end of the day; closed before opened is an error;
    - `leadsSummary`: window, per source, unmatched, under 4 weeks, under 10;
    - `invoicesSummary`.
  - `parseDuration` and `parseAmount`: every form above, plus refusals (`abc`, `-1h`, `1.2.3`).
  - `parseLogTime` extensions: month names, AM/PM (12 AM, 12 PM, 13 PM → null), two-digit years. A table of today's
    accepted inputs gives the **same** milliseconds as before (write the expected numbers in).
  - `suggestNameMap` / `applyNameMap`: rows mapped to null are dropped.
  - **Privacy:** files holding `ACME-SECRET-CLIENT` in the client column, `Jane Secretperson` in the person column and
    `£9,999` in the amount column. `JSON.stringify(importDetails(...))` contains none of them, for every kind.
- `packages/db/test/calibration-log.test.ts` and `client-calibration-log.test.ts` stay **unchanged** and green.

---

## Step 2: migration, server, loaders

### 2.1 Migration `packages/db/supabase/migrations/20261216000000_dataset_imports.sql`

The version is reserved after B21's `20261215000000`. If the merge order changes, renumber at merge time and tell the
orchestrator. **Additive.** It adds one column and two functions, and replaces `record_client_calibration` with a full
copy of its **latest** definition (row 57, `20261208000000_client_calibration.sql`), signature unchanged, with the added
lines marked `-- C1`. It does **not** touch `save_fields`, `record_calibration`, `apply_calibration`,
`calibration_payload_problem`, the `calibrations` trigger, `datasets_kind`, or any policy or grant on the tables.

1. **Column:**
   ```sql
   alter table public.datasets add column details jsonb not null default '{}'
     constraint datasets_details check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 20000);
   ```
   Table grants are table-level (`select, insert`), so the column is covered. It is insert-only like the rest of the row
   (no update grant).
2. **`public.record_dataset(p_workspace uuid, p_kind text, p_file_name text, p_column_map jsonb, p_row_count integer, p_details jsonb) returns uuid`**,
   `language plpgsql security invoker set search_path = ''`. It records an import that has no calibration:
   - an API token → 42501 "Data is imported by a person in the app, not over the API" (copy the `auth.jwt() ? 'api_token_id'` test);
   - `p_kind not in ('leads', 'invoices')` → 22023 "Stage histories, deals, time logs, clients files, servicing logs
     and jobs are recorded with their calibration";
   - insert `(workspace_id, kind, process_id, file_name, column_map, row_count, details)` with `process_id` null,
     `coalesce(p_column_map, '{}')`, and `coalesce(case when jsonb_typeof(p_details) = 'object' then p_details end, '{}')`.
     RLS refuses viewers and strangers (insert policy `can_edit_workspace`);
   - return the id;
   - `revoke all … from public, anon, authenticated; grant execute … to authenticated;`.
3. **`public.record_calibration_import(p_workspace uuid, p_process uuid, p_kind text, p_file_name text, p_column_map jsonb, p_row_count integer, p_details jsonb, p_results jsonb, p_keys text[]) returns jsonb`**:
   a copy of row 50's `record_calibration` body with:
   - `p_kind not in ('step_log', 'deals', 'time_logs')` → 22023 "That kind of file isn't calibrated against a process";
   - the dataset inserted with `kind = p_kind` and `details` as in 2;
   - the rest identical: the calibration insert, `apply_calibration(cal, p_keys)` (which refuses API tokens), and the
     return `out || {calibration_id, dataset_id}`.

   Same revoke and grant. `record_calibration` stays as it is (the PostgREST tests and any older client use it).
4. **`create or replace function public.record_client_calibration(p_workspace uuid, p_clients jsonb, p_log jsonb, p_results jsonb, p_keys text[])`**:
   the full row 57 body plus:
   - `log_kind text := coalesce(p_log ->> 'kind', 'servicing_log'); -- C1`;
   - when `p_log` is given and `log_kind not in ('servicing_log', 'jobs')` → 22023 "That kind of file isn't a servicing log";
   - the log's insert uses `log_kind`;
   - both inserts add `details` from `p_clients -> 'details'` / `p_log -> 'details'` (object or `'{}'`, as in 2);
   - the clients file's kind stays `'clients'`;
   - `results.datasets` and the return value keep the key `servicing_log` for the log's dataset id, even for a jobs
     file, because `client-data.ts` reads it. Comment that.

   Keep the revoke and grant lines.

**Header** (copy the style of `20261208000000_client_calibration.sql`): purpose; that rows, files, client ids, person
names, amounts and unmatched names never reach the database (the page sends header names, counts and model ids); the
preflight; the post-apply checks; and the rollback below.

```sql
-- PREFLIGHT (read-only; each with its expected result):
--   0. Nothing at or past this version. Expect 0 rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261216000000';
--   1. Rows 50 and 57 applied. Expect 2:
--        select count(*) from supabase_migrations.schema_migrations where version in ('20261202000000', '20261208000000');
--   2. record_client_calibration is row 57's, unchanged. Expect the md5 recorded here (compute it on a local database
--      migrated to origin/main and paste it in; no later migration touches it):
--        select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and p.proname = 'record_client_calibration';
--   3. No details column yet. Expect 0:
--        select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'datasets' and column_name = 'details';
--   4. The new functions don't exist. Expect null, null:
--        select to_regprocedure('public.record_dataset(uuid, text, text, jsonb, integer, jsonb)'),
--               to_regprocedure('public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[])');
--   5. datasets_kind already allows the eight kinds. Expect one row listing step_log, clients, servicing_log, leads, deals, jobs, time_logs, invoices:
--        select pg_get_constraintdef(oid) from pg_constraint where conname = 'datasets_kind';
--   6. For the record (the column add is metadata-only with a constant default): select count(*) from public.datasets;
--
-- POST-APPLY:
--   select column_name, data_type, is_nullable, column_default from information_schema.columns
--     where table_schema = 'public' and table_name = 'datasets' and column_name = 'details';   -- jsonb, NO, '{}'::jsonb
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'datasets_details';    -- the check
--   select p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.proname in ('record_dataset', 'record_calibration_import', 'record_client_calibration') order by 1;
--     -- each: f, {search_path=""}, f, t
--   select version from supabase_migrations.schema_migrations where version = '20261216000000';  -- 1 row
--
-- ROLLBACK (one transaction; roll the app back first):
--   begin;
--   drop function if exists public.record_dataset(uuid, text, text, jsonb, integer, jsonb);
--   drop function if exists public.record_calibration_import(uuid, uuid, text, text, jsonb, integer, jsonb, jsonb, text[]);
--   -- Put back row 57's record_client_calibration: re-run its `create function ... $$;` block from
--   -- 20261208000000_client_calibration.sql as `create or replace`, with its revoke and grant.
--   alter table public.datasets drop column if exists details;
--   delete from supabase_migrations.schema_migrations where version = '20261216000000';
--   commit;
-- Records of the new kinds stay: datasets_kind always allowed them. Only their `details` go with the column. Measured
-- values from them keep their numbers and their dataset_id.
```

**Apply file** `packages/db/scripts/apply/20261216000000_dataset_imports.sql`: copy the header style of
`scripts/apply/20261208000000_client_calibration.sql`, including its `set local lock_timeout = '5s'`.
Then `begin;`, the migration SQL, the `schema_migrations` insert (version `'20261216000000'`, name `'dataset_imports'`,
`array[$mig$…$mig$]`), and `commit;`. Then run `pnpm --filter @transpera-flow/db gen:bootstrap` and `gen:types`; no
fixture changes, so no `gen:seed`. Add a row to `docs/production-migrations.md` as "not applied", in the style of row 57,
numbered after the last row on `main` at merge time.

### 2.2 Server (apps/web)

- **New `apps/web/src/lib/calibration/import-request.ts`** (framework-free; copy the style of `client-request.ts`):
  - `parseColumnMap(kind, input)`: an object whose keys are the kind's column ids and whose values are strings of at
    most 200 characters; at most 20 keys.
  - `storedImportDetails(input)`: **rebuilds** `ImportDetails` from known fields only (numbers clamped and finite; enums
    checked; lead source ids must be uuids; `summary` by kind). **Never `...spread`.** Under 20,000 bytes, otherwise it
    refuses.
  - `parseRecordDatasetRequest(input)` → `{ workspaceId, kind: "leads" | "invoices", fileName (1–300), columnMap, rowCount (0–1,000,000), details }`.
- **`apps/web/src/lib/calibration/request.ts`**: `parseApplyRequest` also takes:
  - `kind: "step_log" | "deals" | "time_logs"` (missing means `step_log`). Validate `columnMap` with `parseColumnMap(kind, …)`
    instead of `STEP_LOG_COLUMNS`;
  - `details` through `storedImportDetails`.
- **`apps/web/src/lib/calibration/client-request.ts`**: `log` also takes `kind: "servicing_log" | "jobs"` and `details`;
  `clients` takes `details`. Validate column maps per kind.
- **`apps/web/src/app/w/[slug]/settings/calibration/actions.ts`**:
  - `applyCalibration` calls `record_calibration_import` with `p_kind` and `p_details`;
  - `recordClientCalibration` puts `kind` and `details` inside `p_clients` / `p_log`;
  - **new `recordDataset(input)`**, a copy of `recordClientCalibration`'s shape: parse, signed-in check,
    `rpc("record_dataset", …)`. 42501 gives "Only owners and editors can save imports here." Then `refresh()`.
    Returns `{ status: "ok", datasetId } | { status: "error", message }`.
- **New `apps/web/src/lib/calibration/import-data.ts`** (`server-only`): `loadImports(workspaceId)` →
  - `imports`: the last 50 `datasets` of the workspace, newest first: `id, kind, file_name, row_count, imported_at, column_map, details`;
  - `previous: Partial<Record<ImportKind, Record<string, string>>>`: the latest `column_map` per kind.

  **Do not select `created_by`** (no names shown; #30). RLS lets every member read.

### 2.3 Tests (step 2)

- **New `packages/db/test/dataset-imports.test.ts`** (copy `client-calibration.test.ts`'s harness, users and Northbeam ids):
  - `record_dataset`:
    - an editor records `leads` and `invoices` with details;
    - `deals` gives 22023;
    - a viewer, a member, a stranger and an API token are refused and leave no row;
    - non-object details store `{}`;
    - details over 20,000 bytes are refused (23514).
  - `record_calibration_import`:
    - `deals` and `time_logs` record the dataset under that kind, with details, and apply a key exactly as
      `record_calibration` does (measured provenance cites the new dataset id);
    - `leads` gives 22023;
    - an API token is refused and nothing is recorded.
  - `record_client_calibration`:
    - `p_log.kind = 'jobs'` records a `jobs` dataset;
    - no kind still records `servicing_log` (row 57 behaviour);
    - `p_log.kind = 'deals'` gives 22023;
    - details are stored.
  - Members can read `details`; nobody can `update datasets set details = …` (add to the insert-only check in
    `role-matrix.test.ts`).
  - `calibration.test.ts` and `client-calibration.test.ts` stay green **unchanged**.
- **New `packages/mcp/test/postgrest-dataset-imports.test.ts`** (copy `postgrest-client-calibration.test.ts`):
  - over PostgREST, an editor reads a generated deals file with `readImport`, converts it, runs `calibrate`, and records
    with `record_calibration_import`;
  - a member reads the dataset row: kind `deals`, the column map, counts only;
  - a viewer's `record_dataset` leaves nothing.
- **New `apps/web/test/import-request.test.ts`:**
  - each parser accepts good input and refuses bad;
  - `storedImportDetails` drops an extra field holding a client name and a person name;
  - unknown kinds are refused.

---

## Step 3: worker, wizard, page

### 3.1 Worker `apps/web/src/workers/csv-import.worker.ts` and hook `apps/web/src/lib/calibration/use-csv-import.ts`

Copy the shape of `churn-calibration.worker.ts` / `use-churn-backsolve.ts`. The worker keeps the last loaded table in
memory between messages.

```ts
type ImportRequest =
  | { id: number; op: "load"; bytes: ArrayBuffer /* transferred */ | null; text: string | null; delimiter: "auto" | "," | ";" | "\t" | "|"; headerRow: number }
  | { id: number; op: "read"; kind: ImportKind; index: Record<string, number | null>; dateOrder?: DateOrder };
type ImportMessage =
  | { id: number; kind: "loaded"; headers: string[]; samples: string[][] /* first 5 data rows */; lines: number; delimiter: string; encoding: "utf-8" | "utf-16" | "windows-1252"; note: string | null }
  | { id: number; kind: "progress"; done: number; total: number }
  | { id: number; kind: "read"; read: ImportRead }
  | { id: number; kind: "error"; error: string };
```

- **`load`** decodes with `decodeLogFile` (bytes) or takes the text, splits with `splitCsv(text, sep)`, and finds the
  header row. When `bytes` has many NULs and no BOM (more than 10% of the first 1,000 bytes are 0), it answers `error`:
  "This looks like a Unicode file without its marker. In Excel, save it as CSV UTF-8 and choose it again."
- **`read`** runs `readImport` with `onProgress` posting `progress`.
- **The hook** `useCsvImport()` returns `{ load(file | text, options), read(kind, index, dateOrder?), stop(), state }`.
  - `stop()` terminates the worker (a new one starts on the next call), and the state goes back to the mapping step.
  - A newer request supersedes an older one: answers for older ids are dropped.
  - `new Worker(new URL("../../workers/csv-import.worker.ts", import.meta.url), { type: "module" })`, exactly that form,
    so the browser harness can swap it.
- **Limits:**
  - 20 MB per file (as today; checked before reading the bytes);
  - 200,000 rows;
  - errors posted capped at 200 (`errorCount` has the total).

`calibrate`, `measureChurn` and the back-solve stay where they run today. Only parsing and conversion move to the worker.

### 3.2 `apps/web/src/components/calibration/import-wizard.tsx` (client component)

```ts
export interface ImportWizardProps {
  id: string;                         // for headings, radio groups and input ids
  kinds: readonly ImportKind[];       // the kinds this card takes; a picker shows when there is more than one
  /** Names in the model the name column is matched to (step names, active services, servicing processes, lead sources). */
  targets: { label: string; names: readonly string[] } | null;
  previous: Partial<Record<ImportKind, Record<string, string>>>;
  sample?: Partial<Record<ImportKind, { name: string; text: string }>>;  // the demo
  onReady: (ready: ImportReady | null) => void;  // null when the person starts again
}
export interface ImportReady {
  kind: ImportKind; fileName: string;
  columnMap: Record<string, string>;  // column id -> display header
  rows: ShapeRow[];                   // converted and name-matched
  read: ImportRead;                   // for the panel's own summary lines
  details: ImportDetails;
}
```

Three steps, inline in the card (not a dialog). Each step is a `section` with `data-import-step="file" | "columns" | "rows"`.
Wording follows the existing panels: plain words, sentence case.

1. **Choose the file.**
   - A "What's in the file" select (only with more than one kind). Its (i) is the kind's help.
   - "Choose a CSV file", a hidden `input type=file` with `accept=".csv,.tsv,.txt,text/csv,text/plain"`, and the id
     `${id}-file`.
   - "Or paste the rows" textarea with "Read the rows".
   - "Download the template" (the kind's template), and "Use a sample" when `sample` has the kind.
   - "Columns are split by" select: Automatic / Comma / Semicolon / Tab / Vertical bar, with (i).
   - "Column names are on row" number, 1–20, default 1, with (i).

   Changing either select re-sends `load`. A `.xlsx` file gives "Save it as CSV UTF-8 from Excel and choose that file."
   (Q6). A file over 20 MB gives "That file is over 20 MB. Split it by date and read each part."
2. **Match the columns.** One row per column of the kind:
   - the label with an (i) from `ImportColumn.help`, and "Required" when required;
   - a `NativeSelect` of the display headers plus "Not in this file" (optional columns only);
   - a badge: "From your last import", "Suggested" (name or partial), or nothing;
   - **up to three sample values** from the chosen header, from `samples`.

   Sample masking (privacy):
   - a `client` or `person` column shows "3 different values in the first 5 rows", never the values;
   - an `amount` column shows its values only for owners and editors (`mode !== "readonly"`);
   - other columns show the values, cut at 40 characters.

   A header chosen twice shows "Used for {other column} too" and blocks Continue. A required column with nothing
   chosen blocks Continue with "Choose a column for {label}." Continue sends `read`. While reading:
   "Reading… {done} of {total} rows", with a **Stop** button.
3. **Check the rows.**
   - "Read {n} rows. {k} left out." plus `note`, the encoding note, and "Dates read day first / month first".
   - The **date order question** when `dateProblem === "ambiguous"`, copied from `ReadSummary`. It re-sends `read`
     with `dateOrder`. `mixed` shows the existing message.
   - A **preview table**: the first 20 parsed rows, one column per mapped column, with headers from the kind's labels.
     Values are rendered as text; never `dangerouslySetInnerHTML`. **Identity columns are labelled, never shown:** a
     `client` column shows "Client 1", "Client 2"… and a `person` column "Person 1"…, numbered in order of first
     appearance in the preview. The table's caption says: "Client and person names are never shown or kept. They are
     used only to count." Amounts show only for owners and editors (otherwise "—"). Dates show as `2 Mar 2026 09:30`
     (UTC, as read).
   - **Rows left out**, in a `details` element: "Line {line}: {message}" for the first 200, then "and {n} more".
   - **Match the names** (when the kind has a name column and `targets` is given): one row per distinct value (at most
     500, most rows first): "{value} ({rows} rows)" → a select of `targets.names` plus "Leave out", defaulted by
     `suggestNameMap`. The heading (i) explains, with an example ("Qualified lead → Qualify"). The values are the
     file's own step, service, task or source names, not client or person names, so they are shown. Rows left out by
     name are counted in the summary line.
   - **"Use these rows"** calls `onReady(...)` with `applyNameMap`'s rows and `importDetails(...)`. "Start again"
     calls `onReady(null)` and resets.

(i) help on **every** field: kind, file, paste, delimiter, header row, each column, date order, each name-match heading
and the Save button. Use `Help` / `HelpLabel` from `components/help.tsx`.

### 3.3 Wiring

- **`calibration-panel.tsx` (part 1):**
  - Replace the "2. Add the log" card's body with
    `<ImportWizard id="cal-log" kinds={["step_log", "deals", "time_logs"]} targets={{ label: "Steps of {process}", names: step names of stored.steps (not replaced) }} previous=… />`.
  - The `Read` state comes from `ImportReady`. `calibrate(calibrationInput(stored, ready.rows))` as now.
  - **For `time_logs`:** pass `leadSources: null` (build the input, then set it to null) and keep only `kind === "work"`
    proposals.
  - `LogSummary` keeps only the calibration lines (items, window, in progress at start, unmatched steps and sources).
    Row errors and the date order move to the wizard.
  - `applyCalibration` sends `kind`, `columnMap: ready.columnMap`, `rowCount: ready.rows.length` and `details`.
  - Remove the textarea, file input and template link that the wizard now owns. Keep the "1. Choose the process" card.
- **`client-calibration-panel.tsx` (part 2):**
  - Replace both `FileSource`s:
    - `<ImportWizard id="cal-clients" kinds={["clients"]} targets={{ label: "Services", names: active service names }} …/>`;
    - `<ImportWizard id="cal-log" kinds={["servicing_log", "jobs"]} targets={{ label: "Client work", names: servicing process names from rows.processes }} …/>`.
  - `clients` and `log` come from `ImportReady` instead of the `useMemo` parsers. Everything downstream (`measureChurn`,
    `servicingChecks`, the back-solve) is unchanged.
  - `recordClientCalibration` gets `kind` and `details`.
  - `ReadSummary` keeps the calibration lines only.
  - Delete `FileSource` once nothing uses it.
- **New `apps/web/src/components/calibration/other-imports-panel.tsx`:** card **"Leads and invoices"**.
  - `<ImportWizard id="cal-other" kinds={["leads", "invoices"]} targets={leads: lead source names; invoices: null} />`.
  - Then the summary:
    - leads: a table of lead source, "Leads a week in the file", "In Settings now" and n, with a "Check only" badge and
      the note "To change leads a week, read a stage history or deals in the card above.";
    - invoices: the counts, plus "Late payments aren't simulated yet, so nothing is changed."
  - A "Save the import" button (owners and editors; hidden when read-only; demo: "Demo: nothing is saved.") calls
    `recordDataset`.
- **New `apps/web/src/components/calibration/imports-history.tsx`:** card **"Imports"**.
  - Every record from `loadImports`, newest first: kind label, file name, rows, date (`formatDate`), and "Columns:
    deal ← Record ID, stage ← Deal Stage, …" from `column_map`, plus the leads or invoices summary from `details`.
  - Empty: "Nothing imported yet."
  - The (i) says that earlier imports stay listed, their columns are offered again next time, and their rows aren't kept.
  - Members and viewers see it too.
- **`apps/web/src/app/w/[slug]/settings/calibration/page.tsx`:**
  - also `loadImports(workspaceId)`;
  - pass `previous` to the three panels;
  - render `OtherImportsPanel` and then `ImportsHistory` after `ClientCalibrationPanel`;
  - update the page's description: "Import past data, check it, compare it with the model, and apply the changes you choose."
- **Demo `apps/web/src/app/demo/settings/calibration/page.tsx`:**
  - samples for every kind from a new `apps/web/src/lib/calibration/import-samples.ts`. Deterministic, and derived from
    the existing samples where possible:
    - deals: `northbeamSampleLog()`'s rows under CRM headers, with two stages renamed;
    - time logs: about 300 entries over Northbeam's task steps;
    - jobs: the servicing sample under ticket headers;
    - leads: about 200 over 16 weeks across Northbeam's lead sources plus one unknown source;
    - invoices: about 150;
  - `previous` empty; history empty.

### 3.4 Tests (step 3)

- **New `apps/web/test/csv-import-browser.test.ts`** with a harness `apps/web/test/csv-import-harness/entry.tsx`.
  - Use `bundleHarness` from `build-harness.ts`, and **real workers** as `overview-page-harness/entry.tsx` does: bundle
    `csv-import.worker.ts` and hand it over as `window.workerScripts`, with `Worker` swapped.
  - The harness mounts the three cards with Northbeam rows (`demoBundle()`, as the demo page does).
  - Tests, each checking no page errors:
    1. the deals kind with HubSpot-like headers: every column is suggested with a "Suggested" badge, and changing one
       select is kept;
    2. a required column set to "Not in this file" blocks Continue with the message, and the same header chosen twice
       blocks it too;
    3. the preview shows 20 rows, and the client column shows "Client 1", never the file's client id;
    4. bad rows are listed by line;
    5. an ambiguous-date file asks, and answering re-reads;
    6. name matching: "Qualified lead" defaults to "Leave out" (no exact match), choosing "Qualify" is kept, and the
       panel's proposals then include that step;
    7. a Windows-1252 file shows the encoding note, and a semicolon file is split automatically;
    8. **a 50,000-row file:** the read goes through the worker (`workerPosts` includes `csv-import.worker.ts` with
       `op: "read"`), "Reading… … of 50,000 rows" shows before the preview, and the preview arrives;
    9. **a 200,000-row file:** clicking **Stop** while it reads returns to "Match the columns" (the main thread
       answered during the read);
    10. `previous` pre-fills the mapping, with "From your last import";
    11. every field has an (i) (count the `Help` buttons per step against the fields);
    12. read-only mode hides "Save the import" and shows amounts as "—".
- **`apps/web/test/calibration.test.ts` / `client-calibration.test.ts`:** update only what the wizard's input change
  requires (the request shapes). Don't weaken anything.
- **`apps/web/test/settings-help.test.ts`:** extend it if it lists the Settings (i) labels.
- **Screenshots** of the demo Historical data page (light and dark, 1440 and 400 px) at each wizard step for deals, plus
  the Leads and invoices card. Attach them as text evidence in the PR.

### 3.5 Docs

- **`docs/PRD.md`:**
  - §4.1 "Historical data": one paragraph on the wizard, the eight kinds and what each feeds;
  - §5 `datasets`: the real columns (no `file_url`; `details`) and kinds;
  - §6.6: one line, "Deals and time logs calibrate a process like a step log; jobs check servicing like a servicing log";
  - a decision row **D45** "How is historical data imported?" listing the defaults taken (Q1–Q10), marked "Claude's
    defaults, for Austin to confirm".
- **`CONTEXT.md`:** add **Import** (a dataset): a file read on Historical data, recorded with its kind, columns and row
  count. Its rows are never kept.
- **`docs/supabase-notes.md`:** only if something is verified only against plain Postgres.

---

## Edge cases (each needs a test where marked T)

- **Encodings:**
  - UTF-8 with or without a BOM; UTF-16 LE/BE with a BOM; Windows-1252 with the note (T, existing);
  - UTF-16 without a BOM is refused with the plain message (T).
- **Delimiters:**
  - auto (tab, then `;` over `,`, from the first line, as now);
  - explicit `,` `;` tab `|` (T);
  - a delimiter inside quotes; quoted newlines; CR-only line ends (T, existing);
  - short rows read missing cells as blank, and extra cells are ignored (T).
- **Header row:**
  - title rows above the names are handled by "Column names are on row" (T);
  - a header-only file gives "No rows to read";
  - empty and duplicate headers (T).
- **Dates:**
  - ISO, slashed, month names, AM/PM, two-digit years, zones (T);
  - 31 February is a row error (T, existing);
  - `ambiguous` asks and `mixed` refuses (T);
  - a date-only due is the end of the day for servicing logs **and jobs** (T);
  - Excel serial numbers (45352) are **not** read. Their row error says "Can't read the date "45352". Format the column
    as a date in Excel before saving."
- **Numbers:** decimal commas, thousands separators, currency symbols and codes, negatives in brackets (T). Durations in
  every form (T).
- **Big files:**
  - 20 MB cap before reading;
  - 200,000-row cap with the existing message;
  - the worker, progress every 5,000 rows, and Stop (T);
  - errors capped at 200 in the message.
- **Bad rows:** left out with line and reason; the rest are kept. Only a missing required column or a date problem
  stops the whole read.
- **Name matching:** a value shared by two targets after normalising matches neither, as C2 does. Rows left out by name
  are counted, never stored by name (T).
- **Deals without stage history:** the note (T).
- **Time logs:** aggregation (T); only `work` proposals; the `person` and `client` columns are never used beyond the
  preview's labels.
- **Re-import:** a second import of a kind adds a record and the first stays listed (T in the DB test); the next wizard
  pre-fills from the latest (T, browser).
- **A file whose header changed** since the last import: `previous` matches only headers still present. The rest fall
  back to suggestion.
- **Privacy (#30, D27):**
  - No kind has a pay, rate or cost column, so pay is never read, shown or stored. A file's "Rate" column is only a
    header name in the mapper's list.
  - Client and person values are never shown (labelled in the preview, counted in the mapper) and never stored.
  - Amounts show only to owners and editors and are never stored.
  - `details` and `column_map` hold no value from the file (T, the step 1 privacy test and `storedImportDetails`).
  - The Imports card shows no importer names (no `created_by`).
- **Roles:**
  - everyone in the workspace can read files and preview them, as C2 does today;
  - owners and editors record (RLS);
  - API tokens are refused by every recording function (T).
- **Demo:** nothing is saved; "Save the import" says so.
- **XSS:** cells and file names are rendered as React text only.

## Out of scope

- Storing rows, files or a `file_url` (Q1); re-running a calibration from an earlier import.
- `.xlsx` reading (Q6), Excel serial dates, and non-English month names.
- Wide CRM exports with one date column per stage (Q9).
- Calibrating from leads or invoices (Q3): no leads-a-week or conversion proposals from a leads file; no late payments
  (D44 decision 5).
- Per-person anything: matching people, capacity factors, per-person hours (#198, parked).
- Rework from re-opened tickets (a `reopened` column); a follow-up.
- Remembering name matches between imports (Q7).
- Any change to the engine, `ENGINE_VERSION`, goldens, `save_fields`, `record_calibration`, `apply_calibration`,
  `calibration_payload_problem` or RLS policies.
- MCP tools for imports. Connectors and scheduled sync (PRD v2).

## Done

- `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build` green locally, with Postgres
  running (known local-only failures as in the builder brief).
- Bootstrap and types regenerated.
- The migration, the apply file with the md5 in preflight 2 filled in, and the `production-migrations.md` row as "not
  applied".
- Existing calibration tests unchanged and green; no engine or golden change.
- Every acceptance criterion of #40 maps to a passing test, listed in the PR body:
  - AC1: step 1 `suggestMapping` and `readImport` for all kinds, plus browser test 1;
  - AC2: browser tests 3 and 4;
  - AC3: `dataset-imports.test.ts` and the PostgREST test;
  - AC4: browser tests 8 and 9;
  - AC5: the DB re-import test and browser test 10.
- The PR body has:
  - the preflight and post-apply checks;
  - "Apply BEFORE deploying the app (the page calls the new functions)";
  - "no engine numbers move";
  - the screenshots as text evidence;
  - the defaults taken from the questions below.

## Open questions (each with the default to build)

1. **Keep the rows?** #40 says stored datasets are "ready for calibration", and the PRD has `datasets.file_url`. C2 and
   D44 never store rows, and client ids "never stored" is Austin's own rule.
   - *Default: store no rows and no file. A dataset is the record (kind, file name, columns, row count, date, counts).*
   - The alternative (a follow-up, if Austin wants it): de-identified canonical rows in a private bucket, with ids
     replaced by numbers and no client or person names, so an earlier import can be re-run.
2. **"Keeps the previous one available."** *Default: every import stays listed in the Imports card with its columns and
   counts, and its columns are offered next time. Earlier rows can't be re-run (follows Q1).*
3. **Leads and invoices.** *Default: leads show leads a week per source beside Settings as a check only. Invoices show
   counts only. Neither changes the model. Leads a week is applied from a stage history or deals, as today; late
   payments wait for a cash model (D44).*
4. **Person columns** (time logs, deal owner, ticket assignee). *Default: they can be mapped (#40 lists "person") and
   are shown as "Person 1, 2…" in the preview. They are never stored, never matched to people and not used, because
   per-person times are #198 (parked).*
5. **Client columns on screen.** *Default: never shown. The preview labels them "Client 1…", and the mapper shows only
   how many different values there are (redesign note on #40: "never to show named clients").*
6. **Excel workbooks.** *Default: CSV, TSV and TXT only, with "Save it as CSV UTF-8". B19's workbook reader is
   server-only and returns text, not cells.*
7. **Remember name matches** (for example "Qualified lead → Qualify") between imports? *Default: no. Names from the file
   aren't stored (C2's rule), and exact names are matched again automatically.*
8. **Time logs propose hands-on time only?** *Default: yes. Time entries say nothing reliable about waits, branch odds or
   redo rates.*
9. **Wide deal exports** (one row per deal, a date column per stage)? *Default: not supported in C1. The note explains
   that a stage history is needed. A follow-up can add a "one column per stage" mode.*
10. **Where the wizard lives.** *Default: inline in each card of Historical data (stage history, clients and servicing,
    leads and invoices), plus an Imports card, rather than one separate import page.*
11. **Who may import.** *Default: as C2. Everyone can read and preview a file; owners and editors record; API tokens are
    refused.*
12. **Limits.** *Default: as C2. 20 MB and 200,000 rows per file.*
