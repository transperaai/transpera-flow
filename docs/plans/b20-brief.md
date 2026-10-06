# B20 build brief: Claude outside the app proposes findings (#197)

Scoped 6 Oct 2026 (overnight run) against `origin/main` merged locally with `origin/claude/amazing-planck-64op6x` (#205,
B1 2b: `person_labels`, labels not names, `ai:insight:<id>` keys). **Build on `main` after #205 has merged**; if it hasn't,
stop and report. Read `docs/plans/builder-brief.md` first: this brief adds to it and wins where they differ. Follow it
strictly. If something here doesn't match the code, **ask; don't guess.** Austin is asleep: where this brief lists an open
question, take its default.

## The short version

B17 (#175, PR #195) gave the connector read tools for analysis (`get_facts`, `list_findings`, `get_analysis`,
`list_sources`, `list_solutions`). B20 adds the write side: one MCP tool, **`propose_finding`**, that puts a **proposed**
finding into the analysis review list, where an owner or editor accepts, edits or dismisses it in the app exactly as they
do an AI finding.

| Piece | What |
|---|---|
| Database | Migration `20261212000000_connector_findings`: one nullable column `findings.proposed_via` (`'connector'` or null), one partial index, and `private.findings_before_write` redefined (copy of the 20261205000000 body plus the connector rules). Additive: no table, policy or grant changes; no data rewritten. |
| Storage shape | A connector finding is an **AI finding** (`origin = 'ai'`: Claude is AI) with `proposed_via = 'connector'`, `status = 'proposed'`, no `analysis_id` or `run_id`, and a key `ai:connector:<sha256 hex>` the trigger computes from its place and labelled title. So the review list, Accept/Edit/Dismiss, "AI, edited", Acknowledge as issue (`finding:ai:<id>`) and the map feed all work unchanged. |
| The trigger decides "connector" | A request made with an API token carries `api_token_id` in its JWT claims (`private.api_token_claims`). The trigger stamps `proposed_via` from that, never from what the client sent. A token request may only **insert a connector proposal**; it can't add a finding by hand (accepted), can't write an analysis-backed AI finding, and can't update any finding (no accept, dismiss or edit over the API). |
| MCP | `propose_finding` in `packages/mcp/src/findings-tools.ts`; pure checks in a new `packages/mcp/src/finding-proposal.ts`; `list_findings` says which findings came through the connector. |
| Privacy (#30) | Stored text holds **labels, not names** (`labelNames` + `person_labels`, as B1 2b does for AI); cited facts are computed from the **pay-free** model (as `apps/web/src/lib/ai/neutral.ts` `payFreeBundle`); a money figure in Claude's own words is refused unless it is in a cited pay-free fact. |
| App | The review list and the finding lists label these "Claude (connector)"; nothing else changes. |
| Docs | PRD §7.1 tool list, ADR 0015 addendum, extract-process skill one line, `docs/production-migrations.md` row. |

One PR, branch `claude/b20-mcp-findings` (this brief's branch; build on top of it), `Closes #197`. No engine change, no
golden change, no `ENGINE_VERSION` bump.

---

## Decisions (verbatim)

**Austin, 6 Oct, on #175 (posted by Claude as "Austin's answers on 6 Oct: he agrees with every recommendation"):**
> 1. **Accept doesn't create an issue.** Accept puts the finding on the Overview and the process page. Acknowledging it as an
>    issue stays a separate step, and only that step puts it on the map (D24). This is already how it works.
> 2. **Company analysis:** judged against the main pipeline's first principles, which must be written first. This is
>    already how it works.
> 3. **Connector writes:** yes. Claude outside the app may **propose** findings into the review list. They are proposals
>    only; a person still accepts them. This is a follow-up to build.
> 4. **Old rule settings:** stay as they are. They're kept but not read, and no setting comes back. This is already how it
>    works.
>
> The only new work is item 3, an MCP `propose_finding` tool. It joins the build queue.

**#197 (the ticket):**
> Austin decided on 6 Oct, on #175 (question 3): Claude outside the app (MCP) may **propose** findings into the analysis
> review list. They are proposals only: a person still accepts or dismisses each one in the app, exactly as with AI
> findings from B17 (#195).

> - [ ] A new MCP tool (e.g. `propose_finding`) creates a pending finding on a process, or company-wide. It is
>   evidence-backed like B17's findings: it cites facts, steps and/or sources, and the database checks the cited sources
>   are in the same workspace.
> - [ ] The finding records that it came from the connector (who and when), and the review list shows that.
> - [ ] Only roles that may write (agency admin, owner, editor) can propose. Members, viewers and read-only tokens are
>   refused (tests).
> - [ ] A proposed finding can't skip review: it can't be created as accepted.
> - [ ] Bad input gives clear errors: an unknown process, a fact key the analysis doesn't know, or a source from another
>   workspace.
> - [ ] The PostgREST e2e test covers propose, then accept in the app.
> - [ ] The extract-process skill or MCP docs mention the tool.

**Austin, 6 Oct, on #30 (B1): members and viewers get no pay data.**
> - `team_capacity` returns no cost rate for members and viewers, and nothing derived from rates.
> - Figures that depend on individual pay show "—" for them, with a short (i): "Only owners and editors see costs that
>   depend on people's pay." That's overtime cost and the cost attached to detected issues.

**Austin, 6 Oct evening, on #30 (B1 2b), from HANDOVER:**
> **Stored keys must hold no names:** `findings.ai_key`, the `ai:insight:` issue keys, source-link insight keys and saved
> insight keys are re-keyed to opaque ids (accepted: a finding may be proposed once more; old pre-B17 insights lose their
> "acknowledged" link). New finding keys hash the title with person ids, so they survive roster changes.

**Austin's Q2 on #30:** members see their own name, and "A team member" for anyone else.

**ADR 0002:** the MCP endpoint runs every query as the token's owner under RLS; a token can do no more than its owner. **The
role rule needs no new code**: `insert findings` is `can_edit_workspace` (agency admin, owner, editor).

**Orchestrator (this run):** findings proposed via MCP must hold no pay and follow #30's privacy rules.

---

## Audit: what exists vs what #197 needs

| Need | Today (main + #205) | Change |
|---|---|---|
| Write tool | None. MCP has only reads for findings (`packages/mcp/src/findings-tools.ts`). | `propose_finding` |
| Proposed status without an analysis | `findings_before_write` makes an AI insert cite an analysis the caller wrote in the last 15 min and its run; a `manual` insert must be `accepted`. Neither fits. | New branch in the trigger for token requests |
| "Came from the connector" | No column. `created_by`/`created_at` are stamped (who and when). | `proposed_via` stamped by the trigger from `auth.jwt() ? 'api_token_id'` (the pattern of 12 earlier migrations, e.g. `20261124000000_suggestions_v2.sql` `review_proposals`, `20261201000000_manual_entry.sql`) |
| Review can't be skipped | **Gap:** today an editor's API token, used straight against PostgREST (ADR 0002: a token works on the Data API), can insert a `manual` finding (born accepted) or PATCH a proposal to accepted. | Trigger: a token request may only insert a connector proposal and may not update any finding (`pg_trigger_depth() = 1`, as `suggestions` does) |
| Roles | RLS: insert/update `can_edit_workspace`; read `can_read_workspace`. Members/viewers get 42501. | None (tests only); the tool also pre-checks with `rpc('can_edit_workspace')` like `log_issue` (`analysis-tools.ts` ~line 392) so it refuses before any lookup |
| Sources same workspace | Trigger checks `source_ids` against `public.sources` of the workspace (23514). | None (tests); the tool also resolves sources in the workspace first, for a clear error |
| Process same workspace | Trigger checks (23514); tool resolves by `resolveProcess` | None |
| Fact keys known | B17 app: model cites `fact-a` ids it was given; unknown ids ignored. Connector has keys from `get_facts`. | Tool recomputes the facts (pay-free) and refuses unknown keys |
| Duplicates | Unique index `findings_ai_key` on (workspace, coalesce(process, zero uuid), `ai_key`) where `ai_key` not null | Trigger computes `ai_key` for connector rows, so the index refuses the same proposal twice (23505) |
| Names (#30 2b) | AI text stored with labels + `person_labels`; readers named by `nameFinding` (`packages/db/src/person-labels.ts`); `labelNames`, `labelsUsed`, `readPersonLabels` exist | Tool labels Claude's text, cited fact text and quote text before storing |
| Pay (#30) | Engine `payHidden` via `bundle.viewer.seesEveryone = false` (`packages/db/src/model.ts:284`); `apps/web/src/lib/ai/neutral.ts` `payFreeBundle` | Tool computes cited facts from the pay-free model; money in Claude's own words refused unless it is in a cited pay-free fact |
| Review list | `proposedFindings` (`apps/web/src/lib/findings/view.ts:82`) lists `status = 'proposed' && origin = 'ai'`; `AnalysisPanel` renders them | Badge per item; header wording; `sourceOf` label |
| Supersede by later analysis | `storeProposedFindings` supersedes only proposals whose `analysis_id` joins an analysis of the same scope (`ai_analyses!inner`) | None: connector proposals (no analysis) are never superseded by an in-app analysis |
| Workspace backup/restore (B10) | `findings` aren't in the bundle | None |
| `findingKey` / `finding:` issue keys | `finding:ai:<id>` for `origin = 'ai'` | None |

Latest definition of `private.findings_before_write`: **`20261205000000_analysis_findings.sql`** (B1 2b only disabled and
re-enabled it). Check again before you write the migration:
`grep -ln "function private.findings_before_write" packages/db/supabase/migrations/*.sql` must list only that file plus
yours. If B2–B4 or anything merged since redefined it, copy **that** body instead and say so in the PR.

---

## Data model and migration

**File:** `packages/db/supabase/migrations/20261212000000_connector_findings.sql`. **Apply file:**
`packages/db/scripts/apply/20261212000000_connector_findings.sql` (copy the shape of
`packages/db/scripts/apply/20261205000000_analysis_findings.sql`: header, `begin;`, `set local lock_timeout = '5s';`, the
migration SQL, the `insert into supabase_migrations.schema_migrations (version, name, statements) values
('20261212000000', 'connector_findings', array[$mig$…$mig$]);`, `commit;`). If another migration has merged with a higher
version by the time you open the PR, tell the orchestrator; don't renumber yourself.

### Schema

```sql
alter table public.findings
  add column proposed_via text constraint findings_proposed_via check (proposed_via is null or proposed_via = 'connector');

-- The connector's caps count recent proposals per workspace.
create index findings_connector_recent on public.findings (workspace_id, created_at) where proposed_via = 'connector';
```

`findings` has table-level grants (select, insert, update to authenticated), so the new column needs no grant. No policy
changes. `save_fields` is not touched.

### `private.findings_before_write` (create or replace; SECURITY INVOKER; `set search_path = ''`)

Copy the whole 20261205000000 body, then make exactly these changes (every name schema-qualified; `pg_catalog.` on
built-ins):

1. **Declare** `via_token boolean := coalesce(auth.jwt(), '{}'::jsonb) ? 'api_token_id';`
2. **Updates over the API are refused** (first statement after `begin`):
   ```sql
   if tg_op = 'UPDATE' and via_token and pg_catalog.pg_trigger_depth() = 1 then
     raise exception 'findings: a person reviews findings in the app, not over the API' using errcode = '42501';
   end if;
   ```
   (`pg_trigger_depth() = 1` lets foreign-key actions such as `created_by` → null on a user delete through.)
3. **Stamp and check the connector on insert** (before the existing process/source checks):
   ```sql
   if tg_op = 'INSERT' then
     new.proposed_via := case when via_token then 'connector' end;
     if via_token then
       if new.origin <> 'ai' or new.status <> 'proposed' or new.analysis_id is not null or new.run_id is not null then
         raise exception 'findings: over the connector a finding can only be proposed; a person accepts it in the app' using errcode = '42501';
       end if;
       -- One proposal per place and title: the unique index findings_ai_key refuses it again. Labels, never names (B1 2b).
       new.ai_key := 'ai:connector:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
         coalesce(new.process_id::text, 'company') || '|' || pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(new.title), '\s+', ' ', 'g')),
         'UTF8')), 'hex');
       perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('findings_connector:' || new.workspace_id::text, 0));
       if (select pg_catalog.count(*) from public.findings f where f.workspace_id = new.workspace_id and f.proposed_via = 'connector'
           and f.created_at > pg_catalog.now() - interval '24 hours') >= 100 then
         raise exception 'findings: this workspace has had 100 findings proposed over the connector in the last 24 hours' using errcode = '54000';
       end if;
       if (select pg_catalog.count(*) from public.findings f where f.workspace_id = new.workspace_id and f.proposed_via = 'connector'
           and f.status = 'proposed') >= 50 then
         raise exception 'findings: 50 findings proposed over the connector are waiting for review; review them in the app first' using errcode = '54000';
       end if;
     elsif new.ai_key like 'ai:connector:%' then
       raise exception 'findings: that key is kept for findings proposed over the connector' using errcode = '23514';
     end if;
   end if;
   ```
4. **The 15-minute analysis rule skips connector inserts:** change the condition
   `if (tg_op = 'INSERT' and new.origin = 'ai') or again then` to
   `if (tg_op = 'INSERT' and new.origin = 'ai' and not via_token) or again then`.
5. **`again` never applies to a connector finding:** add `and old.proposed_via is null` to the `again :=` expression.
6. **`proposed_via` never changes:** add `or new.proposed_via is distinct from old.proposed_via` to the update's
   immutable-columns check (and add "how it was proposed" to that message's list).

Everything else stays as it is: a connector finding is `origin = 'ai'`, so `edited` is set when a person changes it,
Accept/Dismiss stamp `decided_by`/`decided_at`, its `facts` can't change, it can't go back to proposed, and a superseded
one can't be decided. The insert branch's `new.created_by := coalesce(uid, …)` already records who (the token's owner).
`new.decided_by/at := null` for AI already applies.

The count queries read under the caller's RLS; the caller can edit the workspace (RLS `with check`), so it reads every
finding of it. Policies are checked after BEFORE triggers, so a viewer's insert takes the lock and is then refused by RLS:
harmless.

### Header (write all of this in the migration's header comment)

What changes (as above), why (#197; Austin's decision 3 on #175), and that it is **strictly additive**: one nullable
column, one partial index, one function redefined; no data rewritten; no grant, policy or trigger created or dropped.

**PREFLIGHT** (read-only; `bash packages/db/scripts/prod-sql.sh -f <file>`, one query per file):
1. Nothing at or past this version, and the previous row is the latest. Expect only versions below `20261212000000`, the
   highest being the previous row of `docs/production-migrations.md`:
   `select version from supabase_migrations.schema_migrations where version >= '20261205000000' order by 1;`
2. The column doesn't exist yet. Expect 0:
   `select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'findings' and column_name = 'proposed_via';`
3. The function body is the one this migration copied. Expect the md5 you record in the header (compute it from a local
   database built from every migration **before** yours: `select md5(prosrc) from pg_proc where proname = 'findings_before_write';`):
   `select md5(prosrc), prosecdef, proconfig from pg_proc where proname = 'findings_before_write';` (expect `<md5>, f, {search_path=""}`).
4. No key uses the new prefix. Expect 0: `select count(*) from public.findings where ai_key like 'ai:connector:%';`
5. The two triggers are there and enabled. Expect 2 rows, both `O`:
   `select tgname, tgenabled::text from pg_trigger where tgrelid = 'public.findings'::regclass and not tgisinternal order by 1;`
6. The helpers exist. Expect 1 row each: `select to_regprocedure('auth.jwt()'), to_regprocedure('pg_catalog.hashtextextended(text, bigint)');` (non-null x2).

**POST-APPLY CHECKS:**
1. Preflight 2 returns 1; `select data_type, is_nullable from information_schema.columns where table_name = 'findings' and column_name = 'proposed_via';` → `text, YES`.
2. `select pg_get_constraintdef(oid) from pg_constraint where conname = 'findings_proposed_via';` → the check.
3. `select indexdef from pg_indexes where indexname = 'findings_connector_recent';` → present, partial.
4. `select prosecdef, proconfig, prosrc like '%ai:connector:%' and prosrc like '%api_token_id%' from pg_proc where proname = 'findings_before_write';` → `f, {search_path=""}, t`.
5. Preflight 5 unchanged (2 rows, `O`).
6. `select count(*) from public.findings where proposed_via is not null;` → 0.
7. The `schema_migrations` row is present.

**ROLLBACK** (one transaction; redeploy the app from before B20 first, since it selects `proposed_via`):
```sql
begin;
-- Put back the 20261205000000 body of private.findings_before_write: paste it here in full (create or replace).
drop index if exists public.findings_connector_recent;
alter table public.findings drop column if exists proposed_via;
delete from supabase_migrations.schema_migrations where version = '20261212000000';
commit;
```
Write the full old function body into the rollback (not "see the other file"). Note: rolled back, connector proposals stay
as ordinary AI proposals (`ai_key` `ai:connector:…`, no analysis); people can still accept or dismiss them.

After writing it: `pnpm --filter @transpera-flow/db gen:bootstrap`. `gen:types` needs the linked project: **hand-edit**
`packages/db/src/database.types.ts` (`findings` Row: `proposed_via: string | null`; Insert and Update:
`proposed_via?: string | null`; keep the generator's alphabetical order). Add a `docs/production-migrations.md` row (the
next free number at merge time, "NOT applied") in the format of row 56.

---

## Exact files and functions

### `packages/db/src/person-labels.ts`
- **New** `labelsForPeople(people: readonly { id: string; name: string }[]): PersonLabels`: the same labels as
  `apps/web/src/lib/ai/facts.ts` `aliasesFor` (index `i` → `Team member A`…`Team member Z`, then `Team member ${i + 1}`),
  label → person id. Pure. Export from `packages/db/src/index.ts`. (Don't change `aliasesFor`.)

### `packages/db/src/types.ts`
- `FindingRow`: add `/** 'connector' when Claude proposed it over the MCP connector (B20); null otherwise. Set by the database. */ proposed_via: "connector" | null;`
- The `Assert<Matches<Omit<FindingRow, …>, "findings">>` line: add `"proposed_via"` to the omitted keys (it is check-constrained).

### `packages/db/src/findings.ts`
- `FINDING_COLUMNS`: append `proposed_via`.
- **New** `proposeConnectorFinding(db, input): Promise<FindingWrite | { status: "duplicate" } | { status: "limit"; message: string }>`
  where `input = { workspaceId, processId: string | null, stepId: string | null, rating, type, title, evidence, why, facts: FindingCitation[], sourceIds: string[], personLabels: PersonLabels }`.
  Runs `findingDraftProblem` on it first; inserts `{ workspace_id, process_id, step_id, origin: "ai", status: "proposed", rating, type, title, evidence, why, facts, source_ids, person_labels }`
  (no `ai_key`: the trigger sets it; the check constraint runs after the trigger), `.select(FINDING_COLUMNS).single()`.
  Errors: 23505 → `{ status: "duplicate" }`; 54000 → `{ status: "limit", message }` (the database's message without the
  `findings: ` prefix); otherwise `failed(error)` (42501 → forbidden, 23514 → invalid).
- Update the module comment: connector proposals (B20).

### `packages/mcp/src/finding-proposal.ts` (new, pure, no database)
- `const LABEL_IN_TEXT = /\bTeam member (?:[A-Z]|\d{1,4})\b/` and `hasLabel(texts: string[]): boolean`.
- `moneyFigures(text: string): string[]`: every money amount: a currency symbol (`£ $ € A$ NZ$ C$`) or ISO code
  (`GBP USD EUR AUD NZD CAD`, either side) next to a number (`1,234`, `1234.50`, `1.2`), with an optional `k`, `K`, `m`,
  `M`, `bn` suffix. Returned normalised: lower case, no spaces.
- `unsupportedMoney(texts: string[], factTexts: string[]): string[]`: the figures of `texts` not found (normalised) in any of
  `factTexts`' figures. Order kept, duplicates removed.
- `squeeze(s)`: as `apps/web/src/lib/ai/facts.ts` `squeeze` (lower case, curly quotes straight, whitespace to one space,
  trimmed). Copy it; don't import from apps/web.
- `quoteIn(body: string, quote: string): boolean`: `squeeze(body).includes(squeeze(quote))` and `squeeze(quote).length >= 10`.

### `packages/mcp/src/findings-tools.ts`
- **Refactor** the body of `get_facts` (from `loadLiveModel` to `all`) into an exported
  `async function liveFacts(ctx, ws, proc, assumptions, { payFree }: { payFree: boolean }): Promise<{ loaded, facts: DetectedIssue[], steps: Map<string, string> }>`.
  `payFree: true` builds the model from `{ ...bundle, viewer: { seesEveryone: false, ownPersonId: null } }` (copy
  `payFreeBundle` from `apps/web/src/lib/ai/neutral.ts` as a one-line local helper, with a comment naming that file).
  `loadLiveModel` builds its model inside; add an optional `{ payFree }` option to `loadLiveModel` in
  `analysis-tools.ts` that applies the same before `toEngineModel`. `get_facts` keeps `payFree: false` and its output is
  byte-for-byte unchanged (its tests must pass untouched).
- `FINDINGS_TOOL_NAMES`: add `"propose_finding"`.
- `list_findings`: select `proposed_via`; each AI finding gets `proposed_via: f.proposed_via === "connector" ? "connector" : "app"`;
  update the description ("…AI findings, proposed by the app's Analyse or by Claude over this connector…").
- **New tool `propose_finding`** (below).

### `apps/web/src/lib/insights/insights.ts`
- `Detection`: add `/** Claude proposed it over the MCP connector (B20). */ via?: "connector";`
- `InsightSource` `ai` names: add `"Claude (connector)" | "Claude (connector), edited"`.
- `sourceOf`: for `d.origin === "ai" && d.via === "connector"` return `{ kind: "ai", name: d.edited ? "Claude (connector), edited" : "Claude (connector)", ...(d.edited ? { edited: true } : {}) }`.

### `apps/web/src/lib/findings/view.ts`
- `findingDetection`: add `...(f.proposed_via === "connector" ? { via: "connector" as const } : {})`.

### `apps/web/src/components/findings/analysis-panel.tsx`
- Per review item, in the meta line after the step: when `f.proposed_via === "connector"`,
  `<span data-via-connector>From Claude (connector) · {when(f.created_at)}</span>`.
- Header hint: when every item is from the app keep "AI proposed these. Only the ones you accept show on the pages.";
  when any is from the connector: "AI in the app or Claude (connector) proposed these. Only the ones you accept show on the pages."
- Viewer line unchanged.

### Row builders that construct a `FindingRow` by hand
- `apps/web/src/lib/findings/use-findings.ts` (~line 50), `apps/web/src/lib/findings/demo.ts` (~line 30), and any test
  fixture the typecheck flags: add `proposed_via: null`.

### Docs
- `docs/PRD.md` §7.1 tool list: after the B17 line add
  `propose_finding({title, rating, type, process? | company, step?, evidence?, why?, facts?, quotes?, sources?})  -> a proposed finding for review in the app (B20)`.
- `docs/adr/0015-analysis-findings.md`: an addendum paragraph "**Connector proposals (B20, #197, migration
  20261212000000).**" saying: what the tool does; stored as AI findings with `proposed_via = 'connector'` stamped from the
  token's claims; a token may only insert proposals and never update a finding; key and caps; labels and pay-free facts;
  money rule; the review list labels them.
- `.agents/skills/extract-process/SKILL.md` (`.claude/skills/extract-process` links to it): one line in the closing
  steps: "Once the process is published and the facts are in (`get_facts`), you may propose findings for the team to review
  with `propose_finding`, citing the fact keys and the sources' quotes; a person accepts them in the app."
- `docs/supabase-notes.md`: add that `auth.jwt() ? 'api_token_id'` inside a BEFORE trigger and the advisory lock were
  verified on plain Postgres and the CI PostgREST only.

---

## The tool: `propose_finding`

Register in `registerFindingsTools`, after `list_findings`. No `readOnlyHint` (it writes); `annotations: { destructiveHint: false, idempotentHint: false }`.

**Description** (use this): "Propose a finding for the team to review in the app: what you conclude from the facts
(get_facts) and the sources (list_sources), on a process or across the company. It arrives as proposed in the analysis
review list, marked as from Claude (connector); an owner or editor accepts, edits or dismisses it. It must cite at least
one fact key or source. Write people's names as the tools show them: the app stores labels and shows each reader the
names they may see. Money in your words must be a figure from a fact you cite. Owners, editors and agency admins only."

**Input schema** (zod; reuse `workspaceArg`, `RATINGS` from the engine, `FINDING_TYPES` and `FINDING_LIMITS` from db):
- `title`: string, trim, 1..200.
- `rating`: `z.enum(RATINGS)` (required).
- `type`: `z.enum(FINDING_TYPES)` (required).
- `evidence`, `why`: string ≤ 2000, optional (default "").
- `process`: string, optional ("Process the finding is about (id or name). Defaults to the workspace's only process.").
- `company`: boolean, optional ("Across the whole company instead of one process.").
- `step`: string, optional ("A step of the process's live version (id or name).").
- `facts`: array of string (fact keys), max 30, optional.
- `facts_from`: string, optional ("For a company-wide finding: the process whose facts you cite. Defaults to the main pipeline.").
- `quotes`: array of `{ source: string, text: string(10..1000) }`, max 10, optional ("Passages quoted word for word from a source").
- `sources`: array of string (source id or title), max 20, optional.
- `workspace`.

**Order of work** (`runTool(async (assumptions) => …)`):
1. `ws = resolveWorkspace(…)`. Then, before any lookup (a member must learn nothing from not-found answers, as
   `log_issue` does): `rpc("can_edit_workspace", { ws: ws.id })`; not `true` → `ToolError("forbidden", "You don't have permission to propose findings in this workspace (owners, editors and agency admins can).")`.
2. Shape: `company` with `process` or `step` → `ToolError("invalid_input", "A company-wide finding sits on no process or step; drop process and step, or company.")`.
   `facts_from` without `company` → `invalid_input` ("facts_from is for company-wide findings; a process finding cites its own process's facts").
   `hasLabel([title, evidence, why, ...quotes.text])` → `invalid_input` ("Write people's names as get_process shows them, not \"Team member\" labels: the app labels names itself.").
3. Place: `company` → `processId = null`, `factsProc = facts_from ? resolveProcess(…, facts_from) : (facts.length ? resolveProcess(…, undefined) : null)`
   (the default pipeline; an `ambiguous` error from it stands, with its candidates). Otherwise
   `proc = resolveProcess(ctx, ws, args.process, assumptions)` (unknown → its `not_found` with the list; the company map →
   its `company_map` error), `processId = proc.id`, `factsProc = proc`.
4. Step (process findings only): from the **live** revision only (`steps` where `revision_id = proc.live_revision_id`;
   no live version → `ToolError("not_found", "'<name>' has no live version yet; publish it first")`), `matchNamed(…, "step", " in '<name>'")`.
5. Sources: if `sources.length || quotes.length`, load the workspace's sources (`id, title, body`, `eq("workspace_id", ws.id)`),
   map to `{ id, name: title, body }`, `matchNamed` each ref (unknown or another workspace's id → its `not_found`, which
   lists the workspace's sources). Each quote: its source resolved the same way; `quoteIn(body, text)` false →
   `ToolError("quote_not_found", "That passage isn't in '<title>' word for word: <first 80 chars>…")`. `sourceIds` = the
   distinct ids of `sources` and the quotes' sources; more than 20 → `invalid_input`.
6. Facts: if `facts.length`: `factsProc` must have a live version; `liveFacts(ctx, ws, factsProc, assumptions, { payFree: true })`.
   Keys not among them → `ToolError("unknown_fact", "Not facts of the live run of '<name>': k1, k2. get_facts lists the keys.", knownKeys.slice(0, 40).map((key) => ({ key })))`.
   Citation text = `` `${f.title}. ${f.evidence}`.slice(0, 600) `` (the app's shape, `apps/web/src/lib/ai/facts.ts` `factRefs`).
7. Evidence-backed: no facts, no quotes and no sources → `invalid_input` ("Cite at least one fact (get_facts) or source (list_sources): a finding rests on evidence.").
8. Pay: `unsupportedMoney([title, evidence, why], factTexts)` non-empty → `ToolError("money_not_in_facts", "These figures aren't in a fact you cite: £1,234. Members and viewers get no pay data, so a finding states money only as a cited fact states it (pay-dependent costs read \"—\" there). Cite the fact, or leave the figure out.")`.
9. Labels: `team = await loadTeam(ctx.db, ws.id)`; `labels = labelsForPeople(team.people)`;
   `lab = (s) => labelNames(s, labels, team.people)`. Stored title/evidence/why = `lab(…)`, sliced to `FINDING_LIMITS`;
   fact citation text and quote text `lab(…)` too. `personLabels = labelsUsed([title, evidence, why, ...citationTexts], labels)`
   (on the labelled texts).
10. Duplicate (soft, any origin): read `findings` of the workspace with `status in (proposed, accepted)` and the same place
    (`process_id = processId`, or `is null`) — `id, title, status, origin, proposed_via` — and refuse when
    `squeeze(stored title) === squeeze(labelled title)`:
    `ToolError("duplicate", "There's already a finding with that title here (<status>).", [{ id, status }])`.
11. `proposeConnectorFinding(db, …)`. `duplicate` → `ToolError("duplicate", "Claude proposed this here before; a person has it already (it may have been accepted or dismissed). list_findings shows it.")`;
    `limit` → `ToolError("rate_limited", message)`; `forbidden` → the step 1 error; `invalid` → `invalid_input`; `error` → `write_failed`.
12. Return `{ workspace, finding: { id, status: "proposed", origin: "ai", proposed_via: "connector", rating, type, title, evidence, why (all named back with nameFinding(row, team)), process: { id, name } | null, across_the_company, step: { id, name } | null, rests_on, source_ids, created_at }, review: "Waiting for review on <process name>'s page (or the Overview for the whole company). An owner or editor accepts, edits or dismisses it." }`.

Assumptions pushed: the defaulted process, `facts_from` defaulted, "Facts were checked against a fresh run of the live
model at 30 replications, seed 1, with pay hidden (as members see it)."

---

## Patterns to copy

| What | From |
|---|---|
| Role pre-check before lookups | `log_issue`, `packages/mcp/src/analysis-tools.ts` (~line 390) |
| Write error mapping | `writeError` in `analysis-tools.ts`; `failed` in `packages/db/src/findings.ts` |
| Token detection in SQL, `pg_trigger_depth() = 1` | `private.suggestions_before_write` (`20261015000000_suggestions.sql` ~line 223), `review_proposals` (`20261124000000_suggestions_v2.sql` ~line 215) |
| Advisory lock + count cap | `public.reserve_ai_run` (`20261121000000_ai_analysis.sql`) |
| Migration header with preflight, post-apply, rollback | `20261205000000_analysis_findings.sql`, `20261207700000_saved_text_privacy.sql` |
| Labels and naming | `labelNames`, `labelsUsed`, `nameFinding` (`packages/db/src/person-labels.ts`); `editFinding` (`apps/web/src/app/w/[slug]/findings-actions.ts`) |
| Pay-free model | `payFreeBundle` (`apps/web/src/lib/ai/neutral.ts`) |
| Plain-Postgres trigger tests as a token | `commitAs({ ...editor.claims, api_token_id: "t1" }, …)` in `packages/db/test/calibration.test.ts` |
| PostgREST e2e with tokens | `packages/mcp/test/postgrest-findings.test.ts` (setup, `apiToken`, `connect`, `call`) |
| Pay leak check | `packages/mcp/test/postgrest-roles.test.ts` (~line 230: distinctive rates, then search what came back) |

---

## Edge cases (and what happens)

- **Roles:** agency admin, owner, editor: allowed. Member, viewer: `forbidden` from the pre-check; directly over PostgREST,
  RLS refuses (42501). A token of a user with no membership: `resolveWorkspace` → `not_found`. There is no read-only token
  type (`api_tokens` has no scope column): "read-only tokens" in #197 are the tokens of members and viewers.
- **Skipping review:** a token can't insert `manual` (born accepted), can't insert `status = 'accepted'`, can't insert an
  analysis-backed AI finding, and can't PATCH any finding (accept, dismiss, edit, supersede). All 42501 from the trigger.
- **Forging "connector":** a session (no token) sending `proposed_via = 'connector'` gets null stamped; sending an
  `ai:connector:` key is refused (23514). A session can't make an AI finding without an analysis (unchanged rule).
- **Duplicates:** same place + same title (case and spacing ignored, after labelling): refused by the tool (any origin,
  proposed or accepted) and by the unique index (connector rows, any status, including dismissed: a person's dismissal
  stands, D38). The same title on another process, or company-wide, is allowed. Accepted limit: different labels after a
  roster change can make a new key for the same words.
- **Rate limits:** the token's 120 requests a minute (`use_api_token`, unchanged); per workspace at most 100 connector
  proposals in 24 hours and 50 waiting for review (trigger, 54000 → `rate_limited`). The facts run is time-capped like
  `get_facts` (absence test and shadow prices 5 s each).
- **Provenance:** `created_by` (the token's owner) and `created_at` stamped by the trigger; `proposed_via = 'connector'`.
  The review list shows "From Claude (connector) · <date>"; `list_findings` returns `proposed_via`. The token id isn't
  stored (open question 3).
- **Names:** a person's full name, and a unique first name of 3+ letters, become labels before storing (`labelNames`); a
  nickname or misspelling is stored as typed (as for an editor's edit). Members read "A team member" (`nameFinding`).
  Text that already contains a "Team member X" label is refused (it would be mapped to whoever holds that letter).
- **Pay:** cited facts come from the pay-free model (overtime and person-rate issue costs are "—"; the overtime sentence
  states hours only since engine 1.8.0). Claude's own words may state money only as a cited fact states it. Accepted limit:
  money written without a symbol or code ("1,234 a month") isn't recognised; an editor can type the same into a finding by
  hand, which is human-typed text.
- **Facts drift:** facts are recomputed at proposal time; a key from an older `get_facts` call that the run no longer
  shows is `unknown_fact`. Keys don't depend on pay, so a key from an editor's `get_facts` exists in the pay-free run (if a
  test shows otherwise, stop and report).
- **Company-wide:** `process_id` null, no step; facts from `facts_from` or the default pipeline. It shows in the
  Overview's review list.
- **Process with no live version:** allowed when citing only sources; a step or facts need a live version.
- **The company map:** `resolveProcess` refuses it (`company_map`), as for every other tool.
- **Later in-app analyses** never supersede a connector proposal (they supersede only proposals of their own analyses).
- **Process deleted / archived:** findings cascade on delete (unchanged); an archived process's findings stay.
- **Workspace restore (B10):** findings aren't in the bundle; nothing to do.

---

## Tests (write them first where you can; never weaken an existing one)

**`packages/db/test/connector-findings.test.ts`** (plain Postgres, Northbeam; `commitAs` with `api_token_id`):
1. An editor's token inserts `origin ai, status proposed` with no analysis: stored with `proposed_via = 'connector'`,
   `ai_key` matching `^ai:connector:[0-9a-f]{64}$`, `created_by` = editor, `decided_by` null, `edited` false.
2. Token insert refused (42501) for: `status accepted`; `origin manual`; with an `analysis_id` and `run_id` of the editor's
   own fresh analysis.
3. Token update refused (42501): accept, dismiss, title edit, on a connector proposal and on an app AI proposal.
4. Session (no token) editor: accept a connector proposal → `accepted`, `decided_by` = editor, `proposed_via` unchanged;
   edit its title → `edited` true; set `proposed_via` to null → refused (23514).
5. Session insert sending `proposed_via: 'connector'` (manual, accepted) → stored null; session insert with an
   `ai:connector:` key → refused.
6. Same title (different case/spacing) and place twice by token → 23505; same title on another process and company-wide → allowed.
7. Member and viewer tokens → refused (RLS, 42501).
8. A source of another workspace in `source_ids` → 23514 (existing rule, as a token).
9. Caps: seed 100 connector rows in the last 24 h (administrator, `session_replication_role = replica`), the next → 54000;
   with 50 waiting, the next → 54000, and after dismissing one in the app it goes through.
10. `findings.test.ts` passes unchanged (the in-app AI path).

**`packages/db/test/person-labels.test.ts`:** `labelsForPeople` gives A…Z then 27, 28 for 28 people, and matches
`aliasesFor`'s labels for the same list (import both; the web test may live in `apps/web/test` instead if a package can't
import apps/web: put the parity test in `apps/web/test/ai-analysis.test.ts`).

**`packages/mcp/test/finding-proposal.test.ts`** (pure): `moneyFigures` finds `£1,234`, `$12.5k`, `1,200 GBP`, `EUR 40`,
`A$900`, ignores `12 hours`, `40%`, `3 days`; `unsupportedMoney` passes a figure present in a fact text and refuses one that
isn't; `hasLabel`; `quoteIn` (curly quotes, spacing, case; under 10 characters refused).

**`packages/mcp/test/postgrest-findings.test.ts`** (extend; reuse its workspace, Maya Collins, Strategist, Sales):
1. **Propose, then accept in the app:** the editor's token calls `get_facts`, then `propose_finding` on Sales with
   `step: "Write proposal"`, one fact key from it, a quote from a source added for the test, a title naming "Maya
   Collins". `ok`; the row (read as administrator) has `status proposed`, `proposed_via connector`, a title with
   `Team member A` and not "Maya", `person_labels` mapping it to Maya's id, the source id in `source_ids`. `list_findings`
   over the editor's token shows it with Maya's name and `proposed_via: "connector"`; over a viewer's token, "a team
   member"/"A team member". Then the editor's **session** calls `setFindingStatus(editor, id, "accepted")` → saved;
   `list_findings` shows it `accepted`.
2. The editor's token straight against PostgREST (`x-api-token` header, anon key) PATCHing the proposal to accepted →
   refused; inserting a `manual` accepted finding → refused.
3. Viewer token → `forbidden`; a member token too (add a member user and token); the stranger's token naming the
   workspace → `not_found`.
4. Bad input: unknown process → `not_found`; unknown fact key → `unknown_fact`; another workspace's source id →
   `not_found`; a quote not in the source → `quote_not_found`; `company` with `step` → `invalid_input`; no evidence →
   `invalid_input`; a "Team member B" in the title → `invalid_input`; `£9,999` not in any cited fact → `money_not_in_facts`;
   the same proposal twice → `duplicate`.
5. **No pay:** give Maya a distinctive `cost_rate` (e.g. 913.37) for the test (restore it after), propose citing an
   overload/overtime fact; the stored row (`select * … ::text`) contains neither `913` nor the `cost.per_month` the
   editor's `get_facts` showed for that fact (when it is a number).
6. A company-wide proposal (`company: true`, facts from the default pipeline) → `process_id` null.

**`packages/mcp/test/handler.test.ts`:** passes once `TOOL_NAMES` includes the tool (it compares lists).

**`apps/web/test/findings.test.ts`** (or `insights.test.ts`): `findingDetection` of a connector row has `via:
"connector"`; `sourceOf` gives "Claude (connector)" and, edited, "Claude (connector), edited".

**`apps/web/test/findings-browser.test.ts`:** a proposed connector finding in the review list shows "From Claude
(connector)" and the connector header hint; Accept works as for an AI proposal.

Run everything per `builder-brief.md` (`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build`)
and the PostgREST suites if you can run PostgREST locally; otherwise say so and rely on CI.

---

## Out of scope

- Claude accepting, dismissing, editing or withdrawing findings over the connector (Austin: proposals only).
- Proposing several findings in one call; a batch tool.
- Acknowledging a finding as an issue over the connector (`log_issue` stays as it is).
- Numbers checked against the run beyond the money rule (ADR 0013's checker lives in `apps/web`; moving it is a refactor
  for later).
- Showing the proposer's name in the review list (needs a new name lookup for editors; open question 2).
- Expiring old connector proposals; superseding them.
- Findings in B3's redacted share snapshots (B3 must treat `proposed_via` findings like other AI findings).
- Regenerating `database.types.ts` from the linked project; anything in production (the orchestrator applies).

## Done criteria

- [ ] Migration, apply file, header (preflight with the recorded md5, post-apply, full rollback with the old body), bootstrap
      regenerated, types hand-edited, production-migrations row "NOT applied".
- [ ] `propose_finding` as specified; `list_findings` returns `proposed_via`; `get_facts` output unchanged.
- [ ] The review list and finding lists label connector findings; accept/edit/dismiss unchanged.
- [ ] Every test above, green locally (except the known container-only failures) and in CI, including the PostgREST suites.
- [ ] PRD §7.1, ADR 0015 addendum, extract-process skill line, supabase-notes.
- [ ] Draft PR with `Closes #197`, the migration version and apply file path, the preflight list, "no engine change"; the
      defaults taken below listed in the PR body so the orchestrator can record them on #197.

---

## Open questions (each with a default; the builder takes the default)

1. **New origin value or a flag?** Default: **a flag** (`origin = 'ai'`, `proposed_via = 'connector'`). A new `origin`
   would mean replacing two check constraints and teaching every `origin === "ai"` reader about it; a flag is additive and
   the review flow is the AI flow, which is what #197 asks for ("exactly as with AI findings from B17").
2. **Show who proposed it in the review list?** Default: **no name, date only** ("From Claude (connector) · 6 Oct 2026").
   `created_by` records who; editors have no way to turn a user id into a name today (`workspace_members` is owner-only),
   and a stored name would be read by members (#30). In practice the connector is Austin's.
3. **Store which token?** Default: **no.** `created_by` and `created_at` answer who and when; the token id would add a
   column members can read for little gain.
4. **Caps.** Default: **100 connector proposals per workspace per 24 hours, 50 waiting at once.** (The app's AI can propose
   up to 8 per run, 40 runs a day.)
5. **Must a finding cite a fact when the process has facts?** Default: **no**: at least one fact **or** source. A finding
   from an interview quote alone is evidence-backed; the review shows "Cites no facts" as it does today.
6. **Company-wide facts.** Default: **the default pipeline's live run** (or `facts_from`), not a whole-company model run:
   the connector has no company-model fact tool today; company analysis is judged against the main pipeline (Austin's
   decision 2).
7. **Money in Claude's words.** Default: **refuse any money figure not in a cited pay-free fact** (rather than allow it, or
   refuse all money).
8. **Steps from a draft.** Default: **live version only**, since the facts it rests on are the live run's.
