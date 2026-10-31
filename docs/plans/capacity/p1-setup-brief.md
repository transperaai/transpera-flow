# P1: data model and Set up

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-p1-setup`, from `claude/relaxed-babbage-51ysen`.
Sources:
- the P1 row of `docs/plans/client-build-handover.md`;
- requirements sections 3, 4 and 6, and D3–D5, D13, D16–D19, D23, D26, D27, D35–D37;
- the prototype screens **Tiers & clients** (`pageSetupClients`) and **People & roles** (`pageSetupPeople`), and its
  example data (`base()`).

The engine field names you map to are in `docs/plans/capacity/p23-interface-brief.md`. That package is being built
in parallel, so read its section 1 and name columns so the later mapping is obvious.

## The short version

Joe (the Owner) and Agency admins can key in everything the capacity figures need:
- departments and tiers;
- each tier's deliverables;
- named clients with their overrides;
- counted clients through each person's portfolio;
- people's team time, salary, tiers served and labels;
- roles' department, kind, line, rule of thumb and unit.

Viewers see it read-only. **This package stores and edits. It does not change what the engine is given.** The
existing `toEngineModel` output must be identical for every existing workspace and fixture, so goldens and db model
tests don't move. P2 wires the new columns into the engine.

## 1. Migration `20270119000000_capacity_setup.sql`

**Rules for the migration:**
- Additive only: new tables, and new nullable or defaulted columns.
- Full rollback SQL in the header.
- RLS like the neighbouring tables: read for workspace members, writes for Owner and Agency admin (D18). Find the
  current role check that `clients` and `client_groups` writes use, and reuse it.
- Every editable number keeps provenance as `client_groups.provenance` does (`{column: {source, at, by}}`), with a
  source label of `interview | calculator | measured | estimate`. Seeded defaults are `estimate`.
- If you redefine `save_fields`, copy the latest definition, in `20261230000000_references_and_logos.sql` or later,
  and append to its allow-list.

| Table / column | What it holds |
|---|---|
| `departments` (new) | `id, workspace_id, name, sort`. A new workspace and the migration seed **Organic (SEO)** and **Performance** only when a workspace has none. Use the prototype's names. |
| `tiers` (new) | `id, workspace_id, key ("T1"), name, sort, both_count int default 0` ("clients taking both services", counted, per tier, D23). Tiers can be added and removed (D26). A new tier copies the last one's values. You can't remove the last remaining tier. |
| `services.department_id`, `services.tier_id` | Both nullable. A service with both set **is** that tier of that department. One active service per (department, tier). A service with neither keeps working as today. |
| `services` deliverables | `words, links, tech_hours, meetings, builds, creative_sets, channels, adhoc_chance (0–1), adhoc_requests`. All `numeric null` (null means not entered, shown as missing). Fee stays `price`, churn stays `churn_monthly_base`. |
| `services.price_rise_churn` | D36: extra churn for each 10% rise, for 3 months, as a share (0.5 = churn × 1.5). Default 0.5, `estimate`. Stored only; P7 uses it. |
| `clients` overrides | `department_id`-free: the tier comes from the client's services. Add `channels, hand_holding_hours, adhoc_chance, adhoc_requests, adhoc_hours, meetings, words, links, tech_hours, builds, creative_sets, step_factor`, all nullable. Null uses the tier. "Also takes" is a second row in `client_services` for the other department's service of the same tier, as today. |
| `people` | `reserved_share numeric default 0` (team time, 0–0.9), `salary_monthly numeric null`, `label text null check in ('contractor','offshore')`, `ramp jsonb null` (null = the workspace default). |
| `person_tiers` (new) | `person_id, tier_id`: the tiers they can serve. |
| `person_portfolio` (new) | `person_id, service_id, client_count int >= 0`: counted clients they look after (D4). Unique per (person, service). |
| `roles` | `department_id null`, `kind text default 'client_facing' check in ('client_facing','shared')`, `line numeric default 0.85` (D17), `rule_of_thumb int null` (max clients, shown as a line), `unit text null` (D27 label: hours, words, links, ticket hours, tasks, set-ups and incidents). **No rates** (D35). |
| workspace settings keys | `ramp_default` = `[0.4, 0.6, 0.8]` (the prototype's: 40%, 60%, 80% in months 1–3, matching "90 days to about 80%"); `dler_includes_leadership` = `true` (D10, D37), with a "to confirm with the client" note. Use whatever pattern the settings JSON uses today for a typed key (validator plus save function). |

**What a tier count is.** A tier's client count is:

> the named clients on that service + the sum of everyone's `person_portfolio` for it + `client_groups.client_count`

Here `client_groups.client_count` becomes "counted clients nobody's portfolio holds yet". **Don't change that
column's meaning in the engine mapping** (P2 decides). In the UI, show the sum, as the prototype does ("Client counts
are the sum of everyone's portfolio").

Tests (`packages/db/test/capacity-setup.test.ts`):
- RLS: a Viewer can read but not write; an Owner and an Agency admin can write;
- checks and constraints;
- provenance stamping;
- tier add and remove (removing a tier with clients or portfolio rows is refused with a plain message);
- `copy-from-supabase.test.ts` still passes;
- a bundle export and restore round-trips the new tables and columns (`workspace-bundle.ts`, `workspace-import.ts`).

Run `gen:types`, `gen:seed` and `gen:bootstrap`.

## 2. `packages/db` read and write functions

- Loaders for the Set up screens: departments, tiers with their per-department service values and counts, named
  clients with overrides, people with portfolios and tiers, roles with the new fields.
- Writers through the existing compare-and-set pattern, so concurrent saves don't clobber (see
  `concurrent-saves.test.ts`).
- **Pure helpers with tests**, in `packages/db/src/capacity-setup.ts`:
  - `tierCount(...)`, defined above;
  - `uniqueClients(...)`: Organic + Performance − taking both, where both = named clients with two departments plus
    `tiers.both_count`, as the prototype's `lines`;
  - `missingForCapacity(...)`, which lists what isn't entered yet:
    - a tier deliverable;
    - a client-facing person with no portfolio;
    - a shared role with no unit or rate (D35);
    - a person with no salary.
- **`toEngineModel` is unchanged.** Add a test that the model for the Northbeam and Larkspur seeds is deep-equal to
  before (snapshot the JSON before you start).

## 3. Screens (Next.js 16: read `apps/web/AGENTS.md` first)

**Menu:**
- Add a **Set up** group, shown to everyone and editable only by the Owner and Agency admins, with **Tiers &
  clients** and **People & roles** as new routes: `w/[slug]/setup/clients` and `w/[slug]/setup/people`.
- The Services, Client groups, Clients, People and Roles sections of `w/[slug]/settings` move into these two pages.
  Settings keeps the rest, and links to the new pages where the old sections were.
- Don't delete the old section components until the new pages cover every field they edited (servicing links,
  path tags, pricing model, entry process, health, assignments, skills, leave, capacity factors, start and end dates).
  Old fields with no place in the prototype go into a folded "More" per row.

**Tiers & clients**, copying the prototype's layout and wording:
- "+ Add a tier", and "Remove T4" when there are more than 3.
- **One table per department** with the department's fields:
  - Organic: fee, words, links, tech hours, meetings, chance of ad hoc %, requests if they ask, churn a month %;
  - Performance: fee, channels, builds, creative sets, meetings, chance of ad hoc %, requests if they ask, churn a
    month %;
  - plus the tier's client count.
- Leave out the prototype's "Hours a month" column: it needs the engine. Leave a slot for P5.
- **Clients taking both services:** one count per tier.
- **Named clients** table:
  - name, department, "Also takes", "Looked after by" (client-facing people of that department who serve the tier),
    fee, channels, hand-holding h, chance of ad hoc %, requests if they ask, request size (min), meetings a month;
  - a blank cell uses the tier's value and shows it greyed as a placeholder;
  - "+ Add a client".
- Keep the prototype's notes under each table (ad hoc, "Also takes").
- **Any tier, not only Tier 1, can have named clients** (D26). The prototype's "Named Tier 1" wording becomes "Named
  clients", with a tier column.

**People & roles:**
- **Roles** table: role, department, kind (Client-facing or Shared team), line (busy %), max-clients rule (for
  client-facing roles only), unit (for shared teams).
- **How the shared teams work:** the prototype's card, but rates aren't stored here. Show each shared role's unit and
  "Rate not entered yet" (D35), and keep the prototype's note on the full role list.
- **People** table: person, role, hours a week, team time %, speed ×, salary a month, serves tiers (checkboxes), one
  count column per tier (portfolio, client-facing only), named clients (read-only list from the clients table), label
  (contractor / offshore).
- Leave out the "Busy" column (P5).
- Below the table, the prototype's note, and the workspace's ramp default and the DLER leadership switch with its "to
  confirm" tag.

**Every field:**
- gets an (i) with a plain-English line and an example from the prototype;
- shows a small source label when it isn't `entered`;
- shows "missing" from `missingForCapacity` in place.

**Viewers** see the same pages with no inputs. Salaries follow today's pay rule: whoever can't see pay
(`payHidden`) doesn't see the salary column at all.

**Tests:**
- component or route tests for both pages: render, edit one field, Viewer read-only, salary hidden;
- one e2e path: add a tier, add a named client with an override, set a portfolio count, and see the tier count change.

## 4. Defaults for a fresh client workspace (D19)

`docs/new-client.md` / `scripts/new-client.sh` create the client's deployment.
- Add an idempotent "capacity starter" step, a db function or script, that gives an empty workspace:
  - the two departments and T1–T3;
  - each tier's fields from the prototype's `base().tiers` (all `estimate`);
  - the prototype's nine roles with department, kind, line and rule of thumb, and units from D27.
- **No people and no clients.** Joe keys those in.
- Don't run it on any existing workspace.

## Out of scope

- Engine changes and the `toEngineModel` mapping (P2).
- Busy share, hours a month and anything else that needs a run (P5).
- Step work splits (P4).
- The Sandbox (P7).
- Cutting Settings → Levers or share links (P0 is doing those in parallel; leave them alone to avoid conflicts).

## Done when

- `pnpm lint && pnpm typecheck && pnpm test` and the web build pass.
- Goldens are unchanged, and the `toEngineModel` snapshot test is green.
- The report lists:
  - the final column names against the interface brief's field names;
  - every old Settings field and where it lives now;
  - anything you put under "More".
