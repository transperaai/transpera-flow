# PRD — Transpera Flow (process map simulator)

Version 0.3 · 29 Sep 2026 · Owner: Austin · Audience: Claude Code (implementation), future contributors

Changes from v0.2 are the result of a design review ("grill session"). Every decision, with its reasoning, is in §14 (Decision log). Where this document and v0.2 disagree, this document wins.

**Redesign (30 Sep to 1 Oct 2026).** §3 (core concepts), §8 (screens) and decisions D21 onwards in §14 were rewritten after Austin's Milestone A QA. Where an older section (§1, §4, §5, §7, §9, §11) still mentions Reports, the Clients page, Scenarios, the Runs page, Track or Run fix, the redesign wins: those are removed (D22). Rating rules are in `docs/analysis-rules.md`. Terms are in `CONTEXT.md`. The plan and ticket list are in `docs/plans/redesign-plan.md`.

Reference prototype: the "Northbeam Process Simulator" artifact (single-file HTML, to be committed at `prototype/northbeam-process-simulator.html`). It demonstrates the canvas, animated token flow, bottleneck detection, levers, scenario comparison, issues register and a mock of the MCP surface. Its engine (`ProcessSim.simulate`) is the starting point for the v1 engine **but must be ported and fixed, not ported verbatim** (§6.8). Its sample model is the seed for the Northbeam golden model.

---

## 1. Summary

Transpera Flow is a multi-tenant web app that turns a company's documented workflows into a runnable model. An agency consultant (Austin) maps a client's processes during a paid audit, attaches findings to specific steps, and quantifies fixes as before/after scenarios using a discrete-event Monte Carlo simulation. The client then keeps a live workspace: their ops manager maintains the maps, tracks issues, sees per-person and per-role capacity, watches client health and churn risk, and re-runs scenarios (more leads, new hire, faster step, market downturn) at any time. Claude can build and edit processes in a workspace through an MCP server; AI-originated changes never reach production without human review.

Three jobs, in priority order:

1. **Audit and proposal tool.** Every finding becomes a scenario with a number (average and range) on it, and a statement of how robust that number is. The client plays with it in the meeting.
2. **Living ops tool for the client.** Bottleneck register, per-person workload, client health and retention risk, capacity planning, forecasting. They keep it after the engagement.
3. **Foundation for a sellable product.** One deploy, one codebase, workspaces as the tenant boundary, so SaaS is a billing and onboarding layer later, not a rewrite.

### Business model and cost constraint

Transpera Flow is **not sold separately**. It is included in Austin's service retainer as part of a suite. Every dollar of opex is margin, so:

- Hosting cost must be flat, not per-client (target ≈ $45/month total, §10).
- Interactive simulation runs in the browser (zero server cost).
- LLM calls are on-demand and cached, never per-run.

### Success criteria for v1

- Austin can go from raw audit transcripts to a runnable client process map in under an hour using the MCP server plus canvas corrections.
- A client-facing session can show the bottleneck, why it matters (queue growth, wait time, lost revenue, **client retention risk**) and the quantified fix, with a range and a robustness verdict, without leaving the app.
- A client ops manager can change a step time in a draft, see draft vs live, and publish, in under a minute.
- Exports (PDF report, PNG/SVG maps, JSON bundle) are good enough to hand over if the client never logs in again.

---

## 2. Users and roles

| Persona | Who | What they need | Role in app |
|---|---|---|---|
| Consultant | Austin and future agency staff | Build maps fast, attach findings, run scenarios, produce proposals, manage many client workspaces | `agency_admin` (all workspaces) |
| Client owner | Founder / MD of the client business | See the whole company, per-person capacity, client health, financial impact, approve fixes | `owner` (their workspace) |
| Ops manager | Runs operations day to day | Maintain maps, issues, people, clients, workloads; forecast; re-run scenarios | `editor` |
| Team member | Staff at the client | See processes they are part of, their own record and the clients they are assigned to | `member` (restricted visibility) |
| Viewer | Anyone with a share link | Read-only, or "play" with levers without saving; sees only what the link's toggles allow (§9) | `viewer` |

Visibility rules (v1):

- Per-person data (capacity, utilisation, capacity factor) is visible to `agency_admin`, `owner` and `editor`, **and to the person themselves**. `member` sees roles, their own record and the clients assigned to them only.
- Share links see only what their toggles allow (People, Financials, Clients), enforced server-side (§9).
- Transpera Flow models people for **capacity, not performance** (§6.3.7). There are no rankings, leaderboards or "vs role median" benchmarks.

Legal: Transpera Flow processes employee and client data on behalf of the client (client = controller, Austin = processor). Austin's retainer template must include a data processing agreement (DPA) clause. Not a software requirement, but a launch prerequisite.

---

## 3. Core concepts

Terms are defined in `CONTEXT.md`. This is the model behind them.

**The company**

- **Workspace**: one client company. The tenant boundary. Holds everything below.
- **Company model**: services, people, client groups, demand, market conditions, calendar, finances. The numbers the simulation runs against.
- **Service**: something the company sells, with a price, margin, typical stay and normal churn.
- **Client group**: the clients of one service, counted, not named: how many, the fee, normal churn, typical stay and starting health. The engine simulates unnamed clients from these numbers, so late work still drives churn. Named clients are entered one by one in Settings, Clients. Per process, the groups are simulated when one counts clients for a service the process takes; otherwise the process simulates its active named clients. A client who leaves is made inactive, never deleted (D27, D42).
- **Churn driver**: a reason clients leave (for example late work or slow replies), with a weight and an on/off switch. The engine measures the drivers it can and reports each one's share of churn (D28).
- **Market condition**: the outside climate for demand, such as Boom, Stable, Soft or Downturn, or your own. It is a 24-month schedule the engine applies month by month (D29).
- **Resource**: a person, grouped into roles. The engine gives work to individuals.

**Processes**

- **Process**: a directed graph of steps with routing. Two kinds: **pipeline** (leads arrive from demand) and **servicing** (recurring client work, generated per client). The company map is the root process.
- **Sub-process**: a step can hold its own steps, as a group or as a child process. The engine always simulates the detailed steps, so the numbers are the same expanded or collapsed (D26).
- **Step**: a unit of work with a role or named person, hands-on time, wait time, rework rate, tool, cost, SLA and current work in progress. It can also have an expected wait and a "lost per day of waiting". End steps carry an **outcome**: `won`, `lost` or `done`.
- **Entity**: the thing flowing through a process (a lead, a job, a proposal). Defined per process.
- **Version**: each process has one **live** (published) version and at most one **draft**. All edits go into the draft. Publishing makes it version N+1 (D18, amended by D25).
- **History**: the list of published versions. You can view one read-only, restore it as a new draft, or copy it as a new process.
- **Lever**: a "what if" dial on a setting, such as more leads or faster proposals. Levers change numbers, not steps. A solution can include lever changes.
- **Block**: a saved group of steps you can insert into a process, or use to replace a selection. Blocks marked AI came from the AI.
- **Run**: one simulation: 30 replications, with averages and ranges, per-step, per-person and per-client-group results, and a trace for animation.
- **Robustness check**: an on-demand batch of runs that varies each estimated input and says whether the conclusion holds.

**Analysis**

- **Rating**: every rule turns a simulated number into one of four ratings: Great, Good could improve, Bad not urgent, Operational risk. Rules, cut-offs and escalators are in `docs/analysis-rules.md` (D23).
- **Insight**: a finding from a rule or from AI, with a rating, a cost per month and the steps it touches. Insights stay off the map until someone acknowledges them.
- **Issue**: a problem the team has decided to own. It comes from an acknowledged insight or is logged by hand. It links to a whole process or to steps, has owners and a target (measure, now, goal), and a status: Open, Testing solutions, Resolved or Won't fix. It keeps a history log (D24).
- **Solution**: a separate copy of a process with changed steps, plus optional lever changes. A process can have many. A solution can solve more than one issue. It gets an automatic verdict against each issue's target, and the user adds their own (D25).
- **AI idea**: a solution or issue the AI proposes, built from blocks. You can Build it or Dismiss it.
- **First principles**: seven short steps per process that separate hard truths from assumptions and end in goals, which become success measures the analysis can rate (D30).
- **Source**: a transcript, note set or screenshot. A source must link to a process, step, insight, issue or solution (A53).
- **Suggestion**: a pending AI-originated change (to the company model, or an AI idea or proposed issue) awaiting a human decision.
- **Parameter provenance**: every numeric parameter carries `source: estimated | entered | measured`, a date, evidence and, if measured, the dataset.

---

## 4. Scope

v1 scope is **not cut** (decision D3). It is delivered in three milestones (§11).

### 4.1 v1 (build this)

**Workspaces and access**
- Multi-tenant from day one. Agency admin sees all workspaces; everyone else sees one.
- Auth via magic link and Google. Roles as in §2.
- Share links: view-only or "play" (levers usable), optional expiry, and three independent visibility toggles (**People**, **Financials**, **Clients**), all off by default. If any toggle is on, the link must be restricted to named emails (verified by magic link) and must have an expiry (§9).
- Play-link submissions: a visitor can name a scenario they built and submit it with a note. It lands in a **Proposals** queue for the owner/editor, who can review the diff, accept (becomes a saved scenario), or decline with a reply. Visitors give a name and email on submit; nothing else they do on the link is saved. Submitted patches reference redacted IDs and are mapped back server-side on accept.

