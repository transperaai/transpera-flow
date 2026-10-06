# B4 build brief: play links, with proposals landing in Suggestions (#33)

Scoped 6 Oct 2026 (overnight run) against `origin/main` at 183b8f52 (#210) and `origin/claude/b3-share-links` at aeaad602
(B3 steps 1–6 of 7, PR not merged). Read `docs/plans/builder-brief.md` first, then `docs/plans/b3-brief.md` (on `main` once B3
merges); this brief adds to both and wins where they differ. Follow it strictly. If something here is unclear or doesn't match
the code, **ask; don't guess.** Austin is asleep for this run: every open question at the end has a default, and you take it.

**Build only after B3 (#32) has merged into `main`.** Branch `claude/b4-play-links` from the `main` that contains B3. This
brief is the branch's first commit; rebase or merge `main` onto it before you start.

## Read this first: what needs Austin, and what doesn't

- **No new secret, no paid service.** The visitor's reply is stored, not emailed (no SMTP: HANDOVER "Other open items"). The
  owner or editor sees the visitor's email and replies themselves (Q6).
- **Design calls for Austin to confirm, not blocking** (take the defaults, record them on #33 and in the HANDOVER's "Design
  calls Claude made"): play mode only on **process** links (Q1); a visitor's idea may be for **no issue** (Q2), which widens
  one check constraint; **lever changes in a solution now count** wherever a solution is simulated (Q3); visitor names are
  shown to everyone who reads Suggestions, emails only to owners and editors (Q5).
- **Ids:** B3 keeps **real ids** in snapshots (B3 Q5: ids seed the random streams). So "redacted IDs mapped back to real ones"
  means: the database checks every id a visitor sends **is in the link's snapshot and belongs to the workspace**, and Build it
  checks each again against today's live process and drops (with a note) any that no longer exist. Nothing is translated.

## Where B4 depends on B3 details that may still change in B3's review

Re-read each of these on `main` after B3 merges and adapt; if one has changed in a way this brief doesn't cover, **ask**.

| B3 detail | Used by B4 for | If it changed |
|---|---|---|
| `private.share_links_before_write()` body (refuses `mode <> 'view'`) | B4 replaces it with `create or replace` | Copy the **merged** body, change only the play lines below; update the preflight md5 |
| `public.open_share_link(text)` body (`and s.mode = 'view'`) | B4 replaces it | Same: copy merged body, change only the mode filter |
| Insert grant on `share_links` (omits `mode`) | B4 grants `insert (mode)` | If B3 already granted it, skip and say so |
| Migration version `20261211000000` | Preflight 0 | Use B3's merged version |
| `ProcessShare` shape and `loadShareData` (`packages/db/src/share.ts`) | Adds `hiddenLevers` | Keep the field name; put it where the process snapshot is built |
| `share_snapshot_problem` check 1 (`v = 1`, `kind`, toggles) | Play links keep `v: 1` | If B3 bumped `SHARE_SNAPSHOT_VERSION`, use its value |
| `SharedView`, `ProcessScreen`, `ShareBar` (`components/share/shared-view.tsx`) | Play section and bar wording | Hook in at the same places |
| `ScreenMode` / `isReadOnly` / `usesServer` (`lib/mode.ts`), `mode="share"` on `ProcessPage` | B4 adds **no** new mode | — |
| `parseShareInput` / `ShareInput` (`lib/share/input.ts`), `createShareLink` (`app/w/[slug]/share-actions.ts`), `ShareDialog`, `ShareLinksTable` | Play switch | Same fields, add one |
| `SHARE_TOKEN` (`lib/share/after-sign-in.ts`), `app/s/[token]/page.tsx`, `app/s/[token]/actions.ts` | Submit action, page passes `mode` | Same files |
| ADR `0016-share-links.md` | B4 appends an addendum | If B3 numbered it differently, use that file |
| PRD §13 row B3 adds (D44 is taken by C2, so B3's is the next free number) | B4 adds the next free D number | Count at merge time |
| `role-matrix.test.ts` `RPCS` entries for B3 | B4 adds two | — |

## The short version

| What | Where |
|---|---|
| A process share link can be a **play** link: the visitor moves the workspace's shown levers on the redacted snapshot, in the browser; nothing is saved; reloading puts everything back | Share dialog switch; `SharedView` play section |
| `public.submit_play_proposal(...)`: the **only** write a play link can make; rate-limited, size-limited, every id checked | migration `20261217000000_play_links` |
| The visitor's idea lands in **Suggestions** as a solution idea (`created_via = 'play_link'`), with name, note and the changes | `suggestion_proposals` (+ `share_link_id`) |
| Owners and editors see the changes and the visitor's email, **Build it** (Editor in solution mode with the lever changes placed) or **Dismiss** with a reply | `IdeaCard`, `WorkspaceEditorPage`, `EditorView` |
| A solution's `lever_changes` are applied wherever a solution is simulated (Editor, server verdict, solution page, Overview impact, demo) | `apps/web/src/lib/solutions/levers.ts` |
| Fix: deleting a user who created or reviewed a `suggestions` row no longer fails (HANDOVER follow-up) | same migration |

One branch, one PR: `claude/b4-play-links`. `Closes #33`. Migration version **`20261217000000`**, name **`play_links`**.
**No engine change**, no `ENGINE_VERSION` bump, no golden moves (no stored solution has lever changes; preflight 4 checks it).

Build in this order, **commit and push after each step**:
1. Migration + apply file + `database.types.ts` hand edits + bootstrap + DB tests (`play-links.test.ts`, role matrix, the
   suggestions FK fix test).
2. `packages/db`: snapshot `hiddenLevers`, proposal types and columns, the restore planner skip; pure tests.
3. Solutions honour lever changes (`lib/solutions/levers.ts` and its five callers) + tests.
4. Play mode for visitors: Share dialog switch, `SharedView` play section, `SendIdea` dialog, submit Server Action + browser test.
5. Suggestions: the visitor's idea card, contacts, Dismiss with a reply, Build it for an idea with no issue, the Editor's lever
   changes + tests.
6. PostgREST e2e (`postgrest-play-links.test.ts`).
7. Docs: ADR addendum, `docs/supabase-notes.md`, `docs/production-migrations.md` row (NOT applied), PRD §4.1/§9/§13.

---

## Decisions (verbatim)

**#33 (the ticket), "What to build":**
> Let people outside the workspace try their own ideas and send them back. A share link in `play` mode loads the redacted
> snapshot and runs the engine client-side with the visible levers enabled (Settings → Levers, A58, #123); nothing is saved. A
> visitor can name what they built and submit it with a note, name and email.
>
> Submission goes through a rate-limited Postgres function; it is the only write a play link can make. There is no separate
> Proposals queue: a visitor's proposal arrives in **Suggestions** (A52, #117) as a solution idea, marked with the visitor's
> name. Owners and editors see the changes, can Build it (opens the Editor in solution mode with the changes placed, redacted
> IDs mapped back to real ones server-side) or Dismiss with a reply (PRD §4.1 Workspaces and access, §9).

**#33 acceptance criteria:**
> - Play mode runs levers client-side on the redacted snapshot; reloading the page discards changes
> - Submit creates a suggestion via the rate-limited function; the play link can make no other write (test)
> - Visitor proposals show in Suggestions with the visitor's name, note and changes
> - Build it maps redacted IDs back to real ones and opens a solution in the Editor (test)
> - Proposals never auto-apply
> - Every setting, lever and rule on this screen has an (i) with a plain-English description and an example
> - Wording follows the prototype's plain language

**Austin, 6 Oct, on #30 (applies to everything a link shows):**
> **members and viewers get no pay data.** [...] Any average also gives a rate away over time when people join or leave.

> **What members and viewers receive:** the per-person simulation inputs under neutral labels ("Team member 3"). This covers
> hours, roles, leave, skills and client assignments. Names, emails and notes are left out.

Orchestrator for B3, which B4 inherits: *"Redaction must follow #30's rules: no pay, no names beyond labels."* B4 sends
**nothing new** to the visitor beyond B3's snapshot plus the workspace's list of hidden lever kinds.

**Austin, 6 Oct, on #30 Q10 (typed text):**
> an issue title an editor pre-fills from an insight keeps the real name (like any typed title)

(B4 follows it: what a visitor types is stored as typed, Q7.)

**PRD §4.1 Glossary:**
> **Lever**: a "what if" dial on a setting, such as more leads or faster proposals. Levers change numbers, not steps. A
> solution can include lever changes.

**PRD §9, Share links:**
> The only write a play link can make is a scenario submission (name, email, note, patch against redacted IDs), via a
> rate-limited Postgres function into `scenario_submissions`. IDs are mapped back server-side on accept.

and §12: *"Decided: play links can submit scenarios for acceptance (Proposals queue). Submissions are rate-limited per link
and never auto-apply."* **Superseded by D37** (*"B4's proposals arrive in Suggestions"*) and the ticket: no
`scenario_submissions` table; proposals go into `suggestion_proposals`.

**`docs/plans/redesign-plan.md`, B4 row:**
> **Rewrite**: A visitor's proposal arrives in Suggestions (A52), not a separate queue.

**A52's migration header (`20261124000000_suggestions_v2.sql`):**
> B4's play links (#33) will insert their visitors' proposals as solution ideas with `created_via = 'play_link'` and the
> visitor's name and email, through their own rate-limited function [...] A visitor's email is not readable by the app's
> users: SELECT is granted column by column, leaving it out. B4 decides who may see it and how.

**B3 brief, "Out of scope":**
> `mode` accepts `'play'` in the table check, but the trigger refuses it and the insert grant omits `mode`. B4 replaces the
> trigger function, adds the grant, enables levers in `SharedView`, and adds the submission function. Snapshots already carry
> full engine inputs (redacted), so B4 needs no new snapshot fields for levers; it will need `lever_settings` (add it to the
> process/overview snapshot then).

**HANDOVER, follow-up (bundled here, Q10):**
> The `suggestions` table (20261015000000) has the same bug A52 fixed for `suggestion_proposals`: deleting an auth user who
> created or reviewed a suggestion fails, because the foreign key's `ON DELETE SET NULL` trips the `suggestions_before_write`
> guard [...] Fix it with a new migration that lets a depth > 1 change of only `created_by` or `reviewed_by` to null through
> (see `private.suggestion_proposals_before_write`).

**HANDOVER, "Rules while Austin is away":** take the brief's default for open questions; stop and skip anything needing a new
secret, a paid service, or a design decision only Austin can make; never weaken a test.

---

## Audit: what B3 provides and what B4 adds

| Area | B3 / today | B4 |
|---|---|---|
| `share_links.mode` | Check allows `view`, `play`; trigger refuses `play` ("Play links come later."); insert grant omits `mode`; `open_share_link` serves `mode = 'view'` only | Trigger allows `play` for `kind = 'process'` with `hiddenLevers` in the snapshot; grant `insert (mode)`; `open_share_link` serves both |
| Snapshot | Real ids; every bundle redacted (labels, no pay, clients "Client N", `provenance` `{}`; Financials off → role rates 0, margins 0, no overhead); `ProcessShare` has `bundle`, `scenarios`, `issues`, … | Adds `hiddenLevers: string[]` to `ProcessShare` (the workspace's `lever_settings.hidden`). Nothing else |
| Visitor page | `/s/[token]`, `SharedView`, `mode="share"` everywhere: read only, no server or Realtime call, links inert | Passes `mode` from `open_share_link`; for `play`, a **Try your own changes** section on the process screen and a **Send this idea** dialog |
| Levers UI | `ScenarioPanel` + `LeverPanel` exist but are rendered **only** by `ProcessView` (old, used by `/demo/larkspur`); the redesigned `ProcessPage` (A38) shows no levers. In any non-`live` mode `ScenarioPanel` uses `MemoryScenarioStore` and `LeverPanel` sliders are always movable | Render `ScenarioPanel` inside `ProcessPage` only when a `play` prop is given; two new optional props on `ScenarioPanel` |
| Hidden levers | `lever_settings.hidden` (kind ids); `leverKindId(path)` maps 9 path families to kinds (`lib/scenarios/lever-catalogue.ts`) | Snapshot carries the list; the DB mirrors the 9-family map to refuse hidden kinds |
| Proposals | `suggestion_proposals`: `created_via` `mcp`/`play_link`/`upload`, `proposer_name`, `proposer_email` (not readable by `authenticated`); `solution_idea` **must** have `issue_id`; trigger forces `mcp` for any signed-in insert; `build_proposal` requires the solution to link the idea's issue | `share_link_id` column; constraint widened for play ideas with no issue; trigger accepts `play_link` only from the submit function; `build_proposal` accepts an idea with no issue; `play_proposal_contacts(ws)` for owners/editors |
| Solution idea payload | `{steps, edges, replaces_step_ids, expect}`; `readIdea`, `ideaToBlock`, `ideaSeed`, `placeIdea` | Adds `levers` (scenario patches), `process_id`, `base_revision_id`; `readIdea` reads `levers` |
| Build it | `buildIdeaHref` needs an issue with a process; `WorkspaceEditorPage` loads `?idea=` only with `?issue=` | Works with no issue for a play idea (by `payload.process_id`); seeds lever changes, checked against live |
| Solutions and levers | `solutions.lever_changes` stored (`save_solution(p_levers)`), **never simulated**: `bundleFromSolution` ignores it; the Editor always saves `levers: []` | Applied in the Editor's solution run, `simulateCopy`, `compareSolution`, Overview impact, demo link; Editor shows and saves them |
| Dismiss | `reviewProposals(ids, "reject", note)` already takes a note; `IdeaCard` sends `null` | A reply field on Dismiss |
| Restore | Backups include proposals (not `proposer_email`); restored rows become `upload` | Planner skips a solution idea with no issue (would fail the constraint) |
| `suggestions` delete-user bug | `private.suggestions_before_write` refuses the FK's set-null | Let it through, as proposals do |
| MCP | Can't make share links (42501) | Can't submit play proposals or read contacts (42501) |

**Surprises worth knowing:**
- **The redesigned process page has no levers.** Play mode is the first place the redesign renders `ScenarioPanel` again. Keep
  it out of every non-play page.
- **`ScenarioPanel`'s `canEdit` gates only the saved-scenario library**; the sliders work in every mode. Play mode hides the
  library (Q8), so a visitor sends only lever moves.
- **Per-person FTE levers follow the viewer.** `buildLevers(model, viewer)` adds `people.<id>.fte` only for people the viewer
  sees. A People-off snapshot's viewer is `{ seesEveryone: false, ownPersonId: null }`, so it has none; People on has them,
  with names. The submit function mirrors this.
- **The trigger can't tell a visitor from the MCP server by `auth.uid()`**: a restricted link's visitor is signed in (Google).
  The submit function marks its own insert with a transaction-local setting, exactly as `import_process_bundle` does with
  `transpera.importing`.
- **A definer function inserting into `suggestion_proposals` bypasses its RLS** (the function's owner owns the table, and RLS
  isn't forced), as B3's `open_share_link` updates `share_links`. Every check is therefore in the function itself.

---

## Data model and migration

File: `packages/db/supabase/migrations/20261217000000_play_links.sql`. Order: after B3's `20261211000000` and every version
merged before it. If anything merges with a later version first, this one is renumbered (HANDOVER, "Migration order").

**Additive** in the sense the repo uses: one column, one index, one widened check (`not valid` + `validate`, as
`20261129000000_import_bundle.sql` widened `suggestion_proposals_created_via`), one column grant, three new functions, and five
functions replaced with `create or replace` (same signatures, bodies widened only). No row is changed. No policy changes.
`save_fields` untouched.

### 1. `suggestion_proposals.share_link_id`

```sql
-- The play link a visitor's idea came from (B4). Not a foreign key: links are never deleted (only revoked), and a set-null
-- action would trip this table's guard trigger when a workspace is deleted.
alter table public.suggestion_proposals add column share_link_id uuid;
create index suggestion_proposals_share_link_idx on public.suggestion_proposals (share_link_id, created_at desc)
  where share_link_id is not null;
grant select (share_link_id) on public.suggestion_proposals to authenticated;
```

### 2. Widen `suggestion_proposals_issue`

```sql
-- A visitor's idea from a play link may be for no issue (B4): they may not know which problem it fixes.
alter table public.suggestion_proposals drop constraint suggestion_proposals_issue,
  add constraint suggestion_proposals_issue check (
    (kind = 'issue' and issue_id is null)
    or (kind = 'solution_idea' and (issue_id is not null or created_via = 'play_link'))) not valid;
alter table public.suggestion_proposals validate constraint suggestion_proposals_issue;
```
Every existing row satisfies the old rule `(kind = 'solution_idea') = (issue_id is not null)`, so it satisfies this one.

### 3. `private.suggestion_proposals_before_write()` (replace)

Copy the body from `20261129000000_import_bundle.sql` exactly, with these changes only (mark each `-- B4`):
- INSERT branch, right after `new.created_by := auth.uid();`:
  ```sql
  -- B4: a visitor's idea, inserted by public.submit_play_proposal for its own statement. Nobody else can say play_link.
  if coalesce(current_setting('transpera.play_submitting', true), '') = 'on' then
    new.created_via := 'play_link';
    new.created_by := null;            -- a visitor isn't a member, even when signed in for a restricted link
    new.import_source := null;
    return new;
  end if;
  new.share_link_id := null;           -- B4: only a play submission names a link
  ```
  The rest of the INSERT branch is unchanged (a signed-in caller becomes `mcp`/`upload` with no visitor details).
- UPDATE frozen-column list: add `or new.share_link_id is distinct from old.share_link_id`.

### 4. `public.build_proposal(...)` (replace)

Copy the body from `20261125500000_build_proposal.sql`, same signature and grants, changes marked `-- B4`:
- Select also `x.created_via, x.payload` into `v_via`, `v_payload`.
- Replace the "must be linked to the idea's issue" check with:
  ```sql
  if v_issue is not null then
    <the existing check, unchanged>
  elsif v_via is distinct from 'play_link' then
    raise exception 'build_proposal: the solution must be linked to the idea''s issue' using errcode = '22023';  -- can't happen (constraint)
  end if;
  -- B4: a visitor's idea is built on the process its link shared.
  if v_via = 'play_link' and v_payload ->> 'process_id' is distinct from p_process::text then
    raise exception 'build_proposal: that idea is for another process' using errcode = '22023';
  end if;
  ```

### 5. `private.suggestions_before_write()` (replace; the HANDOVER follow-up)

Copy the body from `20261129000000_import_bundle.sql`; at the top of the non-INSERT path add exactly the depth > 1 exception
from `private.suggestion_proposals_before_write` (minus the B4 lines), so a foreign key's `on delete set null` of only
`created_by` and/or `reviewed_by` (and `updated_at`) passes:
```sql
if pg_catalog.pg_trigger_depth() > 1
  and (to_jsonb(new) - 'created_by' - 'reviewed_by' - 'updated_at') = (to_jsonb(old) - 'created_by' - 'reviewed_by' - 'updated_at')
  and (new.created_by is null or new.created_by is not distinct from old.created_by)
  and (new.reviewed_by is null or new.reviewed_by is not distinct from old.reviewed_by) then
  return new;
end if;
```

### 6. `private.share_links_before_write()` (replace B3's)

Copy B3's **merged** body; change only:
- INSERT: replace `if new.mode <> 'view' then raise 'Play links come later.'` with
  ```sql
  -- B4: a play link shares a process, and its snapshot says which levers the workspace hides.
  if new.mode = 'play' and (new.kind <> 'process'
       or jsonb_typeof(new.snapshot -> 'hiddenLevers') is distinct from 'array'
       or jsonb_array_length(new.snapshot -> 'hiddenLevers') > 100
       or exists (select 1 from jsonb_array_elements(new.snapshot -> 'hiddenLevers') h where jsonb_typeof(h) <> 'string')) then
    raise exception 'Only a process can be shared for trying changes.' using errcode = '22023';
  end if;
  ```
- UPDATE: when the row is `play` and the snapshot changes, the same `hiddenLevers` check (Update copy must keep it).
`mode` stays frozen after insert (B3 already refuses changing it).

### 7. `public.open_share_link(token)` (replace B3's)

Copy B3's merged body; change only `and s.mode = 'view'` → `and s.mode in ('view', 'play')`. It already returns `mode`.

### 8. Grant

```sql
grant insert (mode) on public.share_links to authenticated;
```

### 9. `private.play_patch_problem(ws uuid, link public.share_links, levers jsonb) returns text`

`language plpgsql stable`, `set search_path = ''`, `revoke execute ... from public` (only the definer function calls it).
Returns null when every change is acceptable, else a plain message (never an id or a value). Checks, in order:

| # | Check | Message |
|---|---|---|
| 1 | `jsonb_typeof(levers) = 'array'`, length 1..50, `private.is_scenario_patch(levers)` | "Those changes aren't valid." / "Move at least one lever first." / "Send at most 50 changes." |
| 2 | No two elements with the same `path` | "Each lever can only be sent once." |
| 3 | Each `path` matches one of the families below (anything else, `@` selectors, `cost_rate`, `ongoing_hours`, `mix_share`, `health.*`, `churn_health_sensitivity` → refused) | "One of those changes can't be sent from a shared link." |
| 4 | Its kind isn't in `link.snapshot -> 'hiddenLevers'` | same |
| 5 | `people.<id>.fte` only when `link.show_people` | same |
| 6 | `op` and `value` as the family allows (table) | "One of the values is out of range." |
| 7 | The id (if any) is in the snapshot **and** in the workspace (table) | "One of those changes points at something that isn't in this page." |

Families (mirror `leverKindId` in `lib/scenarios/lever-catalogue.ts` and `buildLevers` in `lib/scenarios/levers.ts`; a pure TS
twin `playPatchProblem` in `apps/web/src/lib/share/play-input.ts` runs first in the Server Action and must agree, tested):

| Path | Kind | op | value | Id in snapshot (jsonpath on `link.snapshot`) | Id in workspace |
|---|---|---|---|---|---|
| `demand.leads_per_week` | `demand.enquiries` | set | 0–10000 | — | — |
| `demand.active_clients` | `clients.count` | set | 0–100000, whole | — | — |
| `demand.churn_monthly` | `clients.churn` | set | 0–1 | — | — |
| `finances.retainer` | `finances.prices` | set | 0–10000000 | — | — |
| `services.<id>.price` | `finances.prices` | set | 0–10000000 | `$.bundle.services[*].id` | `public.services` |
| `roles.<id>.headcount` | `people.headcount` | set | 0–500, whole | `$.bundle.roles[*].id` | `public.roles` |
| `people.<id>.fte` | `people.hours` | set | 0–1.5 | `$.bundle.people[*].id` | `public.people` |
| `steps.<id>.work_hours` | `process.time` | multiply | 0.1–2 | `$.bundle.steps[*].id`, `$.bundle.otherProcesses[*].steps[*].id` | `public.steps` |
| `steps.<id>.wait_hours` | `process.wait` | multiply 0.1–2, or set 0–10000 | | same | same |
| `steps.<id>.rework_rate` | `process.rework` | multiply 0.1–2, or set 0–0.5 | | same | same |

"In workspace" = `exists (select 1 from public.<table> t where t.id = <id>::uuid and t.workspace_id = ws)`; an id that isn't a
uuid fails. (Steps: any revision of the workspace; ids are stable across revisions.) Check the snapshot jsonpaths against the
real `ProcessShare` JSON in a test before relying on them; if B3 stores `otherProcesses` elsewhere, follow it.

### 10. `public.submit_play_proposal(token text, title text, note text, name text, email text, issue uuid, levers jsonb) returns jsonb`

SECURITY DEFINER, **volatile**, `set search_path = ''`. `revoke all ... from public; grant execute ... to anon, authenticated;`
Expected outcomes are **returned** (`{"status": ...}`); bad input **raises** 22023 with a plain message (the dialog shows it).

```
1. if coalesce(auth.jwt(), '{}') ? 'api_token_id' then raise 'Ideas are sent from the shared page.' (42501).
2. if token is null or token !~ '^[A-Za-z0-9_-]{43}$' then return {"status":"gone"}.
   select * into l from public.share_links where token_hash = <sha256 hex as open_share_link>
     and revoked_at is null and (expires_at is null or expires_at > now()) and mode = 'play'
     for update;                                   -- serialises submissions per link, so the counts below hold
   if not found then return {"status":"gone"}.
3. Restricted (show_people or show_financials): as open_share_link: no user -> {"status":"sign_in"}; confirmed email not in
   allowed_emails -> {"status":"not_allowed"}. Then v_email := that verified email (what was typed is ignored).
   Open link: v_email := lower(btrim(email)); required; <= 254; matches '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     ("Add your email address so the team can reply." / "That isn't an email address.").
4. Text: v_title := btrim(title) 1..120 ("Give your idea a name." / "Keep the name under 120 characters.");
   v_name := btrim(name) 1..100 ("Add your name." / ...); v_note := nullif(btrim(note), '') <= 1000.
   No control characters in any of them except line breaks in the note ('[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'):
   "Remove the unusual characters and try again."
5. problem := private.play_patch_problem(l.workspace_id, l, levers); if not null raise problem (22023).
6. issue: null, or (a) in the snapshot: exists jsonb_path ... '$.issues[*] ? (@.id == $id)' and (b) in public.issues with
   this workspace_id, status in ('open', 'testing') (`isActiveStatus`), source <> 'detected'. Else "Pick an issue from this
   page, or none." (Check the stored status values in 20261120000000_issues_v2.sql / later migrations: `isActiveStatus`
   says open and testing; use the stored column values that mean those.)
7. Rate limits (counts over suggestion_proposals where share_link_id = l.id):
   - >= 5 in the last 10 minutes, or >= 50 in the last 24 hours                -> {"status":"rate_limited"}
   - >= 10 with lower(proposer_email) = v_email in the last 24 hours           -> {"status":"rate_limited"}
   - >= 200 pending play_link proposals in the workspace                       -> {"status":"busy"}
8. perform set_config('transpera.play_submitting', 'on', true);
   insert into public.suggestion_proposals (workspace_id, kind, title, detail, payload, evidence, note, issue_id,
     proposer_name, proposer_email, share_link_id)
   values (l.workspace_id, 'solution_idea', v_title, v_note,
     jsonb_build_object('steps', '[]'::jsonb, 'edges', '[]'::jsonb, 'replaces_step_ids', '[]'::jsonb, 'levers', levers,
       'process_id', l.target_id, 'base_revision_id', l.snapshot -> 'bundle' -> 'revision' ->> 'id'),
     '[]', null, issue, v_name, v_email, l.id);
   perform set_config('transpera.play_submitting', '', true);
9. return {"status":"ok"}.            -- never the proposal id, never anything from the workspace
```
Rebuild `levers` from the checked elements (`{path, op, value}` only, in order) before storing. The visitor's note goes in
`detail` (shown as the idea); `note` (the "Reasoning" line, AI-only) stays null.

### 11. `public.play_proposal_contacts(ws uuid) returns jsonb`

SECURITY DEFINER, `stable`, `set search_path = ''`. Refuse API tokens (42501, "Visitors' emails are shown in the app only.").
`if ws is null or not coalesce(public.can_edit_workspace(ws), false) then raise 42501`. Returns
`{ "<proposal id>": "<email>" }` for `created_via = 'play_link'` and `proposer_email is not null` in `ws`, newest 500.
`revoke all from public, anon; grant execute to authenticated`. Members and viewers never see a visitor's email.

### Migration header (write all of it)

Purpose; what is added and replaced (list each with its source file); the security model (below, short); `ORDER`;

**PREFLIGHT** (read-only, `prod-sql.sh -c`, one at a time):
0. B3 applied, nothing at or past this one. Expect B3's version and nothing `>= '20261217000000'`:
   `select version from supabase_migrations.schema_migrations where version >= '20261211000000' order by 1;`
1. Nothing created yet. Expect null ×3 and 0:
   `select to_regprocedure('public.submit_play_proposal(text, text, text, text, text, uuid, jsonb)'), to_regprocedure('public.play_proposal_contacts(uuid)'), to_regprocedure('private.play_patch_problem(uuid, public.share_links, jsonb)'), (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'suggestion_proposals' and column_name = 'share_link_id');`
2. The five replaced functions are as reviewed. Expect the md5s you compute locally after applying every migration up to
   B3's (write them into the header):
   `select n.nspname, p.proname, md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('private','suggestion_proposals_before_write'), ('private','suggestions_before_write'), ('private','share_links_before_write'), ('public','build_proposal'), ('public','open_share_link')) order by 1, 2;`
3. The constraint is the old one. Expect `CHECK (((kind = 'solution_idea'::text) = (issue_id IS NOT NULL)))`:
   `select pg_get_constraintdef(oid) from pg_constraint where conname = 'suggestion_proposals_issue';`
4. No play links, no visitor ideas, no solution with lever changes (so no number moves). Expect 0, 0, 0:
   `select (select count(*) from public.share_links where mode = 'play'), (select count(*) from public.suggestion_proposals where created_via = 'play_link'), (select count(*) from public.solutions where jsonb_array_length(lever_changes) > 0);`
5. Helpers exist. Expect 3 rows: `private.is_scenario_patch`, `public.can_edit_workspace`, `public.save_solution`.

**POST-APPLY CHECK:**
1. Function privileges. Expect `t, t, f, t, f, f`: `has_function_privilege('anon', 'public.submit_play_proposal(text, text, text, text, text, uuid, jsonb)', 'execute')`, `('authenticated', same)`, `('anon', 'public.play_proposal_contacts(uuid)', 'execute')`, `('authenticated', same)`, `('anon', 'private.play_patch_problem(uuid, public.share_links, jsonb)', 'execute')`, `('authenticated', same)`.
2. `prosecdef` t for both public functions; all new and replaced functions `proconfig = array['search_path=""']`.
3. The new constraint, validated: `select pg_get_constraintdef(oid), convalidated from pg_constraint where conname = 'suggestion_proposals_issue';`
4. `share_link_id` present with an authenticated SELECT column grant; the partial index exists; `mode` in the authenticated
   INSERT column grants of `share_links`; anon still holds nothing on either table.
5. The five replaced functions' md5s now equal the new reviewed values (write them in).
6. Smoke test, **rolled back**, as an agency admin on Northbeam (copy B3's smoke test): insert a `play` link to a published
   Northbeam process with a minimal clean snapshot `{"v":1,"kind":"process","toggles":{"people":false,"financials":false},"hiddenLevers":[],"bundle":{"revision":{"id":"<live revision>"},"steps":[],"roles":[],"people":[],"services":[]},"issues":[]}`
   → ok; then `set local role anon; select set_config('request.jwt.claims', '{"role":"anon"}', true); select public.submit_play_proposal('<token>', 'Smoke', null, 'Smoke test', 'smoke@example.com', null, '[{"path":"demand.leads_per_week","op":"set","value":9}]') ->> 'status';` → `ok`;
   the row has `created_via = 'play_link'`, `created_by` null, `status = 'pending'`; `rollback;`.
   (If the leak check refuses the minimal snapshot, add what B3's smoke test used.)

**ROLLBACK** (one transaction; redeploy the app from before B4 first). Paste the **full** previous bodies inline, not
references: B3's merged `share_links_before_write` and `open_share_link`, `20261129000000`'s `suggestion_proposals_before_write`
and `suggestions_before_write`, `20261125500000`'s `build_proposal`.
```sql
begin;
drop function if exists public.submit_play_proposal(text, text, text, text, text, uuid, jsonb);
drop function if exists public.play_proposal_contacts(uuid);
drop function if exists private.play_patch_problem(uuid, public.share_links, jsonb);
create or replace function private.share_links_before_write() ... <B3's body> ;
create or replace function public.open_share_link(text) ... <B3's body> ;   -- play links stop opening
create or replace function private.suggestion_proposals_before_write() ... <20261129000000's body> ;
create or replace function private.suggestions_before_write() ... <20261129000000's body> ;
create or replace function public.build_proposal(uuid, uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb) ... <20261125500000's body> ;
revoke insert (mode) on public.share_links from authenticated;
-- Visitor ideas with no issue can't satisfy the old rule: they are deleted (they are pending suggestions, nothing else
-- points at them; built ones made ordinary solutions, which stay).
delete from public.suggestion_proposals where created_via = 'play_link' and issue_id is null;
alter table public.suggestion_proposals drop constraint suggestion_proposals_issue,
  add constraint suggestion_proposals_issue check ((kind = 'solution_idea') = (issue_id is not null));
drop index if exists public.suggestion_proposals_share_link_idx;
alter table public.suggestion_proposals drop column if exists share_link_id;
delete from supabase_migrations.schema_migrations where version = '20261217000000';
commit;
```
Say in the header: rolling back deletes visitor ideas with no issue; play links stay in `share_links` but no longer open (B3's
`open_share_link` serves view links only); solutions' stored lever changes stay (and stop counting once the app is rolled back).

**Apply file:** `packages/db/scripts/apply/20261217000000_play_links.sql`: header comment (copy the pattern of
`packages/db/scripts/apply/20261209000000_agency_list.sql`: what, order, "apply BEFORE deploying the app"; repeat preflight,
post-apply and rollback), `begin;`, `set local lock_timeout = '5s';`, the migration SQL, the
`insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261217000000', 'play_links', array[$mig$<the migration SQL>$mig$]);`,
`commit;`.

Then `pnpm --filter @transpera-flow/db gen:bootstrap` (never by hand); hand-edit `packages/db/src/database.types.ts`
(`suggestion_proposals` Row/Insert/Update `share_link_id`; the two public functions' Args/Returns, alphabetical, as #206 did).

### Security model (unauthenticated and visitor proposals)

- **One write.** `anon` gains exactly one EXECUTE: `submit_play_proposal`. It holds no table privilege anywhere (role-matrix
  test). The function writes one `suggestion_proposals` row and nothing else (no issue, solution, scenario or link changes);
  the row is `pending` (the trigger forces it), so **nothing auto-applies**: only a person's Build it or Dismiss acts on it.
- **Who can send.** Only through a live, unexpired, unrevoked `play` link, found by the SHA-256 of a 256-bit token. A
  restricted link needs a signed-in visitor whose confirmed email is listed, and records that email. API tokens are refused.
- **Rate limits** (per link, serialised by `for update` on the link row): 5 per 10 minutes, 50 per 24 hours; 10 per email per
  link per 24 hours; 200 pending visitor ideas per workspace. Revoking the link stops it at once. No per-IP limit: the database
  sees Vercel's address for Server Action calls, and there is no shared store for serverless (Q9). The Server Action adds a
  hidden honeypot field (filled → report success, send nothing).
- **Size limits:** title 120, name 100, email 254, note 1,000 characters, no control characters; 1–50 changes; values in range;
  table limits (payload 100 KB) still apply.
- **Ids.** Every id in a change must be in the link's frozen snapshot **and** in the workspace's tables; a hidden lever kind,
  a person's FTE without People on, and any path no shared slider produces are refused. An id from another workspace or
  invented by hand is refused (22023), and the message names neither.
- **Spoofing.** Only `submit_play_proposal` can make a `play_link` row (the trigger's setting is transaction-local and can't be
  set over PostgREST; any other insert is `mcp`/`upload` with no visitor details and no link). `created_by` is null for a
  visitor. What was sent never changes (frozen columns).
- **Privacy.** Nothing new reaches the visitor (the snapshot plus `hiddenLevers`; the function returns only a status). A
  visitor's email is readable only by owners, editors and agency admins (`play_proposal_contacts`); everyone who reads
  Suggestions sees the visitor's name, title, note and changes (Q5). Free text is stored as typed (Q7) and rendered as plain
  text (React escapes it; no auto-linking).

---

## The app

### `packages/db`

- `share.ts`: `ProcessShare` gets `hiddenLevers: string[]` (`loadLeverSettings(db, ws).hidden`, read in `loadShareData` for
  `kind: "process"`, through the same wrapped `Db`). Keep `v: 1`. Old snapshots lack it: the app treats missing as `[]` for
  view links; the DB refuses a play link without it.
- `types.ts`: `SolutionIdeaPayload` gets `levers?: ScenarioPatch[]; process_id?: string; base_revision_id?: string`;
  `ProposalRow` gets `share_link_id: string | null` (update the `Assert<Matches<...>>` line for it).
- `proposals.ts`: add `share_link_id` to `PROPOSAL_ROW_COLUMNS`; add
  `loadPlayContacts(db, ws): Promise<Record<string, string>>` (rpc `play_proposal_contacts`; `{}` on 42501).
- `workspace-import.ts` (the restore planner): leave out a `solution_idea` with a null `issue_id`, counted under a skipped
  note "Visitor ideas not tied to an issue aren't restored." (the restored row would be `upload` and fail the constraint).

### Solutions honour lever changes: `apps/web/src/lib/solutions/levers.ts` (new, pure)

```ts
/** A solution's model with its lever changes applied on top (A49: "a copy of a process with changed steps, plus optional
 * lever changes"). Changes whose target is gone are left out and reported, never thrown. */
export function withLeverChanges(model: EngineModel, levers: readonly ScenarioPatch[]): { model: EngineModel; problems: string[] }
```
Use the engine's `applyPatches` (non-throwing); `problems` = the blocking issues' messages. Then use it at every place a
solution is simulated, so a solution's numbers mean the same everywhere:
1. `lib/solutions/server-verdict.ts`: `simulateCopy(base, copy, levers = [])` applies them after `toEngineModel`;
   `serverVerdict` takes `levers`; `createSolution` passes `v.levers`; `linkSolutionToIssue` selects and passes
   `lever_changes`.
2. `lib/solutions/compare.ts` (`compareSolution` → the solution page): the solved model gets `solution.lever_changes`; show
   `problems` as notes where the page already shows notes.
3. `lib/overview/impact.ts`: the `solved` model gets them.
4. `lib/solutions/demo-link.ts`: same.
5. The Editor (below).
No engine change. Existing solutions all have `[]` (preflight 4), so nothing moves.

### Editor: lever changes in solution mode

- `lib/suggestions/idea.ts`: `readIdea` also returns `levers: ScenarioPatch[]` (from `payload.levers` through `parsePatches`;
  invalid → `[]`); `IdeaSeed` gets `levers: ScenarioPatch[]` and `leverNotes: string[]`; `ideaSeed(p, roles)` fills `levers`.
  `placeIdea` with no steps and some levers: no edit, note "The idea changes levers only: they're listed under Lever changes.
  Adjust the map too if you like, simulate, then save." (instead of the "no usable steps" note).
- `buildIdeaHref`: for `p.created_via === "play_link"` with a string `payload.process_id`, return
  `solutionEditorHref(base, payload.process_id, { issueId: p.issue_id, idea: p.id, from })` (issue optional); otherwise as now.
- `lib/share/play-changes.ts` (new, pure): `mapPlayChanges(levers, live: ProcessBundle): { levers: ScenarioPatch[]; notes: string[] }`.
  This is the server-side mapping: keep a change only if `parsePatches` accepts it and its id (if any) is a step of `live` or
  of `live.otherProcesses`, a role, a person or a service of `live`; drop the rest with one note: "N of the visitor's changes
  no longer apply (a step, role or service has gone since they sent it)."
- `components/editor/workspace-editor-page.tsx`: load `?idea=` also with no `?issue=` when the idea is a pending
  `play_link` solution idea whose `payload.process_id === processId` and whose `issue_id` equals the `?issue=` given (or both
  null). Build the seed **here (server)**: `const mapped = mapPlayChanges(readIdea(row.payload).levers, live)`;
  `idea = { ...ideaSeed(row, live.roles), levers: mapped.levers, leverNotes: mapped.notes }`. Same for any idea with levers.
- `components/editor/editor-view.tsx` (solution mode only):
  - `const [levers, setLevers] = useState<ScenarioPatch[]>(idea?.levers ?? [])`.
  - The model the solution is simulated and verdict-checked with is `withLeverChanges(workingModel.model, levers).model`
    (find every solution-mode use of `workingModel.model`; the live side stays as is).
  - A **Lever changes** box beside the idea note (only when `levers.length` or `idea?.leverNotes.length`): one line per change
    in words (`describeLeverChange`, below), each with **Remove**; the notes under it; (i) "Lever changes: changes to numbers
    rather than steps, such as more leads or one more person in a role. They're saved with the solution and used whenever it
    is simulated." Example: "Leads per week set to 12; Hands-on time on Check fit −20%."
  - `saveSolution`: `levers` in the input; the "Change at least one step first" check becomes "change at least one step or
    keep at least one lever change" ("Change at least one step or lever first. A solution with no changes has nothing to
    test.").
  - The demo path (`addDemoSolution`) gets the levers too.

### Describing a change: `lib/suggestions/lever-changes.ts` (new, pure)

`describeLeverChange(patch, names: { steps; roles; services; people }): string`, e.g. "Leads per week: 12", "Active clients:
40", "Monthly churn: 3%", "Monthly retainer: £2,500" (workspace currency), "Price of SEO retainer: £1,800", "Strategist:
3 people", "Hours for {name}: 0.8 FTE", "Hands-on time on Check fit: −20%" (multiply → ±%), "Wait before Check fit: 4 h"
(set), "Rework on Proposal: 10%". An unknown id → "a step that has gone" (as `describeProposal` does). A person's name comes
from `names.people`, which callers fill only for viewers who see everyone; otherwise "a team member" (B1 2b rule).

### Visitors: play mode

**Share dialog** (`components/share/share-dialog.tsx`), process pages only: a switch **Let people try changes** (default off),
(i): "Visitors can move the levers you show (Settings → Levers) and see what would change. Nothing they do is saved. They can
send you what they tried: it arrives in Suggestions, and nothing changes unless you build it." Example: "A client tries one
more strategist and sends it as 'Hire for onboarding'." `ShareInput.play: boolean`; `parseShareInput`: `play` only with
`kind === "process"` (else "Only a process can be shared for trying changes."). `createShareLink` inserts
`mode: v.play ? "play" : "view"`. The success text adds, for play: "People who open it can send you ideas. You'll find them in
Suggestions."

**Share links list** (`share-links-table.tsx`): **Shows** adds "Try changes" for play links; a new column **Ideas** for play
links: "N sent" (count of `suggestion_proposals` with that `share_link_id`, one query for the page), linking to
`/w/[slug]/suggestions`; "—" for view links.

**Visitor page** (`app/s/[token]/page.tsx`): pass `mode` (`opened.mode === "play" ? "play" : "view"`) and, for a restricted
link, the visitor's verified email (`db.auth.getUser()`, as the `not_allowed` gate does) into `SharedViewData`
(`mode`, `visitorEmail: string | null`). The page still calls only `open_share_link` (the source-text test stays green).

**`SharedView`** (play, `kind === "process"` only; a play snapshot of any other kind renders as view):
- `ShareBar`: "Shared view · try changes" instead of "Shared view · read only", and one line: "You can try changes here.
  Nothing is saved unless you send it to the team." (i) "Moving a lever changes the numbers on this page only, in your
  browser. Reloading the page puts everything back." Example: "Try 12 leads a week and see how long they wait."
- `ProcessScreen` passes `play={{ hiddenLevers: snapshot.hiddenLevers ?? [], issues: <open issues of this process from
  snapshot.issues>, workspaceName, visitorEmail, submit }}` to `ProcessPage` (`mode` stays `"share"`).

**`ProcessPage`** (`components/process-page.tsx`): new optional prop `play?: PlayConfig`. When given (and only then), render a
section `id="try-changes"` right after the map/headline section, heading **Try your own changes** with the (i) above, holding
`<PlaySection model={model} baseline={sim.run} bundle={bundle} play={play} />` (`components/share/play-section.tsx`, new):
- `ScenarioPanel` with `mode="share"`, `initialScenarios={[]}`, `hiddenLevers={play.hiddenLevers}`, no `leversHref`,
  `viewer={bundle.viewer}`, `currency`, `workspaceId`, `library={false}`, `onLeversChange={setPatches}`.
- **Send this idea** button: disabled until a lever has moved (title "Move at least one lever first."); opens `SendIdea`.
- No state is persisted anywhere: no `localStorage`, `sessionStorage`, URL or cookie (test).

**`ScenarioPanel`** (`components/scenario-panel.tsx`), two optional props, defaults keep today's behaviour:
`library?: boolean` (default `true`; `false` renders no `ScenarioLibrary`) and
`onLeversChange?: (patches: ScenarioPatch[]) => void` (called from an effect with `moved` whenever it changes).

**`SendIdea`** (`components/share/send-idea.tsx`, client dialog). Title "Send your idea to {workspaceName}". Fields, each with
an (i) (`components/help.tsx`):

| Field | Rules | (i) description | (i) example |
|---|---|---|---|
| **Name your idea** | required, ≤ 120 | "A short name the team will see in their list." | "One more strategist" |
| **What it should fix** (select; "Nothing in particular" first) | optional; the process's open issues in the snapshot | "If your idea is for one of the problems on this page, pick it. The team then tests it against that problem." | "Leads wait too long for a first call" |
| **Why it would help** | optional, ≤ 1,000 | "Anything the team should know: what you tried and what you saw." | "With 3 strategists, leads wait under a day and nothing else gets worse." |
| **Your name** | required, ≤ 100 | "So the team knows who sent it. Everyone in their workspace who reads Suggestions sees it." | "Priya Shah" |
| **Your email** (open links) | required, valid | "So the team can reply. Only their owners and editors see it." | "priya@example.com" |
| *Sent as {visitorEmail}* (restricted links, read only) | — | "You signed in with this address, so it's the one the team sees." | — |

Above the fields, **The changes you're sending**: one line per change (`describeLeverChange` with the snapshot's names), (i)
"These are the levers you moved. The team sees exactly these, and can build them into a solution or turn them down." Hidden
honeypot input `name="website"` (`aria-hidden`, `tabIndex={-1}`, off-screen). Button **Send**. On success: "Sent. The team will
find your idea in their Suggestions. Nothing changes unless they build it." (the levers stay where they are). Errors in plain
words: `rate_limited` "A lot of ideas have been sent from this link recently. Try again in an hour."; `busy` "The team has a
lot of ideas waiting. Try again later."; `gone` "This link has expired or been turned off."; `sign_in` / `not_allowed`
"Sign in again with the address this link was sent to."; 22023 → its message; anything else "Couldn't send. Try again."

**Server Action** `submitPlayIdea(token, input)` in `app/s/[token]/actions.ts` (`"use server"`; Next 16: read
`node_modules/next/dist/docs/` on Server Actions and `headers()` before writing):
1. `SHARE_TOKEN.test(token)` else `{ status: "gone" }`. Honeypot filled → `{ status: "ok" }` without calling anything.
2. `parsePlayIdea(input)` (`lib/share/play-input.ts`, pure): the same text, email and size rules as the function, plus
   `parsePatches` and `playPatchProblem` (the TS twin of `play_patch_problem` **without** the workspace check, which only
   the DB can do).
3. `const db = await createClient()` (anon or the visitor's session) → `db.rpc("submit_play_proposal", {...})`; map the result.
4. No `revalidatePath`, no `refresh` (nothing the visitor sees changed).
The function stays the authority: the browser could call it directly with the anon key, and every check is repeated there.

### Owners and editors: Suggestions

- **Page** (`app/w/[slug]/suggestions/page.tsx` and its loader in `lib/company-data.ts`): for editors also load
  `loadPlayContacts`; fill `ProposalLookups` with `roles`, `services` and (for viewers who see everyone, as the page decides
  names today) `people` names, and the process names it already has.
- **`describeProposal`** (`lib/suggestions/proposals.ts`): for `play_link`, `kind: "Visitor's idea"`; `lines` = the visitor's
  note (`detail`), then "Changes: " + the described changes joined with "; ", then "Sent from a link to {process}."; no
  "Proposed steps" line when there are none.
- **`IdeaCard`** (`components/idea-card.tsx`), play ideas: badge **Visitor's idea** (not "AI idea"); "from {name} (play
  link)"; "for issue #N" only when there is one; the change list instead of the empty block map; for editors "Reply by email:
  {email}" as a `mailto:` link; **Build it** (`buildIdeaHref` above); **Dismiss** opens an inline **Reply** textarea (≤ 2,000)
  with **Dismiss** / **Cancel**, (i) "Your reply is kept with the dismissed idea, so your team can see why. The sender isn't
  emailed: use their address above if you want them to know." Example: "Thanks Priya: we're hiring for this in January."
  Pass the reply to `reviewProposals([id], "reject", reply)` (A52 already stores it as `review_note`). Members and viewers see
  the card without email, Build it or Dismiss (as today for ideas).
- Add `SUGGESTIONS_HELP.visitorIdea` ("Visitor's idea": "Someone you shared a page with tried their own changes and sent
  them. Nothing is changed until you build it." Example: "Priya moved Strategist to 3 people and sent it as 'One more
  strategist'.") and `.reply`.
- The demo is unchanged (no play links there); `demo.ts` gains nothing.

---

## Patterns to copy

| What | From |
|---|---|
| Token lookup, restricted-link check, counting | `public.open_share_link` (B3 migration) |
| A definer function marking its own insert for a trigger | `transpera.importing` in `20261129000000_import_bundle.sql` (`import_process_bundle` + `suggestion_proposals_before_write`) |
| Widening a check constraint | `suggestion_proposals_created_via` in `20261129000000_import_bundle.sql` (`not valid` + `validate`) |
| Depth > 1 FK set-null exception | `private.suggestion_proposals_before_write` (`20261124000000`) |
| Replacing a function with a marked copy, md5 preflight | `20261208000000_client_calibration.sql` (row 57) and `20261125500000_build_proposal.sql` |
| Refusing API tokens | `20261015000000_suggestions.sql` (`auth.jwt() ? 'api_token_id'`) |
| Lever generation, kinds, hidden kinds | `lib/scenarios/levers.ts` (`buildLevers`, `leverPatches`), `lib/scenarios/lever-catalogue.ts` (`leverKindId`, `visibleLevers`) |
| Patch grammar | `private.is_scenario_patch` (`20261017000000_health_patches.sql`), engine `parsePatches`, `applyPatches` |
| Idea seeding and Build it | `lib/suggestions/idea.ts`, `components/editor/workspace-editor-page.tsx`, `app/w/[slug]/solution-actions.ts` |
| Role matrix, anon checks | `packages/db/test/role-matrix.test.ts` (`TABLES`, `ROLES`, `RPCS`; B3's `open_share_link` block) |
| PostgREST e2e with anon/authenticated/API-token JWTs | `packages/mcp/test/postgrest-share-links.test.ts` (B3), `postgrest-roles.test.ts`, `helpers.ts` (`signJwt`) |
| Browser harness | `apps/web/test/share-browser.test.ts` + `share-harness/entry.tsx` (B3) |
| (i) help | `components/help.tsx`; `SUGGESTIONS_HELP` |

---

## Edge cases

- **Reload discards changes:** lever values live in React state only; a reload remounts with nothing moved (browser test).
- **Hidden lever kinds:** the slider isn't offered; a hand-made request for it is refused by the DB. If the workspace hides
  more kinds after the link was made, the link keeps its frozen list until **Update copy** (the DB checks the frozen list: what
  the visitor saw).
- **People off:** no per-person FTE levers, and `people.<id>.fte` is refused. People on: they show with names, as the link
  allows.
- **Financials off:** prices and the retainer are revenue, so their levers stay. Role cost rates are never a lever.
- **The process changes after the link is made:** the visitor plays on the frozen copy; ids stay valid in the snapshot. At
  Build it, `mapPlayChanges` drops changes whose step, role, person or service is gone, with a note; a step id still in the
  workspace but no longer in the live map is dropped too.
- **Link revoked or expired while the dialog is open:** Send returns `gone`; the dialog says so.
- **Restricted link:** the email recorded is the verified one; a signed-in visitor not on the list gets "Sign in again…".
- **A member or editor of the workspace opens the play link and sends an idea:** allowed (they're a visitor on that page);
  recorded as `play_link` with `created_by` null and their typed or verified email.
- **The chosen issue is resolved before Build it:** `build_proposal` → `save_solution` refuses ("That issue is already
  resolved…", existing mapping in `solution-actions.ts`); the editor can Dismiss with a reply.
- **Idea with no issue:** Build it opens solution mode with no issue (no outlined area, no automatic verdict); the solution can
  be linked to an issue later from its page (existing `linkSolutionToIssue`, which now passes `lever_changes`).
- **Idea with only levers and no step change:** saveable (the Editor's check counts levers).
- **Two editors press Build it on the same idea:** `build_proposal` locks the row; the second gets "That idea has already been
  built or dismissed." (existing).
- **Spam:** limits per link and per email; the honeypot; revoking the link. Visitor text is shown as plain text only.
- **A user who created or reviewed a `suggestions` row is deleted:** succeeds; the columns become null (bug fix test).
- **Restore of a backup holding visitor ideas:** ideas with an issue come back as `upload` ideas with their levers (Build it
  still places them); ideas with no issue are skipped with a note.
- **MCP:** `submit_play_proposal` and `play_proposal_contacts` refuse API tokens (42501). MCP's propose tools still can't set
  `share_link_id` or `play_link` (trigger).
- **Engine updated after the copy:** as B3: numbers can move as they would for editors.

---

## Tests

### DB (`packages/db/test/play-links.test.ts`; extend `role-matrix.test.ts`)

- Role matrix: `submit_play_proposal` executable by anon and authenticated; `play_proposal_contacts` by authenticated only,
  and only owner/editor/agency_admin get data (member, viewer → 42501). **"No other write"**: assert anon holds no
  INSERT/UPDATE/DELETE privilege on any `public` table, and that the set of `public` functions anon can execute equals the
  set before this migration plus `submit_play_proposal` (compute both in the test: before = list with that one name removed).
- Links: a `play` link for a process with `hiddenLevers` → ok; for overview/issue/solution → 22023; without `hiddenLevers` or
  with a non-string → 22023; Update copy of a play link without `hiddenLevers` → 22023; `mode` can't change after insert;
  `open_share_link` returns `mode: "play"`.
- Submit, happy path (anon, open link): returns exactly `{"status":"ok"}`; one row: `kind solution_idea`, `status pending`,
  `created_via play_link`, `created_by` null, `share_link_id` the link, `proposer_name`/`proposer_email` as sent (lower-cased),
  `detail` the note, `payload.levers` exactly the checked changes, `payload.process_id` the link's target, `issue_id` null.
  **Never auto-applies:** counts of `issues`, `solutions`, `scenarios`, `share_links` changes, and every other proposal are
  unchanged.
- Submit, refusals, one test each (22023 with the listed message unless noted; no id or name in the message): API-token
  claims (42501); unknown, malformed, revoked, expired, `view`-mode token → `gone`; restricted + anon → `sign_in`; restricted +
  unlisted → `not_allowed`; restricted + listed → ok with the **verified** email stored though another was typed; missing
  title/name/email; too long each; bad email; control character; 0 and 51 changes; duplicate path; `roles.<id>.cost_rate`;
  `health.initial`; `roles.@busiest.headcount`; a hidden kind; `people.<id>.fte` with People off (and ok with People on);
  out-of-range value for each family; `add` op; a step id from **another workspace** (in neither snapshot nor workspace); a
  real step id of this workspace **not in the snapshot**; an id in the snapshot JSON but deleted from the table; an issue from
  another workspace; a resolved issue; a detected issue; an issue not in the snapshot.
- Rate limits: 5 ok then the 6th `rate_limited` (within 10 minutes); 50 in 24 h (backdate rows' `created_at` as the test's
  superuser); 10 per email per day; 200 pending per workspace → `busy`.
- Trigger: an editor (authenticated) inserting `created_via = 'play_link'`, `proposer_*`, `share_link_id` directly gets `mcp`
  with all three null; setting `share_link_id` on update → 42501; after a successful submit the setting
  `transpera.play_submitting` is empty again in the same transaction (a later insert in it is `mcp`). A raw SQL session could
  set the setting itself, but PostgREST exposes no way to (no exposed function calls `set_config` with caller input), exactly
  as for `transpera.importing`; the PostgREST e2e covers the real path. Say so in a comment.
- `build_proposal`: a play idea with no issue, `p_links = []`, `p_levers` = its levers → solution saved with
  `lever_changes`, idea `built`; wrong `p_process` → 22023; an MCP idea without its issue in `p_links` still refused.
- Constraint: an MCP/`upload` solution idea with no issue still refused (23514); a play idea with none ok.
- Bug fix: delete an auth user who created and reviewed a `suggestions` row → succeeds, both columns null; any other change
  at depth 1 still refused.

### Pure

- `apps/web/test/play-input.test.ts`: `parsePlayIdea` rules; `playPatchProblem` agrees with a table of cases shared with the
  DB test (put the cases in a JSON fixture both read).
- `apps/web/test/play-changes.test.ts`: `mapPlayChanges` keeps ids present in live (and in `otherProcesses`), drops gone ones
  with the note, drops malformed patches.
- `apps/web/test/lever-changes.test.ts`: `describeLeverChange` for every family; people name hidden → "a team member".
- `apps/web/test/solution-levers.test.ts`: `withLeverChanges` applies and reports; `simulateCopy(base, copy, levers)` differs
  from without when `demand.leads_per_week` is raised; `compareSolution` uses `lever_changes`; with `[]` everything is
  byte-identical to before (Northbeam fixture).
- `readIdea` reads `levers`; `buildIdeaHref` for a play idea with and without an issue; `describeProposal` for a play idea.
- `packages/db` `share-snapshot.test.ts`: a process snapshot has `hiddenLevers`, and the leak checks still pass for all four
  toggle combinations.
- Restore planner: a solution idea with no issue is skipped with the note.

### PostgREST e2e (`packages/mcp/test/postgrest-play-links.test.ts`, skipped without `POSTGREST_URL`)

On Larkspur with rates, emails and notes seeded (as B3's suite): editor JWT builds a process snapshot (`loadShareData` +
redaction) and inserts a `play` link; **anon JWT**: `rpc/open_share_link` → `mode: "play"`; `rpc/submit_play_proposal` with
lever changes the snapshot's sliders would give → `{"status":"ok"}`; then, still anon, each of these is refused: insert into
`suggestion_proposals`, `share_links`, `solutions`, `scenarios`; update `share_links`; `rpc/review_proposals`,
`rpc/build_proposal`, `rpc/save_solution`, `rpc/play_proposal_contacts`. Editor JWT: selects the proposal (no
`proposer_email` column allowed: selecting it → 42501), `play_proposal_contacts` returns the email; member JWT → 42501 and
sees the proposal without it. Restricted play link: anon → `sign_in`; an allowed visitor JWT (`auth.users` row with a
confirmed email) → ok and the stored email is the verified one. API-token JWT → 42501. A step id from another workspace →
400 with code 22023. Six quick submissions → the sixth `rate_limited`.

### Web browser (`apps/web/test/play-browser.test.ts`, harness `share-harness/entry.tsx` extended)

`SharedView` for a Northbeam process snapshot in `play` mode, People off, Financials off, `hiddenLevers: ["process.rework"]`:
renders without console errors; makes **no network request** outside the harness origin while levers move; shows "Try your
own changes" and "Shared view · try changes"; no Rework slider; no per-person slider; moving "Leads per week" updates the
compare headline; **Send this idea** disabled before, enabled after; the dialog lists the change in words; empty name →
"Give your idea a name."; submit calls the harness's stubbed `submit` once with the moved patch; the honeypot is not visible;
`localStorage` and `sessionStorage` are empty after moving levers; remounting (the harness's reload) shows every lever at
neutral. A `view` link of the same snapshot shows no levers and no Send. Screenshots light/dark at 1440 and 400 px.

`apps/web/test/suggestions-play-browser.test.ts` (or extend the existing Suggestions harness): a pending play idea renders
"Visitor's idea", the visitor's name, note and changes; editors see the email and Build it (`href` has `mode=solution`,
`idea=<id>`, the process, no `issue`); Dismiss shows the Reply box and sends the reply; a member sees neither email nor
buttons.

Editor (extend the Editor's existing harness test, or a component test): `EditorView` in solution mode with an `IdeaSeed`
holding two levers and one note shows the Lever changes box, Remove drops one, and Save sends `levers` with the remaining one
(stub `createSolution`); with no step changes and one lever, Save is allowed.

Run everything per `builder-brief.md` (`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build`).

---

## Out of scope

- Play mode on the Overview, an issue page or a solution page (Q1).
- Visitors changing steps (moving, adding or removing them): levers only ("Levers change numbers, not steps").
- Stacking the workspace's saved scenarios in play mode (Q8).
- Emailing replies or notifications to visitors or editors (no SMTP; Q6). Showing replies to visitors.
- Per-IP rate limiting (Q9). CAPTCHA.
- Accepting a visitor's idea as a saved scenario (the PRD's old "accept becomes a saved scenario"; superseded).
- Adding levers to solutions started any other way (the Editor only shows those an idea brought; a general lever editor in
  solution mode is a later ticket).
- MCP tools for play links or visitor ideas. Branding (B5).
- The demo (`/demo`) has no play link.

## Done criteria

- [ ] Migration `20261217000000_play_links` with the full header (preflight with md5s, post-apply, rollback with full bodies);
      apply file; bootstrap regenerated; `database.types.ts` hand-edited; row added to `docs/production-migrations.md` as
      **NOT applied**.
- [ ] A process can be shared with **Let people try changes**; the visitor moves the shown levers on the snapshot in the
      browser; nothing is stored; reload resets.
- [ ] **Send this idea** creates a pending solution idea through `submit_play_proposal`; anon can make no other write (DB and
      PostgREST tests); rate and size limits tested.
- [ ] Suggestions shows the visitor's idea with name, note and changes; editors see the email; Dismiss takes a reply.
- [ ] Build it opens the Editor in solution mode (with or without an issue) with the changes placed after the server-side
      check against live; saving stores `lever_changes`; the solution's numbers use them everywhere it is simulated.
- [ ] Nothing auto-applies (test).
- [ ] The `suggestions` delete-user bug is fixed (test).
- [ ] Every new field, switch and section has an (i) with a description and an example; wording as in this brief.
- [ ] No `ENGINE_VERSION` change; goldens untouched.
- [ ] Docs: an addendum to `docs/adr/0016-share-links.md` ("Play links": real ids checked, not mapped; the one anon write;
      limits; proposals in Suggestions; lever changes in solutions now simulated); `docs/supabase-notes.md` (transaction-local
      settings from a definer function over PostgREST; anon definer insert bypassing RLS; jsonpath id checks — anything
      verified only on plain Postgres); PRD §4.1 and §9 updated (play submissions go to Suggestions, ids checked) and a §13 row
      (next free D number) summarising Q1–Q10 as "Claude's defaults, for Austin to confirm".
- [ ] `pnpm lint && pnpm typecheck && pnpm test` and the web build green locally; draft PR with `Closes #33`, the migration
      and apply file paths, the preflight queries, and a note that it must merge **after** B3.

## Open questions (each with the default the builder takes)

| # | Question | Default |
|---|---|---|
| Q1 | Which link kinds can be play links? | **Process only.** Levers act on a process model; the Overview deliberately has none (HANDOVER design call), and issue/solution pages show no levers. |
| Q2 | A visitor may not know which issue their idea fixes. | **Optional issue** (picked from the process's open issues in the snapshot). Widen `suggestion_proposals_issue` for `play_link` only; `build_proposal` accepts no issue for them. |
| Q3 | `solutions.lever_changes` are stored but never simulated today. Build it with lever changes would save a solution whose numbers ignore them. | **Make them count** wherever a solution is simulated (Editor, server verdict, solution page, Overview impact, demo). No stored solution has any (preflight 4), so nothing moves. |
| Q4 | "Map redacted ids back"? | **Real ids are checked, not mapped** (B3 Q5): in the snapshot and in the workspace at submit; against live at Build it, dropping gone ones with a note. |
| Q5 | Who sees the visitor's name and email? | **Name:** everyone who reads Suggestions (the ticket: "marked with the visitor's name"). **Email:** owners, editors and agency admins only, via `play_proposal_contacts`. |
| Q6 | "Dismiss with a reply": is the visitor told? | **No email** (no SMTP; a paid service). The reply is stored as `review_note`; the card shows the visitor's email so the editor can reply themselves. |
| Q7 | Scrub names or money from what a visitor types? | **No**: stored and shown as typed, like any typed title (Austin's #30 Q10). Rendered as plain text. |
| Q8 | Can a visitor stack the snapshot's saved scenarios? | **No**: the library is hidden in play mode; a visitor sends only the levers they moved. |
| Q9 | Rate limits? | **Per link** 5 per 10 min and 50 per day; **per email per link** 10 per day; **200 pending** visitor ideas per workspace. No per-IP limit (the DB sees Vercel's address; no shared store). Honeypot field. |
| Q10 | Bundle the HANDOVER's `suggestions` FK / `suggestions_before_write` fix? | **Yes**: same area, one small replaced function in the same migration, with its own test; remove the follow-up from the HANDOVER when merged. |
| Q11 | Where does the play section go on the process page? | Right after the map/headline section, as **Try your own changes**; nowhere else in the app renders levers. |
| Q12 | Old view-link snapshots without `hiddenLevers`? | Read as `[]`; a play link can't be made from them (they're view links); Update copy adds the field. |