**Company model (settings area, wizard on first run)**
- Company basics: name, working hours/week, working days, currency, financial year start, overhead per month, target margin, **overtime cap** (default 0%), **availability floor** (default 8%), **individual capacity factor enabled** (default off).
- Services / engagement types: name, pricing model (monthly retainer, one-off, hourly), price, margin, typical tenure (months), **base churn per month**, **churn sensitivity to health**, share of new engagements (mix %), which process path it takes (entry step and any branch tags), **servicing processes** it generates per client (and fallback ongoing load per role per client per month for services with no servicing process mapped).
- People: name, email (optional), roles (one or more), FTE fraction, capacity hours/week, cost rate, steps they can perform (skills), capacity factor per step (only when enabled, default 1.0), leave periods, start/end date. Active flag.
- **Clients (roster)**: name, services, start date, MRR, assigned person per role, current health (entered or estimated), notes. Paste from CSV supported. Replaces v0.2's `person_assignments.client_count`; per-person client counts are derived.
- Demand: lead sources (name, volume/week, conversion to qualified), seasonality curve (12 monthly multipliers), growth assumption.
- Historical data: CSV import for leads, deals, jobs/tickets, time logs, invoices. Column mapper. Calibration job (§6.6) writes measured parameters with provenance.
- Human edits to the company model apply live (they record facts). MCP edits to the company model arrive as **suggestions** (§7.1c). Everything is audit-logged; saved runs and forecasts show a "model changed since this run" banner listing what changed.

**Process editor (canvas)**
- Drag-and-drop node canvas: add step, connect steps (drag from port to port), branch with probabilities, delete, reroute, group into swimlanes by role.
- **On-canvas node editing**: add steps from a palette or by double-clicking empty canvas; rename inline by double-clicking a node; edit key values (role/person, hands-on time, wait) inline on the node; node context menu (edit, duplicate, delete, change kind, pin to person, set rework target); click an edge to edit its probability or condition tag inline; multi-select move/duplicate/delete; copy/paste within a process; undo/redo for every edit.
- Step inspector: name, role or named person, hands-on time (mean + distribution: constant, triangular, lognormal), wait time, rework rate and rework target, tool, notes, attachments, SLA target, **current WIP** (items sitting here now), **outcome** on end steps, evidence citations.
- Sub-processes: a step can hold its own steps, as a **group** (a box of steps inside one process) or a **child process** (a process with its own page, versions and first principles). The company map is the root: its steps are the top-level processes. The engine always simulates the detailed (leaf) steps, so the numbers are the same whether a group is open or closed on the map; a closed group shows a roll-up of its steps (A37).
- **Draft mode for all changes** (§7.1b): every process has a live version and at most one draft. All edits (canvas, MCP, JSON import) go into the draft. The draft is shown as a diff against live (added steps dashed, removed struck through, changed values old → new, each with evidence). Draft vs live can be simulated and compared. Publish requires all assumptions and conflicts resolved or explicitly accepted as estimates.
- Assumption checklist rail (conflicts listed first), template library, JSON import.
- Concurrent editing: per-field saves with a version check. Edits to different fields merge; same-field conflicts prompt "keep mine / keep theirs". Presence ("Tom is viewing Lead to Cash") and live refresh via Supabase Realtime.
- Stable step IDs: the editor never regenerates IDs. Splitting or replacing a step records `replaced_by` on the old step.
- Company map view: processes as nodes, handoffs as edges, aggregate metrics per process.
- Version history per process (who changed what, restore).

**Simulation**
- Discrete-event Monte Carlo engine in a Web Worker (§6). Runs on every lever change, debounced. 30 replications default, configurable to 200 for reports.
- Starts from current WIP where entered; otherwise uses an automatic warm-up period that is discarded (§6.3.1).
- Client servicing is simulated as real work competing for the same people as the pipeline. Client health responds to missed or late touchpoints and drives churn (§6.3.5).
- Animated playback: tokens flow along edges, queues pile up in front of steps, bottleneck pulses. Scrubber, speed, play/pause.
- Utilisation per role and per person (servicing, pipeline, overtime), 85% threshold marked, >100% shown when overloaded.
- KPIs, each shown as **average with 10–90% range** (median and P90 in detail views where tails matter): throughput, cycle time, bottleneck (role, person, step), WIP at horizon end, cost per unit, new MRR, revenue billed in horizon, LTV added, lost revenue, overtime hours, clients at risk, hours freed.

**Robustness**
- On-demand **"Check robustness"** in the compare view; runs automatically on PDF generation (§6.5).
- Output: "Conclusion holds in N% of cases", and the top ~5 most sensitive inputs ("measure this next").
- Runs in a browser worker pool with a progress bar, target 10–30 s for a typical model. Cached by (model version, scenario, parameter).

**Levers and scenarios**
- Lever panel auto-generated from the company model: demand, people (per person and per role), clients (reassign a client), process (per step time/rework/wait), servicing load, finances.
- Patches carry an operation: `set`, `multiply`, `add`. Levers default to relative (`multiply`) for process parameters and absolute (`set`) for facts (headcount, price, FTE).
- Save current levers as a named scenario. Apply, stack, duplicate, delete. Scenarios linked to issues.
- A scenario whose patch target no longer exists gets a **"needs attention"** badge, is excluded from compare and PDF, and raises an issue. It is never silently dropped. Linked issues show that their fix is broken.
- Compare view: baseline vs scenario (and draft vs live) table, templated delta headline in plain English with ranges and robustness, per-role and per-person utilisation side by side.
- Scenario library seeded per workspace with common ones (hire, automate step, more leads, downturn, automate reporting).

**Forecasting (in-app variables only; connectors are v2)**
- Run the current model forward 3, 6 or 12 months from current WIP and the real client roster, using the seasonality curve, growth assumption, health-driven churn, planned hires (people with a future start date), planned leave, and any scheduled scenario ("automation lands in month 2").
- Outputs per month: leads, new clients, active clients by service, MRR, clients at risk, utilisation per role and per person, overtime, and the month each role crosses the 85% ceiling.
- Capacity crunch alerts: "PPC specialists hit 92% in February; hire by January or expect a 9-day queue at campaign setup and 3 clients' reports running late."
- Timeline view: stacked area of active clients by service, line of utilisation per role with the ceiling marked, markers for hires and scenarios. Plan hires by dragging a hire marker along the timeline.
- Plans (B7, #36): a **plan** is a named set of forecast markers (hires, leave, solutions going live from a month), added, dragged along the months (or moved by keyboard) and removed on a "Your plan" lane of the timeline; the forecast re-runs when one is dropped. Plans are saved with their markers (the numbers are re-run, not stored), only owners, editors and agency admins see them, and two plans can be compared side by side (monthly recurring revenue, clients at risk per client group, how busy each role gets, with each plan's average and 10-90% range and the difference of the averages; "No changes" counts as a plan). A solution marker applies the solution's map from its month: the plan is run once per go-live month and the runs are spliced (D44). A plan never changes the live model.

**Issues register**
- Fields: title, type, severity, step and/or person and/or client, evidence (text, metric snapshot, attachments, source citations), owner, status (open, in progress, done, dismissed), linked scenario, created by, dates.
- Auto-detected issues (regenerated on every run, never editable, can be "promoted" to a tracked issue): role or person over 85% utilisation; retainer load alone exceeding capacity (critical); overtime above zero; queue growing without bound; wait over threshold; single point of failure; rework over threshold; SLA breach; **client at churn risk**; **perception gap** (sources disagree by ≥2× on a parameter); broken scenario.
- Filters and views: by process, by person, by client, by severity, audit findings vs detected, kanban by status.
- Client-facing "Findings report" generated from the register (§9).

**Sources and evidence**
- Transcripts, notes and screenshots stored per workspace as sources (speaker(s), date).
- Every AI-inferred parameter cites evidence (source, speaker, quote, timestamp). The assumption badge shows the quote.
- When sources disagree, the parameter becomes a triangular range flagged `conflict: true`, and a perception-gap issue is logged.

**AI layer**
- MCP server (§7) exposing the workspace to Claude Code / Claude desktop.
- Server-side assumptions: when a tool call omits a parameter, the server fills it with a default and marks provenance `estimated` and `assumption: true` so it's visible on the canvas for confirmation.
- AI never changes production without review: process edits go into drafts; company-model edits become suggestions.
- Narration (§7.3): templated text for banners and headlines; LLM only for the PDF executive summary and "explain this run", with every number validated against the run JSON.

**Exports**
- PDF report: cover, executive summary, company map, each process map, bottleneck analysis, client health and retention, issues, scenarios with before/after and robustness, assumptions/evidence/provenance appendix, methodology page.
- PNG/SVG of any map. JSON bundle of the entire workspace (import supported, so a bundle is a full backup).
- CSV of issues, runs, people utilisation, client health.

### 4.2 v2 (design for, do not build yet)

- In-app AI chat panel (paste notes/transcripts, AI drafts the map onto the canvas for correction).
- File upload extraction (SOPs, recordings, Loom transcripts) with the same extraction logic as the MCP tools, landing in a draft.
- Connectors for historical data: HubSpot, Pipedrive, Xero, ClickUp/Asana, Harvest/Toggl, Google Sheets. Scheduled sync into the client roster and re-calibration. Connector-originated changes become suggestions.
- Forecasting fed by live connector data and continuous re-calibration.
- Simulated vs actual chart per process (trust building).
- Excalidraw export, Miro/Lucid CSV export, standalone offline HTML bundle of a workspace.
- Public REST API with API keys per workspace (same contracts as MCP tools).
- Comments and @mentions on steps and issues; email digests.
- Billing, self-serve signup, workspace templates by industry.
- Skill-based routing rules (who gets work first), priorities, batching, shift calendars.
- Real-time co-editing (CRDT).

Moved **into v1** from v0.2's v2 list: recurring client work as its own simulated process.
Removed: per-person benchmark against role median (replaced by capacity factor, §6.3.7).

### 4.3 Non-goals

- Not a project management tool. It does not assign or track real tasks.
- Not a BPMN-compliant modeller. Import/export of BPMN is out of scope.
- Not a performance-review tool. People are modelled for capacity; no rankings.
- The LLM never produces simulation numbers. It builds models, fills gaps with labelled assumptions, and narrates. The engine produces all numbers, and narration is validated against them.

---

## 5. Data model

Postgres via Supabase. Every table has `workspace_id` and RLS policies (§10). `id` uuid, `created_at`, `updated_at`, `created_by` on all tables. JSONB where noted. Changes from v0.2 marked **(new)** or **(changed)**.

```
workspaces          id, name, slug, plan, branding jsonb (logo_url, accent, report_colors),
                    settings jsonb (hours_per_week, working_days, currency, fy_start, overhead_monthly, target_margin,
                    overtime_cap default 0, availability_floor default 0.08, utilisation_threshold default 0.85,
                    capacity_factor_enabled default false)                                   (changed)
memberships         id, workspace_id, user_id, role (agency_admin|owner|editor|member|viewer), person_id (nullable link to people)
api_tokens          id, user_id, token_hash, label, last_used_at, revoked_at                  (new)
share_links         id, workspace_id, token, mode (view|play), show_people bool, show_financials bool, show_clients bool,
                    allowed_emails text[] (required non-empty if any show_* is true), expires_at (required if any show_*),
                    created_by                                                                (changed)

services            id, workspace_id, name, pricing_model (retainer|one_off|hourly), price, margin, tenure_months,
                    churn_monthly_base, churn_health_sensitivity default 3 (estimated), mix_share, entry_process_id,
                    path_tags text[], fallback_ongoing_load jsonb ({role_id: hours_per_month}), active    (changed)
service_servicing   service_id, process_id, recurrence jsonb ({every: week|month, times: n} | {poisson_per_month: r})  (new)
roles               id, workspace_id, name, color, default_cost_rate, active (new), provenance (new)
people              id, workspace_id, name, email, fte, capacity_hours_week, cost_rate, active, start_date, end_date, notes
person_roles        person_id, role_id
person_skills       person_id, step_id, capacity_factor numeric default 1.0, provenance jsonb   (changed: renamed from efficiency)
person_leave        id, person_id, start_date, end_date, note
clients             id, workspace_id, name, start_date, mrr, health numeric (0–100), health_provenance jsonb, notes, active  (new)
client_services     client_id, service_id, start_date                                         (new)
client_assignments  client_id, role_id, person_id                                             (new; replaces person_assignments)

lead_sources        id, workspace_id, name, volume_week, conversion_to_qualified, provenance jsonb
seasonality         workspace_id, month int, multiplier numeric
demand_settings     workspace_id, growth_monthly, horizon_weeks default 13

processes           id, workspace_id, name, kind (pipeline|servicing), entity_name, description, parent_process_id (nullable:
                    the process it sits inside; null for the company map's own steps, A37), live_revision_id,
                    draft_revision_id (nullable), source (manual|template|mcp|import)   (changed)
process_revisions   id, process_id, number int, status (draft|published|superseded), layout jsonb, source_refs uuid[],
                    published_at, published_by                                                (new)
process_templates   id, name, industry, kind, description, graph jsonb
steps               id (stable across revisions), revision_id, process_id, name, kind (task|wait|decision|subprocess|group|start|end),
                    parent_step_id (the group it sits in), entry_step_id (a group's first step), child_process_id (a subprocess
                    step's child process; A37, nesting to any depth and never in a loop),
                    outcome (won|lost|done, end steps only), role_id, person_id (nullable, pinned assignee),
                    work_hours, work_dist (constant|triangular|lognormal), work_params jsonb, wait_hours, wait_dist, wait_params jsonb,
                    rework_rate, rework_to_step_id, tool, notes, sla_hours, current_wip int, cost_override, x, y,
                    provenance jsonb, assumption bool, conflict bool, replaced_by uuid[]      (changed)
edges               id, revision_id, process_id, from_step_id, to_step_id, probability, condition_tag (nullable), label
step_attachments    id, step_id, file_url, kind

sources             id, workspace_id, kind (transcript|notes|screenshot), title, speakers text[], recorded_at,
                    body text, file_url                                                        (new)
suggestions         id, workspace_id, target_table, target_id (nullable for create), patch jsonb, evidence jsonb,
                    status (pending|accepted|rejected), created_via (mcp), reviewed_by, reviewed_at  (new)

scenarios           id, workspace_id, name, description, patch jsonb ([{path, op: set|multiply|add, value}]), is_baseline bool,
                    parent_scenario_id, status (ok|needs_attention), created_by               (changed)
scenario_submissions id, workspace_id, share_link_id, submitter_name, submitter_email, note, patch jsonb, status (pending|accepted|declined),
                    reviewed_by, reviewed_at, reply, accepted_scenario_id
forecast_plans      id, workspace_id, name, markers jsonb ([{id, kind: hire|leave|solution, date, role_id+fte(+name) | person_id+weeks | solution_id}], at most 40, at most 4 solutions;
                    ids are checked at write time, not foreign keys), created_by, created_at, updated_at   (B7; owners, editors and agency admins only)
runs                id, workspace_id, scenario_id, revision_ids uuid[], engine_version, reps, seed, params_snapshot jsonb,
                    results jsonb, trace_url (storage), duration_ms                           (changed)
robustness_results  id, workspace_id, run_id, cache_key, results jsonb (verdict, sensitivities[])   (new)
narrations          id, workspace_id, target (run|comparison), target_id, purpose (summary|explain), input_hash, model,
                    text, validated bool, fallback bool, fallback_kind, fallback_reason, rejected jsonb, usage jsonb,
                    edited_by (nullable), edited_by_name, edited_at (docs/adr/0011-narration.md)   (new)
issues              id, workspace_id, process_id, step_id, person_id, client_id, type (bottleneck|spof|manual|delay|failure|idea|
                    capacity|sla|churn_risk|perception_gap|broken_scenario), severity (critical|serious|warning|info), title,
                    evidence text, evidence_metrics jsonb, evidence_sources jsonb, owner_person_id, status, scenario_id,
                    source (manual|detected|promoted), detected_key, resolved_at              (changed)
issue_comments      id, issue_id, body, author_id

datasets            id, workspace_id, kind (leads|deals|jobs|time_logs|invoices), file_url, column_map jsonb, row_count, imported_at
calibrations        id, workspace_id, dataset_id, results jsonb (what changed, before/after), applied bool
audit_log           id, workspace_id, actor_id, actor_kind (user|mcp|system), action, target_table, target_id, diff jsonb
```

Notes:
- `patch` paths follow the prototype's dotted convention (`steps.<step_id>.work_hours`, `people.<person_id>.fte`, `services.<id>.mix_share`, `lead_sources.<id>.volume_week`, `clients.<id>.assignments.<role_id>`), now with an `op`.
- Runs store a `params_snapshot` and the revision IDs used, so a run remains reproducible when the model later changes.
- `provenance jsonb` shape: `{source: "estimated|entered|measured", at: iso, by: user_id, dataset_id?, note?, evidence?: [{source_id, speaker, quote, timestamp}], conflict?: {values: [{value, source_id, speaker}]}}`.
- Simulation of the live model uses only `published` revisions. Draft-vs-live runs use the draft revision for that one process.

---

## 6. Simulation engine

### 6.1 Principles
- Deterministic given a seed. Same model + seed = same output, in Node and in the browser. Reproducibility is non-negotiable for client trust.
- One TypeScript module (`packages/engine`), two hosts: Web Worker in the browser for interactive use; Node for MCP `run_scenario`, report generation, calibration and server-side robustness.
- Time unit: working hours. Calendar (working days, leave) is applied through resource availability.
- Separate seeded random streams per purpose (arrivals, each step's service time, routing, churn, servicing requests) so that changing one parameter does not reshuffle unrelated draws.
- Transcendental maths (log, exp) uses portable fdlibm ports rather than `Math.log`/`Math.exp`, which engines may approximate differently; normal samples use the polar method (no trigonometry). This is what makes browser and server results byte-identical. This gives common random numbers between baseline and scenario, which the robustness check depends on.

### 6.2 Model resolution
Before a run, the company model (published revisions only, or one draft for draft-vs-live) and a scenario patch are resolved into a flat `SimModel`:
```
SimModel {
  horizonHours, warmupHours, hoursPerWeek, seed,
  arrivals: [{processId, ratePerWeek, seasonality[], conditionTags[]}],        // from lead_sources × services mix
  processes: {id: {kind, entry, steps: {..., currentWip, outcome}, edges: [...]}},
  clients: {clientId: {services[], mrr, health, assignments: {roleId: personId}}},  // real roster
  servicing: {serviceId: [{processId, recurrence}]},
  resources: {personId: {roles[], capacityHoursWeek, capacityFactor: {stepId: mult}, leave: [[start,end]], fallbackOngoingHoursWeek}},
  roles: {roleId: {personIds[]}},
  services: {id: {price, pricingModel, tenureMonths, churnBase, churnSensitivity}},
  thresholds: {utilisation: 0.85, waitHours: 16, reworkRate: 0.2, overtimeCap: 0, availabilityFloor: 0.08}
}
```
Patch application: `set` replaces, `multiply` scales, `add` offsets. A patch whose target does not resolve marks the scenario `needs_attention` and the run is refused for that scenario (never silently skipped).

### 6.3 Mechanics

**6.3.1 Initial state.** If any step has `current_wip` entered, the run starts with that many entities queued at that step (ages sampled uniformly over the step's expected wait) and the real client roster active. Otherwise the engine runs an automatic warm-up (default 4 weeks, extended to 2× the P90 cycle time of a pilot run if longer) and discards it before measuring. Forecasts always start from current state and use warm-up only for steps with no WIP entered.

**6.3.2 Arrivals.** Poisson per pipeline process, rate modulated by seasonality for the simulated calendar month. Condition tags assigned at arrival from the services mix.

**6.3.3 Service and dispatch.** Sample work time from the step's distribution (constant, triangular, lognormal), divided by the person's capacity factor for that step (1.0 unless enabled and measured/entered). When a person frees up, they take the oldest waiting entity across all steps they are eligible for (FIFO across steps, v1). A step pinned to a person, and servicing tasks for a client with an assigned person for that role, only queue for that person (falling back to the role pool while that person is on leave).

**6.3.4 Fallback ongoing load, overtime and the floor.** For services with no servicing process mapped, fallback ongoing load per person = Σ over their clients of (service.fallback_ongoing_load[role] / 4.33) hours/week, recomputed as clients churn or are won. It reduces the fraction of capacity available to pipeline work (service time is stretched by 1 / available fraction). If ongoing load exceeds capacity, capacity is first extended by overtime up to `overtimeCap` (reported as overtime hours and cost). Beyond that, the available fraction is clamped at `availabilityFloor`, utilisation is reported above 100%, and a critical capacity issue is raised. A run is never blocked.

**6.3.5 Client servicing, health and churn.**
- Each active client (real or won during the run) generates servicing entities per its services' `service_servicing` recurrences (e.g. monthly report, fortnightly check-in, Poisson ad-hoc requests). These flow through servicing processes and compete for the same people as the pipeline.
- Each servicing task has an SLA. On completion: on time → health +`recover` (capped at 100); late → health −`late_penalty`; if not completed within 2× SLA → counts as missed, health −`missed_penalty`.
- Monthly churn probability per client = `churn_base × (1 + churn_sensitivity × (100 − health) / 100)`, evaluated on a weekly tick (divided by 4.33). Churned clients stop generating servicing work and stop billing.
- Defaults (all provenance `estimated`, covered by robustness): starting health from roster or 80, `recover` 2, `late_penalty` 5, `missed_penalty` 12, `churn_sensitivity` 3.
- New clients won in the pipeline are synthetic ("New PPC client #3"), assigned per role by round-robin among eligible people.

**6.3.6 Other mechanics.**
- Wait: sampled external delay after service, no resource consumed.
- Rework: with probability `rework_rate`, route to `rework_to_step_id` (default: same step).
- Routing: edge probabilities, or condition tags (an entity carrying tag `ppc` follows the `ppc` edge).
- Leave: a person on leave has zero capacity for that window; their queue waits or is taken by another eligible person.
- Event queue: binary heap.

**6.3.7 People: capacity, not performance.** People are modelled individually for availability, FTE, leave, skills (who can do what) and assignments. The per-step capacity factor exists but is disabled by default per workspace. When enabled, it is only displayed once measured (minimum sample size: 10 completed items for that person-step) or explicitly entered; it is visible to the person themselves; and it is never presented as a ranking or against a role median.

### 6.4 Outputs per run
All headline metrics are reported as **mean with 10–90% band across replications**; median and P90 additionally for time-based metrics.
- Global: throughput (won/done), lost, cycle time (mean/P50/P90), WIP at end, labour cost, overtime hours and cost, cost per unit, new MRR, revenue billed within horizon (net of churn), LTV added (price × expected tenure), lost revenue (lost entities × expected value), clients churned, clients at risk (health < 50), hours freed vs baseline.
- Revenue rules: revenue is booked **once per entity, at the first `won` end step**, priced by the entity's service tag. Processes downstream of a win (onboarding, delivery, servicing) book no revenue.
- Per step: arrivals, avg/max queue, avg wait, reworks, SLA breaches, utilisation of its assignees.
- Per step facts (issue #174): mean hands-on, part-time stretch, queue wait and fixed wait per visit; whether only one person can do it (a role of one, a pinned person with no alternative; leave for the whole run and zero capacity excluded) or nobody can.
- Rework loops (issue #174, D41): any routing back is a loop. Same-step redo, and back-edges found by a depth-first search over the flattened model in a canonical order (by step order, not drawing order). Per loop: share of items that go round at least once, mean rounds per looper, extra hands-on hours a month by role, extra working hours added to cycle time. A loop's region is the steps on paths from the back-edge target forward to its source. Counts are events in the measured window (a looper at its first send-back, a clean stay when it ends), and rounds per looper is 1 + repeat send-backs / repeat exits, so long loops are not under-counted; ratios are sums over replications, with the band from replications that have a denominator. Each repeat pass is counted once, in the innermost loop it is on, so loops add up to the de-duplicated `rework` total.
- Per person: utilisation (servicing, pipeline, overtime, total), hours by step, items completed, clients assigned.
- Per role: same, aggregated.
- Per client: touchpoints on time / late / missed, health trajectory, churn probability, churned (share of replications).
- Bottleneck: role and person with highest utilisation; step with largest time-weighted queue; shadow price = extra completions from +1 FTE at the bottleneck (automatic extra replication set for the top bottleneck).
- Detected issues (§4.1) with stable `detected_key` for diffing between runs.
- Trace of replication 0 for animation (entity segments with tQ/tS/tE/tL, person id).

### 6.5 Robustness check
- Trigger: "Check robustness" button in compare, automatically on PDF generation. Not on lever changes.
- Parameters perturbed: every parameter with provenance `estimated` (including health/churn defaults). Conflicted parameters use their actual triangular range; others use ±25%.
- Two stages: screen all parameters one-at-a-time at 10 replications; refine the top ~5 by influence at 30 replications. Baseline and perturbed runs share random streams (§6.1).
- Output: verdict ("Strategist is the bottleneck in 100% of cases; the hire adds MRR in 94% of cases"), top sensitive inputs, and a flag when the conclusion flips inside a conflict range ("answer depends on whose estimate of proposal time is right; measure this").
- Execution: browser worker pool (one worker per core, minus one) with progress; server-side (Node, time-capped) for MCP and PDF. Target 10–30 s in the browser for a 40-step / 25-person / 25-client model. Cached by (model hash, scenario hash, parameter, perturbation).

### 6.6 Calibration (from historical data)
Given mapped datasets, compute and propose: arrival rates per source, conversion at each decision step, service time distributions per step (and per person where time logs have a person column; capacity factors only if enabled), wait times (timestamps between stages), rework rates (re-opened jobs), churn per service, and servicing SLA performance. Show proposed vs current side by side; user applies all or some. Applied values get `provenance.source = measured`.

### 6.7 Performance targets
- 9 steps, 6 people, 13 weeks, 30 reps: < 150 ms in a worker.
- Seeded Northbeam with its client roster and servicing (about 15 steps, 11 people, 26 clients), 13 weeks, 30 reps: < 250 ms.
- 40 steps, 25 people, 25 clients with servicing, 26 weeks, 30 reps: < 1.5 s. Debounce slider input at 40 ms; cancel stale runs.
- 12-month forecast of the above: < 5 s.
- Robustness: see §6.5.

### 6.8 Porting the prototype engine
Port `ProcessSim` from the prototype and fix the following, each with a failing test first:
1. Single shared RNG stream → separate streams per purpose (§6.1).
2. Reported ongoing utilisation uses the starting `activeClients` while availability uses the live churned/won count → report from the live count.
3. `pop()` is a linear scan (O(n²) overall) → binary heap.
4. `mrrAdded = won × retainer` → per-service pricing and the revenue rules in §6.4.
5. Resources pooled by role `count` with a hard-coded 0.08 floor → dispatch to named people; floor configurable (§6.3.4).
6. Starts empty with no warm-up → §6.3.1.

Northbeam is re-baselined after the fixes rather than matched to the prototype: in place of v0.2's "strategist ~91%, ~7 wins/quarter at seed 1", engine 1.0.0 gives strategist 84.5% (range 73–99%) and 10.4 wins a quarter (range 7–14) at 7 leads a week, seed 1, 30 replications. `docs/engine-versioning.md` has the full values and why they differ (issue #22).

### 6.9 Verification (all in CI on every push)
1. **Queueing-theory checks**: M/M/1, M/M/c and a Jackson network of steps in series must match analytic utilisation, queue length and wait within tolerance (~10 test models).
2. **Behaviour checks**: more leads → higher bottleneck utilisation; +1 person at the bottleneck never lowers throughput; overload → more missed touchpoints → lower health → higher churn; same seed → identical output in Node and browser; warm-up removes empty-start bias.
3. **Golden models**: Northbeam plus a second, messier sample agency (overload, overtime, named client roster, health-driven churn). Key outputs snapshotted; any change fails CI until the new baseline is approved, and `engine_version` is bumped. Built in #22: Larkspur Creative is the second agency; the workflow is in `docs/engine-versioning.md`.

---

## 7. AI layer and MCP server

### 7.1 MCP server
HTTP MCP endpoint in the Next.js app (`/api/mcp`), official MCP TypeScript SDK (Streamable HTTP transport), authenticated with a per-user bearer token (hashed in `api_tokens`). The server acts **as the user**: queries run under the user's identity so RLS applies. The Supabase service-role key is never used in the MCP path. Claude Code / Claude desktop connects once; the agent selects the active workspace per session.

Tools (v1). All return `{ok, data, assumptions[]}`; `assumptions` lists any defaulted parameters.

```
list_workspaces()
set_active_workspace({workspace})
get_workspace_summary()                        -> company model overview, processes, people, clients, KPIs of last baseline run

add_source({kind, title, speakers?, recorded_at?, body?, file?, links})   -> source id for citing; links (process, step, insight, issue or solution) required, or link_later: true when the next call cites it   (new)
link_source({source, links})                                                                     -> more links for an existing source                                                              (new)

create_process({name, kind?: pipeline|servicing, entity_name, description?})
add_step({process, name, after?, before?, role?, person?, work_hours?, work_dist?, work_params?, wait_hours?,
          rework_rate?, tool?, notes?, sla_hours?, current_wip?, outcome?, evidence?: [...]})            (changed)
update_step({step, ...fields, evidence?})
remove_step({step})
connect_steps({process, from, to, probability?, condition_tag?})
set_routing({step, routes: [{to, probability}]})
get_process({process, revision?: live|draft})  -> full graph JSON
import_process({process_json, target?})        -> no target: creates a new process as a draft.
                                                  target: writes into that process's draft revision (creating one
                                                  if needed), matching steps by stable ID then name; returns the
                                                  diff vs live.                                               (changed)
publish_process({process})                     -> fails if unresolved assumptions/conflicts remain unless {accept_estimates: true}
discard_draft({process})                                                                                  (new)
list_templates() / create_from_template({template, name})

set_company({hours_per_week?, currency?, overhead_monthly?, ...})        -> suggestion                     (changed)
upsert_service({name, pricing_model, price, tenure_months?, churn_monthly_base?, mix_share?, servicing?}) -> suggestion
upsert_person({name, roles[], fte?, capacity_hours_week?, cost_rate?, skills?, leave?})                   -> suggestion
upsert_client({name, services[], mrr?, start_date?, assignments?: {role: person}, health?, evidence?})    -> suggestion (new)
upsert_role({name, rename?, create?, evidence?, note?})                                                   -> suggestion (new)
set_demand({lead_sources?, seasonality?, growth_monthly?})                                                -> suggestion
list_suggestions({status?})                                                                               (new)

run_scenario({overrides?: [{path, op, value}], reps?, horizon_weeks?, revision?: live|draft})  -> run summary (no trace)
save_scenario({name, description?, overrides})
compare_scenarios({a?, b})                     -> delta table + templated narrative
check_robustness({scenario})                   -> verdict + sensitivities (server-side, time-capped)      (new)
get_bottlenecks({process?})                    -> ranked constraints with evidence and shadow price
log_issue({title, type, severity, step?, person?, client?, evidence?, owner?, scenario?})
list_issues({status?, type?, process?})
get_facts({process?}) / list_findings({status?, process?}) / get_analysis({process? | company}) / list_sources({process?}) / list_solutions({process?})   (B17: what an analysis needs)
export_report({format: pdf|json, scenarios?: []}) -> signed URL
```

Naming: tools accept step/process/person/client by id or by unique name (fuzzy match with confirmation threshold; return candidates on ambiguity rather than guessing).

### 7.1b Process intake workflow and draft mode

Three doors in v1, one format behind all of them (the `import_process` graph JSON), and **every door lands in a draft**.

1. **Recorded audit → Claude → MCP (primary).** Consultant records the walkthrough or interview; a transcript is produced. In Claude Code / Claude desktop with the MCP server connected and the client workspace active, the consultant supplies transcripts. Claude calls `add_source` for each, applies the extraction prompt (§7.2), and calls `import_process` (new process, or `target` for a process that already exists). The draft appears on the canvas with assumption badges on every inferred number, each citing its evidence. The consultant corrects structure, confirms or overrides each assumption (confirmation flips provenance to `entered`), resolves conflicts, then clicks **Publish**.
2. **Manual.** Blank canvas or template, then edit in the inspector. Edits to a published process open a draft automatically.
3. **JSON import in the UI.** Paste or upload the same graph JSON, into a new draft or an existing process's draft.

Draft rules:
- Each process has one live revision and at most one draft revision. Live is what the simulation, company map, forecasts and reports use.
- The draft is shown as a diff against live, with evidence per change. Individual changes or the whole draft can be discarded.
- Values with provenance `entered` or `measured` are never overwritten by a new source without being flagged as a conflict.
- Draft vs live can be simulated and compared (including robustness) before publishing.
- Publish: requires all assumptions and conflicts resolved or accepted as estimates; bumps the revision number; writes the audit log; recomputes affected scenarios and marks broken ones `needs_attention`.

Draft review UI: a checklist rail listing conflicts first, then every assumption, with the step, the value, Claude's reasoning and the cited quote; confirm/edit inline.

### 7.1c Company-model suggestions
Human edits to people, clients, services, demand and company settings apply live. MCP calls that change those tables create **suggestions** (target, patch, evidence) shown in one review list ("Claude suggests lead volume 15/wk, was 12, citing …"). Accept applies the patch with provenance from the evidence; reject records the decision. All changes are audit-logged with `actor_kind`.

### 7.2 Extraction prompt (used by Claude on the client side in v1, by the app in v2)
Input: one or more sources (transcripts, notes). Output: `import_process` JSON with steps, roles, times, waits, rework, routing, current WIP, end-step outcomes, plus:
- `evidence[]` on every number that came from a source (source id, speaker, verbatim quote, timestamp).
- `assumptions[]` stating every number that was not in any source and the reasoning.
- When sources disagree: a triangular distribution (min / most likely / max) spanning the stated values, `conflict: true`, and the conflicting values with their speakers.
- Suggested company-model updates (people, clients, demand) returned separately, to be submitted as suggestions.

### 7.3 Narration
- **Templated (no LLM)**: KPI banners, compare headlines and issue evidence text. Format: "Hiring a strategist adds avg £4.2k MRR (range £3.1–5.0k); holds in 94% of cases."
- **LLM (Anthropic API, server-side only)**: `POST /api/narrate` for the PDF executive summary and the "explain this run" action. The prompt requires the average-plus-range format and the robustness verdict.
- **Validation**: after generation, the server extracts every number from the text and matches it against the numbers in the input JSON (tolerant of rounding and formatting, e.g. "£4,213" ≈ "£4.2k"). On any mismatch it retries once naming the offending numbers; on a second failure it falls back to templated text. A hallucinated figure never ships.
- Cached per run/comparison in `narrations`. On demand only, never per run.
- Editable before export; edits are recorded ("edited by Austin") in the provenance appendix.

---

## 8. Screens

The reference is the clickable prototype, `apps/web/prototype/app-flow.html` (a throwaway, never shipped). Screens use plain words: "Too busy", not "utilisation"; "Missed deadlines", not "SLA missed". Every setting, lever and rule has an (i) with a plain description and an example.

The sidebar has three groups. **Overview** and **Processes** sit at the top. **Improve** holds Issues, Solutions, Block library and Suggestions. **Company** holds Sources, People and Settings. Counts show beside the items that have them.

1. **Overview**: the landing page. The company map, four headline cards, and a time-horizon picker (1, 3, 6, 12 or 24 months). Below, "Findings by process": the AI analysis of the company (Analyse, its read, findings to review, add a finding), then each process's accepted findings and facts (D40), then trend charts.
2. **Processes**: a list of all processes, sub-processes indented. Each row opens its own map card.
3. **Process page** (read-only, "Viewing live · version N"): sections in order: first principles card, projection, map, findings (the AI analysis with its review list, and the accepted findings), facts from the run (evidence), issues, solutions, supporting charts (D40). No tabs and no drawers. A process switcher sits on the title, with breadcrumbs. The map has bigger nodes coloured by rating, zoom (−, Fit, +), expand and collapse for groups, and red badges only for confirmed issues. Hovering an insight or issue highlights the steps it touches.
4. **Editor**: its own full-screen mode in a different colour, so you can always tell you are editing. Step palette, inspector, draft versus live. Simulate a preview, then "Publish version N?" with a confirm. Three modes: draft, solution and block.
5. **History**: a timeline of published versions with each one's headline numbers and charts. View a version read-only, restore it as a new draft, or duplicate it as a new process.
6. **Issues**: a list with Open, Resolved and All, and rating filters.
7. **Issue page**: where it sits on the map, solutions tested, AI ideas and history. Mark resolved (by a solution, by changing the process, or no longer a problem) and Reopen. "Build solution" opens the Editor in solution mode.
8. **Solutions**: the list of all solutions, with their verdicts.
9. **Solution page**: live and solution maps side by side, opening and closing together. Measures, an MRR chart, a market stress test, a verdict per issue, and notes.
10. **Block library**: save a group of steps as a block. Insert one, or replace a selection with one, in the Editor.
11. **Suggestions**: AI solution ideas (Build it or Dismiss), AI-proposed issues, and pending changes to the company model (accept or reject). Visitor proposals from play links arrive here too (B4).
12. **Sources**: transcripts and notes. Each links to the things it supports. Unlinked sources are flagged.
13. **People**: how full each person's week is, absence-test results, and client health against a benchmark. Person detail with skills and leave. Capacity, not performance: no rankings (D20).
14. **Settings**: basics, services, demand, client groups, churn drivers, market conditions, levers (show or hide, with help), AI switches, money and currency, and the import and calibration wizard (Milestone C).

Findings show as rated rows with where each sits on the map and whether AI or a person wrote it; a detail pop-up opens from the row, with the facts it rests on. Facts show as evidence beside them, with their cost per month. Acknowledging a finding is what puts it on the map and lets it become an issue (D40).

Outside the main nav: the **workspace list** (agency admin), the **Forecast** timeline (B6, B7: drag hire, leave and solution markers; compare two plans) and **Share** (B3: links with modes, toggles, allowed emails and expiry; snapshots cover Overview, a process, an issue and a solution).

What was removed in the redesign is listed in D22 (§14).

### 8.1 Design system and UI stack

*Amended by D33: the look now comes from the shadcn radix-nova preset (Inter, teal-blue brand, neutral greys). Where the bullets below name other fonts or a single accent, D33 wins.*

UI quality is a primary requirement, not a finish. The stack is chosen so every visual decision is ours rather than a component library's default.

- **Tokens first.** A single `tokens.css` (colour, type scale, spacing, radius, shadow, motion durations) with light and dark values, mirrored into Tailwind's theme. No raw hex or px in components. Start from the prototype's tokens (Bricolage Grotesque for display, IBM Plex Sans for UI, IBM Plex Mono for data; slightly cool-grey neutrals; one accent; semantic status colours reserved for good/warning/serious/critical; a fixed role palette per workspace validated for colour-vision safety).
- **Tailwind CSS v4 + shadcn/ui (Radix primitives).** Nothing from a themed kit (no MUI, no Ant).
- **Motion: Framer Motion** for panel transitions, number tick-ups on KPIs, delta reveals, and the pulse on a bottleneck node. All motion respects `prefers-reduced-motion`.
- **Canvas: React Flow (xyflow)** with fully custom node and edge components: role stripe, live queue count, wait badge, assumption badge, conflict badge, draft-diff styling, selection ring; animated token layer as an SVG overlay driven by the run trace, positioned with `getPointAtLength` along the real edge paths; swimlane background layer; minimap; keyboard shortcuts.
- **Charts: visx** for utilisation bars, forecast timeline, compare bars, range bands, sparklines in KPI tiles. Shared axis, grid, tooltip and legend components. Text always in text tokens, never series colour; ≥2 series always get a legend; no dual axes.
- **Ranges are first-class in the UI**: every KPI tile shows average and range; charts show bands, not just lines.
- **Layout.** Ops-console: KPI strip on top, canvas left, control rail right with tabs. Command palette (⌘K) for jumping to any step, person, client, scenario or issue. Responsive to tablet; phone is read-only.
- **Typography and density.** Tabular numerals everywhere digits align; a fixed type scale; dense but breathable rows (32–36 px) for tables; generous canvas whitespace.
- **Client branding (v1).** Workspace-level logo, accent colour and report colours. Accent validated for contrast on both themes at save time.
- **Empty and loading states are designed**, not default.
- **Storybook** for every component and chart in both themes; visual regression via Playwright screenshots on each PR.
- **Accessibility floor.** WCAG AA contrast, full keyboard operation of canvas and rail, focus rings visible, ARIA on custom nodes.

---

## 9. Exports and sharing

*Amended by D22: the PDF report, report route and `export_report` tool are removed. Share links stay (B3), as do map image export, JSON bundle and issues CSV (B10). The paragraphs below describing the PDF are historical.*

- PDF via server-side headless Chromium (`@sparticuz/chromium` in a Vercel function) rendering a print stylesheet of a report route. Fallback if function limits bite: the same print stylesheet via the browser's "Save as PDF". Sections: cover, executive summary (validated narration), company map, per-process map with bottleneck callouts, client health and retention, issues (grouped by severity, with owner and linked fix), scenario comparisons (before/after tables with ranges, utilisation charts, robustness verdict and sensitive inputs), assumptions/evidence/provenance appendix, methodology page.
- PNG/SVG: canvas export at 2× with legend.
- JSON bundle: full workspace, importable; this is also the backup/migration format.
- CSV: issues, runs, people utilisation, client health.

**Share links**
- Token-based. `play` mode runs the engine client-side, so the browser receives a model snapshot. **The server builds a redacted snapshot per link; the browser never receives data a toggle hides.**

| Toggle (default off) | Off | On |
|---|---|---|
| People | People anonymised by role ("Strategist A"); capacity factors flattened to 1.0 | Real names, individual capacity factors |
| Financials | Cost rates replaced by a role-average blended rate; margins and overhead hidden; KPIs show revenue only | Real rates, margins, overhead |
| Clients | Clients anonymised ("Client 7"); health aggregated ("3 clients at risk") | Real client names and per-client health |

- If any toggle is on: `allowed_emails` must be non-empty (visitor verifies by magic link) and `expires_at` is required.
- View-only links get the same redaction applied to stored run results.
- The only write a play link can make is a scenario submission (name, email, note, patch against redacted IDs), via a rate-limited Postgres function into `scenario_submissions`. IDs are mapped back server-side on accept.

---

## 10. Architecture and hosting

- **Hosting (decided)**: **Vercel Pro** (Next.js) + **Supabase Pro** (Postgres, Auth, Storage, Realtime, daily backups). ≈ $45/month flat regardless of client count, zero servers to maintain. Supabase free tier is not acceptable for client data (pauses, no backups). Vercel Hobby is not licensed for commercial use.
- **Frontend/backend**: Next.js (App Router, TypeScript). UI stack per §8.1. Zustand for client state, TanStack Query for server state.
- **Database/auth/storage**: Supabase (Postgres with RLS, Auth with magic link + Google, Storage for attachments, sources, traces and exports, Realtime for presence and live refresh).
- **Engine**: `packages/engine` shared TypeScript package. Browser: Web Worker (and worker pool for robustness). Server: imported directly in route handlers.
- **MCP**: `/api/mcp` route using the official MCP TypeScript SDK (Streamable HTTP transport). Bearer token hashed in `api_tokens`. Executes as the token's user under RLS; never uses the service-role key.
- **LLM calls**: Anthropic API from server routes only, on demand, cached. Never from the client.
- **PDF**: Vercel function with `@sparticuz/chromium`; browser print fallback.
- **Tenancy**: every table has `workspace_id`; RLS policies check `memberships` (`agency_admin` bypasses via a claim). Share links use a Postgres function that returns the redacted snapshot for the token.
- **Environments**: local (Supabase CLI), preview (Vercel preview + Supabase branch), production.
- **Portability**: a Dockerfile is kept as an escape hatch (VPS/Coolify) but is not the deploy path.
- **Observability**: Sentry for errors, `audit_log` for changes, Vercel analytics.

---

## 11. Build plan (milestones)

Each milestone ends with something usable on its own. There is no fixed date; Milestone A is the target. Realistic total for full v1: **6–10 weeks** of focused build (v0.2's 20–25 days was optimistic).

**Milestone A — Audit-ready** (the whole in-meeting story: transcript → map → bottleneck → quantified, robust fix → report)
- Monorepo: `apps/web`, `packages/engine`, `packages/db` (migrations, types), `packages/mcp`.
- Engine: port and fix the prototype (§6.8); named people, capacity factor (off by default), warm-up and current WIP, overtime and floor, client servicing with health-driven churn, revenue rules, condition-tag routing, seasonality, leave, distributions, detected issues, shadow price, ranges. Verification suite (§6.9) in CI. Web Worker wrapper with cancellation.
- Supabase schema (§5) and RLS for the tables A needs; single-workspace auth (agency admin + owner); seed script for the Northbeam workspace and the second golden agency.
- Company settings: basics, services (with servicing), people, clients roster, demand.
- Process canvas with drafts and diff, step inspector, routing, swimlanes, stable IDs, per-field saves with presence.
- Run pipeline, KPI strip with ranges, utilisation bars, animation overlay.
- Levers; scenarios with ops and needs-attention; compare view with templated narrative; robustness check with worker pool and cache.
- Issues register with detected issues and promotion.
- Sources and evidence; MCP server (§7.1) including `add_source`, `import_process` with target, suggestions; extraction prompt.
- PDF report with validated narration.

**Milestone B — Client-ready**
- All roles and visibility rules (§2); workspace switcher; memberships.
- People page; Clients page; Suggestions page.
- Share links with toggles, email restriction, redacted snapshots; Proposals queue.
- Client branding.
- Forecast view: monthly forward run, timeline chart with draggable markers, crunch alerts, forecast comparison.
- Issues kanban and filters; PNG/SVG/CSV/JSON bundle export and import.

**Milestone C — Data-ready and polish**
- CSV import wizard with column mapping; calibration job; proposed-vs-current diff; provenance.
- Version history per process with restore.
- Storybook and Playwright visual regression.
- Dark mode parity, mobile read-only view, onboarding wizard, empty states, Sentry, backups verification.

---

## 12. Assumptions and open questions

- Dispatch rule in v1 is FIFO across eligible people, with client-assigned people taking their clients' servicing tasks; priorities and skill-preference rules are v2.
- Health/churn defaults (§6.3.5) are estimates and are flagged as such everywhere; calibration from CRM data (v2 connectors) should replace them.
- Capacity factor defaults to 1.0 and is disabled per workspace by default; displayed only once measured or explicitly entered.
- Currency and hours are per workspace; no multi-currency.
- Decided: play links can submit scenarios for acceptance (Proposals queue). Submissions are rate-limited per link and never auto-apply.
- Decided: client branding is v1.
- Open: exact tolerance bands for the queueing-theory tests (set during Milestone A).
- Open: warm-up heuristic may need tuning against the golden models.

---

## 13. Appendix: metric definitions

- **Utilisation (person)** = (pipeline hands-on hours + servicing hours + fallback ongoing hours) / (capacity hours × measured weeks), averaged over replications. Can exceed 100% when overloaded; overtime hours are reported separately.
- **85% ceiling**: above this, queue length grows non-linearly in a stochastic system; the default bottleneck threshold, configurable per workspace.
- **Cycle time**: arrival at process entry to reaching an end step, in working hours, reported in working days (÷ hours per day). Mean, P50, P90.
- **Range**: 10th–90th percentile across replications.
- **Cost per unit** = Σ (pipeline hours per person × cost rate) / completed units.
- **Overtime cost** = overtime hours × cost rate.
- **Hours freed** = Σ over people of (baseline total hours/week − scenario total hours/week).
- **Shadow price of the bottleneck** = additional completed units per quarter from adding one FTE to the bottleneck role, computed by an automatic extra run.
- **New MRR** = Σ over entities reaching their first `won` end step of that entity's service price (retainers only).
- **Revenue billed in horizon** = Σ over clients of weeks active within the horizon × weekly price, net of churn.
- **LTV added** = Σ over new wins of price × expected tenure (retainers) or price (one-off).
- **Lost revenue** = lost entities × expected value (price × expected tenure for retainers).
- **Client health** = 0–100 score; +recover on on-time touchpoints, −late_penalty on late, −missed_penalty on missed (§6.3.5).
- **Client at risk** = health < 50.
- **Robustness** = share of perturbed runs in which the conclusion (bottleneck identity, or sign of a scenario's headline delta) holds.

---

## 14. Decision log (grill session 29 Sep 2026; redesign 30 Sep to 1 Oct 2026)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Who pays for the living workspace? | Included in Austin's service retainer; not sold separately. Minimise opex. | Every dollar of running cost is margin. |
| D2 | Hosting | Vercel Pro + Supabase Pro, ≈ $45/mo flat. Narration on demand and cached. | Easiest to deploy and maintain (no servers); VPS saves ~$10/mo but adds on-call. Supabase free tier unfit for client data. |
| D3 | Scope cuts | None. Full v1 scope kept; realistic 6–10 weeks. | Owner decision. |
| D4 | Build order | Milestones A (audit-ready) → B (client-ready) → C (data-ready). MCP and PDF move up; calibration last. No fixed date. | Avoid being 70% done on everything at the first client meeting. |
| D5 | Presenting estimated numbers | Average + 10–90% range as the headline, plus an on-demand robustness check naming the most sensitive inputs. | "Trust my model" fails with a sceptical founder; "even if we're 25% off, the answer holds" survives. |
| D6 | Initial state | Current WIP per step when entered; otherwise automatic warm-up, discarded. | An empty start understates utilisation and cycle time, and forecasts must start from reality. |
| D7 | Ongoing load exceeds capacity | Overtime up to a per-workspace cap (default 0), reported as cost and a finding; then clamp to a floor, show >100% and raise a critical issue. Never block a run. | Overloaded businesses are exactly the audit target; hidden overtime is a strong finding. |
| D8 | Revenue | End steps have outcomes; revenue booked once per entity at first `won`, priced by service; new MRR, billed-in-horizon, LTV and lost revenue reported. | Removes double-counting across chained processes and lost-as-completed. |
| D9 | Retention | Client servicing simulated as real recurring work with SLAs; client health drops on late/missed touchpoints and drives churn. Moved from v2 into v1. | The core audit story ("you're dropping the ball and it's costing retention") needs a mechanism; fixed churn can't show it. |
| D10 | Scenarios vs model changes | Patch ops (`set`/`multiply`/`add`); relative for process params, absolute for facts; stable step IDs with `replaced_by`; broken scenarios flagged loudly, never silently dropped. | Prevents fixes silently becoming worth £0 or drifting as the model is re-measured. |
| D11 | Robustness compute | On demand (button, and on PDF), browser worker pool, two-stage screen/refine, common random numbers, cached. 10–30 s acceptable. | Thousands of runs per check; keeps levers instant and server cost at zero. |
| D12 | Share-link leakage | Server builds redacted snapshots; independent People/Financials/Clients toggles, default off; any toggle on requires allowed emails + expiry. MCP acts as the user under RLS, never with the service-role key. | Client-side engine means anything sent is visible; links get forwarded. Toggles allow sharing with authorised people. |
| D13 | Clients (**amended by D27**: named clients are now hidden, replaced by client groups) | Named client roster (`clients`), real clients seed the run, synthetic new wins, `upsert_client` MCP tool. | Findings need to name names ("Acme is at risk"); also the target for v2 CRM sync. |
| D14 | Concurrent editing | Per-field saves with version check, keep-mine/keep-theirs on same-field conflict, presence and live refresh via Supabase Realtime. | Avoids silent overwrites without a CRDT project or frustrating locks. |
| D15 | Narration trust | Templates for banners/headlines; LLM only for PDF summary and "explain"; every number validated against run JSON, retry once, then fall back to template; cached; editable with provenance. | One invented number in a report undermines "the engine produces all numbers". |
| D16 | Engine verification | Queueing-theory checks, behaviour checks, golden models in CI; port-and-fix six prototype issues; re-baseline Northbeam. | Matching the prototype proves copying, not correctness. |
| D17 | Conflicting sources | Sources stored; every inferred number cites evidence; disagreements become triangular ranges flagged as conflicts, fed to robustness, and logged as perception-gap issues. | The disagreement is itself a finding, and averaging hides it. |
| D18 | Draft mode (**amended by D25**: drafts stay single; solutions are separate copies) | Every process has a live version and at most one draft; all edits (canvas, MCP, import) go to the draft; draft vs live is runnable; Publish gates on resolved assumptions. | Nothing reaches production without review; the client's numbers don't move mid-week unexplained. |
| D19 | Company-model edits | Human edits apply live (facts); MCP edits become suggestions for review; all audit-logged; runs show "model changed since this run". | AI never changes production without review, without making people draft a leave date. |
| D20 | Per-person data | Capacity, not performance: individual availability/skills/assignments; capacity factor off by default, shown only when measured, visible to the person, never ranked; no role-median benchmark. DPA clause in the retainer. | Raw speed comparisons mislead (task mix), carry GDPR duties, and make staff guarded in interviews. |

### Redesign decisions (30 Sep to 1 Oct 2026)

Source: Austin's Milestone A QA notes (30 Sep), the prototype, `docs/plans/redesign-plan.md`, `docs/analysis-rules.md` and `docs/research/first-principles.md`. The QA found the old screens confusing: jargon, severities nobody could compare, and findings that landed on the map before anyone agreed with them.

| # | Question | Decision | Why |
|---|---|---|---|
| D21 | Where does the redesign go? | In Milestone A, as tickets A31 to A58 (#96 to #123). B and C start after it, on rewritten tickets. | Audits need the new screens. The old ones are what Austin found confusing. |
| D22 | What is removed? | Reports (pages, PDF route, print stylesheet, `export_report` tool, nav item), the Clients page, the Scenarios page, the Runs page, and the Track and Run fix buttons. "Explain this run" stays. The `reports` tables stay, unused. Ticket A32. | Each is replaced: Clients by client groups and People, Scenarios by solutions, Runs by History, Track by Acknowledge, Run fix by Build solution. Reports have no replacement in Milestone A. |
| D23 | How are findings rated? | One four-level rating: Great, Good could improve, Bad not urgent, Operational risk. It replaces critical, serious, warning and info. Each rule has three cut-offs. The band comes from the average over 30 runs. A bad month (P90 over the next cut-off) or being on the bottleneck each raise it one level, to at most Operational risk. | Four plain levels can be compared across rules. Averages alone hid bad months and the bottleneck. Today's engine missed an 82% busy strategist. |
| D24 | How do issues come about? | The rules and AI write **insights**. Nothing reaches the map until someone acknowledges it. An **issue** comes only from an acknowledged insight or is logged by hand. Red map badges show confirmed issues only. | The map should show what the team agreed on, not everything the engine noticed. Replaces auto-detected issues and Track. |
| D25 | What is a solution? (**amends D18**) | A solution is a separate copy of a process with changed steps, plus optional lever changes. A process can have many. One solution can solve several issues, with an automatic verdict against each issue's target and the user's own verdict. **Drafts stay single:** a process still has one live version and at most one draft. | Testing a fix needs a copy that lives beside the live process. Scenario patches could not change steps. |
| D26 | Can processes hold processes? | Yes. A step can hold its own steps, as a group or a child process. The company map is the root. The engine always simulates the detailed steps. | Collapsing for readability must not change the numbers. Replaces B8. |
| D27 | What happens to named clients? (**amends D13**) | Named clients are hidden, with the data kept. Clients are modelled as **client groups** per service: number, fee, normal churn, typical stay, starting health. The engine simulates unnamed clients from these. | Named rosters are slow to enter and not needed to show the cause of churn. Keeping the data allows a way back. |
| D28 | Why do clients leave? | **Churn drivers**: ten, each with a weight and an on/off switch, plus your own. The engine measures the drivers it can and reports each one's share of churn. They feed the client-health and churn-driver rules. | Late work is one cause among several. Showing shares says where to act. |
| D29 | How does the market affect results? | **Market conditions**: presets (Boom, Stable, Soft, Downturn) and custom ones, with seven factors and a 24-month schedule applied month by month. They feed the stress test on solution pages. | A fix that works only in a boom is not a fix. |
| D30 | How do we capture the purpose of a process? | **First principles** per process: seven steps (the job, hard truths versus assumptions, requirements with named owners, delete, simplify then speed up then automate, root cause, goals). AI checks sit beside each step. Goals become success measures, rated by rule 11. | Stops us automating a step that should be deleted. Research in `docs/research/first-principles.md`. |
| D31 | How is money shown? | Every insight shows an estimated cost per month, sorted high to low within each rating. A loss is worth the revenue still to come when it is lost, capped at 12 months. Before signing it is chance-weighted. After signing it is the fee times remaining tenure. The default currency for new workspaces is **AUD**. | One comparable number per insight. The cap keeps one lost client from dominating. |
| D32 | How do we find single points of failure? | The **absence test**: an extra run with the person away for two weeks, rated on work lost and weeks to catch up. It replaces flagging every one-person step. | A one-person step nobody needs covered is not a risk. Measure the damage instead. |
| D33 | What does the UI look like? | Austin's shadcn preset (`shadcn init --preset b1s91W1fU`, style radix-nova: Inter, teal-blue brand, neutral greys), applied in commit 6149a6a. "Good, could improve" is lime green so it does not clash with the brand colour. Amends §8.1. | One consistent kit, chosen by the owner. |
| D34 | How do we word the screens? | Plain words, as in the prototype. Every setting, lever and rule has an (i) help with a plain description and an example. | Austin's QA: anyone should understand a screen without a glossary. |
| D35 | Can rules be changed? (**replaced by D40**: the rules editor is removed; every workspace uses the documented defaults) | Yes. Settings, Analysis rules: switch each rule on or off, edit cut-offs with a live preview, add overrides per role, person, step, service or process, and reset. Stored per workspace. Changing a rule re-rates the last run without simulating again. | Agencies differ. Re-rating must be instant. |
| D36 | What does AI do in analysis? (**replaced by D40**: AI writes findings on demand, which people accept) | It reads rule results, first principles and linked sources, then writes insights marked AI and an "AI read" summary. Every number it uses comes from the run and is validated as narration is (D15). AI insights go through the same Acknowledge step. | Keeps D15: the engine produces the numbers. |
| D37 | What happens to the Milestone B and C plans? | B7 keeps the drag-and-drop timeline. B9's kanban is dropped, with issues CSV moving to B10. B8 and C3 close (done in A37 and A40). B2 becomes the People page. B4's proposals arrive in Suggestions. | Matches the redesign. The owner did not object to dropping the kanban. |
| D38 | What happens to a resolved issue the analysis still detects? (**refines D24**) | It stays resolved: off the map and out of the open list, whatever way it was resolved or whether a way was recorded. If the rules find the problem again, it shows as an **insight** that links to the resolved issue, and a person can reopen that issue by hand. | A re-detection should not silently revive an issue someone closed (D24: nothing reaches the map until acknowledged). A person decides. |
| D39 | Where does the company map live? (**refines D26**) | It is a stored, versioned process, one per workspace (`processes.is_company`). Its steps are holders of the top-level processes at stored positions; the lines between them are **handoffs**, visual only for now (the simulation ignores them). A placed process is held by a link in the map's revision and is never edited by being placed: top-level processes keep no parent. The engine never simulates the company process. | It makes "the company map is the root process" literally true, so it can be edited, versioned and restored like any process, without moving a single simulated number. See docs/adr/0014. Slice 1 (B11 1/2, #163) stores and draws it; slice 2 (B11 2/2) lets editors edit it: a draft, the diff against live, publish, version history and restore, with handoff lines drawn and labelled between cards. Placing a process is a link and never edits it; a process appears at most once in the published tree; adding and removing processes is the process library on the map's editor (B12, #164): placing puts a linked card in the map's draft and never edits or copies the process; removing a card only unlinks it, in a draft. When a process is created, renamed, nested, un-nested, re-kinded or deleted, the map records it as a version of its own made by the system (ADR 0014). B12 part 2 puts the library in every editor: any process may hold others by a link; the company map is the default home and gives way (publishing a link to a process on it takes its card off; it comes back when nothing holds it); publishing refuses a process inside another ordinary process (naming where) and a loop; "inside" is read from the live links, not `parent_process_id` (ADR 0014). |
| D40 | How does analysis work? (**replaces D35 and D36**) | **Hybrid: facts, then AI, then people.** The engine measures **facts** (how busy each role and person is, queues and waits, rework loops, missed deadlines, key-person risk, client health, goals met) and every page shows them as **evidence**, never as findings. **AI** reads the facts, the first principles, the sources and the model and writes **findings**, each citing the facts it rests on; it runs only when someone presses **Analyse** (per process, and once for the whole company), and what it wrote is kept until the model changes, then marked **out of date**, with the model and the cost shown under it. AI findings arrive **proposed**: someone accepts (after editing, if they like) or dismisses each one. People add **findings by hand** in the same shape. Only accepted findings show on the Overview and the process pages, and from there one is acknowledged as an issue as before (D24, D38). The **rules editor is removed**: rule cut-offs no longer create findings, only pick which facts stand out, and every workspace uses the documented defaults (docs/analysis-rules.md); what was saved is kept, unread. D15 stands: every number in an AI finding is checked against the run. | Austin's QA (5 Oct 2026, #175): rule-made findings felt hard-coded and predictive, not an assessment of what is wrong, and he wants to add his own. Facts stay objective; judgement is AI's or a person's, and always reviewed. A setting nobody can reach must not change results, so the rules' settings are fixed to the defaults rather than left half-live. See docs/adr/0015-analysis-findings.md. |
| D41 | What counts as a rework loop? | Any routing back to a step already passed, and any same-step redo, is treated as rework. Loops are found on the flattened model (groups and child processes dissolved), identified by their back-edge, and each repeat pass is counted once, in the innermost loop it is on. A future "not rework" flag on an edge could exclude deliberate cycles (a follow-up loop, say); until then none is excluded. | Keeps the numbers simple and additive (issue #174): the loops add up to one total the Overview can show as a slice, and nothing about drawing order changes them. |
| D42 | How do named clients and client groups fit together? (**refines D27**) | Clients can be entered one by one by hand (Settings, Clients: name, active or inactive, MRR, start date, services, and who looks after them in each role), as well as counted per service in client groups. Each process's simulation uses **one or the other, never both**, decided per process: when a client group counts clients for one of the process's services (an active service open to every process or entered through this one), only that process's groups are simulated and the named clients don't change its numbers; otherwise the active named clients who have started by the run's start date are simulated, with their assignments carrying their work. The Clients section says which processes use which. **A client is never deleted** (the database refuses it for anyone signed in): one who leaves is made inactive, which hides them and leaves them out of simulations, exactly as if they weren't there. | Austin, 5 Oct 2026: everything can be added by hand (#182). Counting both would double the clients; one switch keeps every result explainable. Keeping inactive clients keeps the history and the way back to a named roster (D27). |
| D43 | How is a process taken out of use, and how are source files kept? | **Archive, never delete.** An editor archives a process from Processes: it leaves the company map (a system version), the lists and the simulation, and keeps its versions, history, issues and sources; Processes, Archived restores it. A process inside another ordinary process, holding others, or still used by a service (its way in, or client work it generates) can't be archived until that is undone (the message names them; ADR 0014). While archived it is read only (no draft, publish or restored version) and its name is free; restoring checks the name again. The kind (sales pipeline or client work) is chosen when a process is made and can be changed, after a warning saying what changes in the simulation. **Source files:** a .txt, .md, .csv, .xlsx or .pdf of up to 10 MB is kept as a source's original in a private Supabase Storage bucket, in the source's own folder of its workspace (editors upload; until the server has checked it only the uploader can read it; once the source keeps it every member can download it; nobody else sees it); the server checks its name and content, never the browser's type, reads its text with pure-JavaScript libraries within limits on size, pages and time, and stores it as the source's full text. Files only ever download; they are never shown as a page. | Austin, 5 Oct 2026: everything can be added by hand (#182). Deleting a process would lose its history and the evidence behind past decisions; refusing a nested archive keeps the published tree whole without editing anyone's map. Keeping the original next to its text means a quote can always be checked against the file it came from. |
| D44 | How does a solution go live from a month in a forecast, and who sees plans? | **Spliced runs, not an engine switch.** The engine can't change a process's steps in the middle of a run, so a plan with solutions is run once per go-live month (the model with the solutions live by then, all from month 0, same seed) and the monthly numbers are spliced: busy shares, waits and late tasks switch at the month; clients, recurring revenue and clients at risk carry on from where they were (offset at the month before) and change only as the later run changes. A solution's lever changes are not applied (as on the Solution page). Hires and leave are extra people and leave rows in the bundle before the model is built, as a planned hire from Settings is. **Plans are for owners, editors and agency admins only** (a hypothetical leave names a person, which members and viewers don't see); a plan stores markers with absolute dates, never numbers; the demo keeps plans in the tab. Limits: 50 plans a workspace, 40 markers, 4 solutions, names up to 120 characters, unique ignoring case. The engine reports month-by-month recurring revenue and clients at risk as additive outputs (no number moves, no version bump). | Austin, 29 Sep 2026 (#36): plan with the forecast, drag markers, compare two plans. Splicing two runs that share a seed is honest, cheap and testable; switching graphs mid-run would be a large engine change for the same answer. |
