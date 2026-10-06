---
name: extract-process
description: Turn audit interview transcripts into a Transpera Flow draft process, with cited evidence, reasoned assumptions, conflicts, nested steps, first principles and company-model suggestions, through the Transpera Flow MCP server.
disable-model-invocation: true
---

# Extract a process from interview transcripts

The goal is a **draft** the consultant (Austin) can correct and publish in under an hour. Every number in it is **cited** (a verbatim quote from a source) or **assumed** (with your reasoning). Company facts go in as **suggestions**. Your work ends at a draft and pending suggestions: the consultant publishes from the canvas, so `publish_process`, `discard_draft` and `log_issue` stay untouched.

Leading words, used throughout: **cited**, **assumed**, **ledger** (one line per number heard), **conflict** (speakers disagree), **suggestion**, **draft**, **open question** (something the consultant must ask or decide), **group** (a box of steps inside one process), **child process** (a sub-process with its own map), **first principles** (the seven short answers about why the process exists).

## Steps

1. **Orient.**
   - Call `list_workspaces`, then `set_active_workspace {workspace}`. If more than one workspace fits, ask.
   - Call `get_workspace_summary`. Note the hours per working day (`workspace.settings.hours_per_week / 5`), the role names, the people and the processes.
   - Decide new process or `target`: does an existing process describe the same work? If unsure, ask.
   - For a target, call `get_process {process, revision}` with `"draft"` if it has a draft revision, otherwise `"live"`. Keep its step names and ids.
   - Call `list_suggestions {status: "pending"}`.
   - Done when you know the workspace, the hours per day, the roles you may use, new versus target, and the pending suggestions.
2. **Add sources.**
   - One `add_source` per transcript: `{title: "<Company> interview: <Name>, <role> (<date>)", kind: "transcript", speakers: [every speaker label exactly as written, interviewer included], recorded_at: "YYYY-MM-DD", body: <the full unedited text>}`.
   - Pass `link_later: true`: a source must be linked to something it is evidence for, and the process it describes doesn't exist yet. You link it in step 4, right after `import_process` (if the transcript is evidence for a process, issue or solution that already exists, pass `links` here instead, for example `links: [{process: "Lead to live"}]`).
   - Keep `data.source.id`. Add each transcript once per conversation and reuse ids you already hold.
   - Done when every transcript has an id.
3. **Build the ledger.** No tool calls in this step.
   - Read every transcript end to end.
   - Write one ledger line for every number or quantity said, vague ones included: speaker, timestamp, quote, the number in field units, destination.
   - Destinations: step field (cited), routing probability, suggestion, timing note, open question, first principles (a truth, requirement, change or measure a speaker stated), or not modelled (with the reason).
   - Then draft the step list from "Mapping statements to fields", deciding for each step whether to nest it (see "Nesting").
   - Done when every number in every transcript has a ledger line.
4. **Import.**
   - Call `import_process` once per interview.
   - New process: `{process_json: {name, kind, entity_name, description, steps, edges}}`.
   - Second interview: `{target: <process id>, process_json: {steps, edges}}` (see "Second interview").
   - `ok: false` means nothing was written: fix the input (`error.candidates` lists the options for an ambiguous name) and send again.
   - `ok: true` is final: a re-sent import appends the same citations a second time, so corrections go through `update_step`.
   - Then link every transcript you added to the process: `link_source {source: <data.source.id>, links: [{process: <the process's name, or its id for a target>}]}`, once per transcript, whether the import cited it or only your first-principles notes and suggestions will. It is safe to repeat. A source left with no link shows as "Not linked to anything yet" and doesn't count as evidence.
   - A child process written in the same import is a separate process: link each transcript to it too when the child's steps cite it.
   - Done when `ok: true`.
5. **Check the draft.**
   - Read `warnings`, `checklist`, `conflicts`, `not_overwritten` and the response's `assumptions`, then the same fields of every entry in `children[]` (each child process written in the call has its own, with the step that holds it in `step`). Fix a child's problems with the step tools, naming the child process.
   - Fix branch sums or "Nothing leaves this step yet" with `set_routing {step, routes: [{to, probability}]}` (routes sum to 1) or `connect_steps`.
   - For any checklist assumption with no evidence whose `reasoning` starts "Server default for a" or "Given without a cited source", call `update_step {process, step, <field>: <the value you mean>, assumptions: [{field, reasoning}]}`. Reasoning alone keeps the default number.
   - Optional: when an interviewee stated an end-to-end time, call `run_scenario {process, revision: "draft"}` and put `kpi.cycle.mean` (working hours) beside the stated time in the timing notes. A servicing process alone returns `invalid_model` (it runs beside a pipeline): note that and move on.
   - Done when `warnings` is empty and every assumption carries your reasoning.
6. **Fill in first principles** (see "First principles"). Call `get_first_principles {process}`, then `update_first_principles` with only the sections a transcript supports. Done when every ledger line marked first principles is stored or an open question explains why not, and the response's `warnings` and `flags` are in the summary.
7. **Submit suggestions** (see "Suggestions"). Done when every ledger line marked suggestion has a stored suggestion or an open question that explains why not. Problems and ideas go through "Proposals".
8. **Report** (see "Summary"). Done when the summary has every section, the empty ones included.

Once the process is published and the facts are in (`get_facts`), you may propose findings for the team to review with `propose_finding`, citing the fact keys and the sources' quotes; a person accepts them in the app.

## Mapping statements to fields

| Heard | Field |
|---|---|
| A piece of work someone does | a `task` step with `role`: an existing role name, matched by meaning ("AM" is "Account manager"); if none fits, `null`, an `upsert_role` suggestion for the role (see "Suggestions"), and an open question to set the step's role once it is accepted |
| "Only X does it" | `person` |
| Software named | `tool` |
| Hands-on time per item | `work_hours` |
| Waiting on the client, an outside party or the calendar | `wait_hours` on the step before the wait, or a `wait` step if it stands alone |
| "Sits in X's inbox because they're busy" | queueing, which the engine simulates: a timing note, never `wait_hours` |
| "Comes back for changes N%" | `rework_rate` (0 to 1) plus `rework_to` (a step name; `null` repeats the step) |
| "I've got N on my desk now" | `current_wip` (integer) |
| A promise for this step | `sla_hours` (time at the step: queue plus work plus wait) |
| A choice point | a `decision` step plus edges with `probability` |
| The end | `end` steps with `outcome`: `won` or `lost` for a pipeline, `done` for servicing |

Structure:
- Exactly one `start` step per process (a child process has its own).
- `kind` is `pipeline` when items arrive from demand and end won or lost, `servicing` for recurring client work. `entity_name` is what flows (lead, report).
- Leave out `x` and `y`: the server lays steps out.
- Step names are short verb phrases, unique within the process.
- Every non-end step has outgoing edges that sum to 1.
- A step can only name a role that exists. A missing role becomes an `upsert_role` suggestion, and the step's `role` stays `null` until someone accepts it. A role, person or client that is only a pending suggestion cannot be referenced yet.

Limits: `steps` 200, `edges` 500, per step `evidence` 50, `assumptions` 10 (`{field, reasoning}`, reasoning 1 to 2000 characters), `notes` 4000, `tool` 200, name 1 to 200.

## Nesting: groups and child processes

A step can hold other steps. The engine simulates only the detailed steps inside, so nesting changes how the map is drawn and read, never the numbers. Nest only what an interviewee actually described.

When to nest:
- **Group** (`steps` inside a step): one step the interviewee breaks into two or more parts in order, each with its own hands-on time, person or tool, and the parts exist only inside this process ("Onboarding is really three things: set up the account, run the kickoff, send the welcome pack").
- **Child process** (`process`, or `child_process` for one that already exists): the sub-procedure is a piece of work of its own: a different team or trigger, its own entity, described at a length that could stand alone, or already a process in the workspace (check `get_workspace_summary`). It gets its own page, versions and first principles. Pick the group when unsure.

When not to nest:
- A list of small actions with one time for the lot ("export to PDF, email it, a quick note: a quarter of an hour"; "check errors, broken links and page speed"): one step, the list in its `notes`. Splitting would mean inventing a time for each part.
- A rework loop, a branch or a choice: use `rework_rate`, a `decision` step and edges.
- A hand-off to another person for the next piece of work: that is the next step, not a sub-step.
- A detail given only in passing, with no numbers or people: `notes`.

How (the real shapes, written in the `process_json` of `import_process`):
- Group: give the step `steps: [...]`. The group takes no `role`, hours, rework, `sla_hours`, `current_wip` or evidence of its own: every number, citation and reasoning goes on the steps inside. `entry` names its first step (default: the first listed). Groups can hold groups. The flat form is equivalent: list the inner steps beside it with `parent: "<group name>"`, and give the group step `kind: "group"` (a step holding a child process takes `kind: "subprocess"`); without the kind the group would be an ordinary task.
- Child process: give the step `process: {name?, kind?, entity_name?, steps, edges}` (a new process, created in the same call; its name defaults to the step's name), or `child_process: "<existing process id or name>"` (adopted as the child; it must not already sit inside another process, and a process cannot hold itself or an ancestor). The step is then a `subprocess` step with no numbers of its own; the child's steps carry them, with the child's own `start` and `end`.
- Edges: the parent's `edges` name the group or sub-process step itself on the way in and out (`Qualify to Discovery`). Edges between the steps inside a group go in the same `edges` list, by name. A child process's edges go in its own `process.edges`. Step names stay unique across the whole JSON.
- Evidence, assumptions, ranges and conflicts work on inner steps exactly as on top-level ones: every number inside still needs a citation or a reasoned value. One import is still one interview, children included.
- A second interview adds to an existing group or child by listing the group (or the sub-process step with `process: {steps: [...]}`) and only the inner steps it says something about, by their existing names. Read the child first with `get_process {process: <child name or id>, revision}` for its exact step names; the parent's `get_process` lists the sub-process step but not the child's steps.
- Report each child process in the summary: it has its own canvas path, checklist and draft, and the consultant publishes it too.

## First principles

Each process has seven short answers about why it exists: the job, hard truths against assumptions, requirements with a named owner, steps that might be deleted, what to simplify then accelerate then automate, the root cause, and success measures. You fill in only what the transcripts support. `update_first_principles` writes to the process's draft (opening one if needed), never to live. `get_first_principles` reads what is there: call it first, and again on a second interview so you add to it.

The tool has no evidence field, so cite inside the text, the way process numbers are cited:
- A quote goes in as `"<verbatim quote>" [<source title> | <speaker> | <hh:mm:ss>]`, with the title exactly as given to `add_source` (it tells two interviews apart, even on the same day). The quote rules from "Cited numbers" apply: shortest verbatim span, one contiguous stretch, the speaker's label exactly as written.
- Anything no speaker said is an assumption: begin it with `Assumed:` and give the reasoning, as for a step assumption. Never present your own reading as a quote, never put double quotes around words that are not a cited quote (paraphrase with single quotes or none), and never leave an item with neither a quote nor `Assumed:`.

Sections (arguments of `update_first_principles`, all optional; `mode` is `merge` by default, which adds and updates but removes nothing):
- `job {who, progress, situation, done}`: who the process serves, the progress they want, the situation they come in with, what done looks like. Leave out what nobody described.
- `statements [{text, kind, source, test}]`: `kind: "truth"` only for something that cannot be argued away (law, contract, a hard capacity), with the quote naming where it comes from in `source` (a truth with no source is shown as an assumption). A belief or habit is `kind: "assumption"`: `source` holds the quote that voiced it, or `Assumed: <reasoning>`, and `test` is one way to prove it wrong.
- `requirements [{text, owner, why, verdict, step}]`: a rule the process follows. `owner` is a person's name from People, never a team (a team is flagged). If nobody said who set the rule, name the person who enforces it and say so after `Assumed:` in `why`. `why` carries the quote or `Assumed:`. `verdict` is `keep`, `change`, `drop` or `challenge` (default challenge): choose another only if a speaker said so. `step` is the step the rule creates. A name that matches nobody in People is stored as typed text with no warning, so read `first_principles.requirements[].owner_person_id` in the response: when it is `null`, fix the name (or suggest the person) and send the requirement again.
- `deletes [{step, breaks_if_removed, agreed_by}]`: only when a speaker says a step may not be needed. Otherwise leave it empty, invent no candidates, and mention the empty list in the summary (the app flags it).
- `improvements [{stage, text, step}]`: `simplify`, `accelerate` or `automate`, for a change a speaker wished for or described, preferring them in that order. Never accelerate or automate a delete candidate.
- `why {problem, chain, root}`: the biggest problem a speaker names and each answer to "why?"; `root` is something in the process, not a person. Fill it only when the chain was spoken; otherwise an open question.
- `measures [{text, kpi, comparator, target, horizon}]`: a target someone stated becomes a measure; make up no target. These rules decide the stored values:
  - `kpi` is the engine number the target is about: `cycleHours` (average time to complete), `winRate`, `winsPerWeek`, `won`, `newMrr`, `billed`, `labour` or `wipEnd`. If none fits, leave `kpi` and `target` out (it shows as "not checked by simulation") and keep the sentence in `text`.
  - `target` is in that KPI's unit, as a person reads it: working hours for `cycleHours` (convert days with the workspace's `hours_per_week / 5`, so five working days at 8 h is 40), a percentage for `winRate` (30 means 30%), a currency amount for `newMrr`, `billed` and `labour`, a count for `won`, `winsPerWeek` and `wipEnd`.
  - `comparator` defaults to `atLeast`, which is wrong for a limit. Words like "within", "under", "no more than", "at most" need `comparator: "atMost"`; "at least", "over" need `atLeast`. Always send it.
  - Example: Hana says "Report within five working days of month end", the week is 40 hours: `{"text": "...", "kpi": "cycleHours", "comparator": "atMost", "target": 40}`. Without `atMost` the stored measure would read "at least 40 working hours".

After the call, read `warnings` (a step or person name that did not match: fix the name and send again) and `flags` (an owner that is a team, a root cause that stops at a person, an empty delete list, a measure the simulation cannot compute). Fix a flag by re-sending the item, or list it as an open question.

## Proposals: issues and solution ideas

Issues and solution ideas you find are suggestions for a person to accept on the Suggestions page, never written directly.
- `propose_issue {title, detail?, rating?, type?, process?, steps?, evidence?, note?}`: a problem a speaker names that touches a step or the process (the tracker export that times out and redoes a client). `detail` says what was said and where, `evidence` uses the suggestion shape (see "Suggestions"), `note` gives your reading, `rating` is `great`, `good`, `bad` or `risk`.
- `propose_solution_idea {issue, title, steps, evidence?, note?}`: only for an issue that already exists and is open or being tested (a number from `list_issues`), with the steps you would place, in order. A change a speaker wished for with no issue behind it goes into first principles `improvements`; if the pain is worth tracking, propose the issue and keep the idea as an open question until it exists.
- Never `log_issue`, and never write an issue or a solution directly. Perception-gap issues are not yours to raise: the app logs one itself when two speakers' numbers for a field are a factor of two or more apart (see "Disagreements and conflicts").
- If a call answers `switched_off`, an owner has turned that AI switch off (Settings, AI analysis): list the item as an open question and carry on.

## Units

- Everything is hours per item.
- A working day is `hours_per_week / 5` and a week is `hours_per_week`, both from the workspace settings; the engine counts five working days. Use the workspace's figure and never assume 8.
- Minutes divide by 60. "One in five" is 0.2.
- Round to at most 2 decimals.
- A citation's `value` is in the field's units even though the `quote` keeps the speaker's words.

## Cited numbers

Give the field value and a citation `{field, source, speaker, quote, timestamp, value}` inside the step's `evidence`. `field` is one of `work_hours`, `wait_hours`, `rework_rate`, `current_wip`, `sla_hours`; `source` is the source id or its title.

- The quote is the shortest verbatim span that states the number, copied character for character from one contiguous stretch of the transcript, so no ellipses and no stitched lines.
- The timestamp is the transcript's `[hh:mm:ss]` time without the brackets.
- The speaker is the label exactly as it appears in the transcript.
- When the interviewer proposes a number and the interviewee agrees, quote the exchange verbatim with the interviewee as speaker.
- When a speaker corrects themselves, cite only the correction and say so in the step's `notes`.
- Hedges:
  - Symmetric ("two, three hours", "a day or two"): `work_dist: "triangular"` with `work_params {min, mode, max}` (for a wait, `wait_dist` and `wait_params`) where `mode` is the midpoint, and cite `value` equal to that midpoint. The mean equals the midpoint, so the range survives and can still conflict with another speaker. A cited `value` that differs from the current mean turns a range back into a plain value.
  - Typical plus tail ("usually an hour, sometimes a half-day"): the field and `value` are the typical figure; the tail goes in `notes`.
  - A hedge on `rework_rate` or `current_wip`: the midpoint is the value (rounded to a whole number for `current_wip`), the hedge goes in `notes`.

## Assumed numbers

- Every value no source states is given explicitly, with a step-level `assumptions: [{field, reasoning}]` entry. The reasoning says why this number: an analogy to a cited step, what the speaker implied, or typical practice, naming the ledger evidence where there is some.
- Task steps always cover `work_hours`, `wait_hours` and `rework_rate`, by citation or by value plus reasoning (a zero is a value). Wait steps cover `wait_hours`. A field left out is filled by the server default whatever reasoning accompanies it, and that default is a number nobody chose.
- `sla_hours` and `current_wip` appear only when stated.

## Disagreements and conflicts

- When different speakers give different numbers for the same field, cite each speaker with their `value`. The server keeps each speaker's latest value per source, builds the triangular range (minimum, median, maximum) and marks the step `conflict: true`. It logs a perception-gap issue itself when the largest value is at least twice the smallest, so leave `log_issue` alone and leave averaging to the server.
- For a new step, leave the field value out and give only the citations. The server writes the range.
- Routing has no evidence in the app, so a routing disagreement cannot become an app conflict. Set the probability to the median of what was said, put every quote in the from-step's `notes`, and list it under "Routing conflicts (not tracked by the app)" in the summary.
- Company-fact disagreements: suggest nothing. List both quotes as an open question.

## Second interview on the same process

- Pass `target` as the process id (or exact name).
- List only the steps this interview says something about, plus new steps, using the exact existing step names from `get_process` (or `id`).
- For an existing step, send only the new speaker's citations (with `value`) and leave the field value out, so earlier and new evidence combine. The first interview's citations stay where they are.
- `notes` replaces the step's whole notes. To add a quote (a routing disagreement, a correction), send the existing notes from `get_process` with the new text appended.
- A new step between A and B: list edges `A to New` and `New to B`. Listing edges from A replaces all of A's outgoing edges, so include every branch A keeps, each with its probability.
- `remove_missing` stays at its default. A step someone says no longer happens is an open question.
- Report `created: false`, `diff.text`, `matched`, `conflicts` and `not_overwritten`. A value someone confirmed or entered on the canvas is kept: a disagreeing citation makes it a conflict in `conflicts` (no range is built), and `not_overwritten` lists only values or ranges you sent.

## Suggestions

Company facts are stored as suggestions that change nothing until a person accepts them on the Suggestions page.

- `upsert_role {name, create?, rename?, evidence?, note?}`: when a speaker names or clearly describes a job no existing role covers (matched by meaning). The evidence is the quote naming who does the work.
- `upsert_person {name, roles?, fte? (above 0, up to 1.5), capacity_hours_week?, cost_rate?, start_date?, end_date?, active?, leave?: [{start_date, end_date, note?}], create?, rename?, evidence?, note?}`. `roles` is the full set, by existing role name.
- `upsert_client {name, services?, mrr?, start_date?, health? (0 to 100), notes?, active?, assignments?: {role: person or null}, create?, rename?, evidence?, note?}`. `services` is the full set, by existing service name.
- `set_demand {lead_sources?: [{name, volume_week?, conversion_to_qualified?, create?, rename?, evidence?, note?}], seasonality?: 12 numbers or [{month, multiplier}], growth_monthly?, evidence?, note?}`.
- `set_company` and `upsert_service` apply only when a company setting or a service fact is stated.

Rules:
- Suggest only facts someone stated. Company-model numbers are never assumed.
- Suggestion evidence has a different shape from a step citation: `{source_id, speaker?, quote, timestamp?, value?}`. `source_id` is the source's uuid (a title is refused), there is no `field`, `speaker` is left out when unknown (never null), `timestamp` is at most 50 characters, and a call takes at most 20 citations.
- Every suggestion carries `evidence` and a `note` giving your reading.
- Plans and targets ("we want to grow 20%") are open questions.
- A future-dated change (an FTE change "from November") is a suggestion whose `note` says the date, and the same point is an open question.
- On `ambiguous`, pick from `candidates` when the transcript clearly means one of them. Pass `create: true` only when the row is clearly new; otherwise it is an open question.
- If a matching pending suggestion already exists (from `list_suggestions`), do not create another: say which one to edit or reject.
- `assignments` and `roles` must name existing rows. A pending new person or role cannot be referenced yet: suggest it, and list the assignment as an open question for after it is accepted.
- Never invent a role to fill a step; suggest only roles a speaker named or described.
- `get_workspace_summary` lists roles (with `active`) but no clients, services or lead sources. `upsert_*` without `create` matches by name: an exact match updates, a partial match returns `ambiguous` with candidates, and a name that matches nothing becomes a suggestion to add a new row. Send only names you mean to update or add.

## Summary (the final message)

Headings, in this order:

- `## Draft: <process>`: new, or the diff against live, with `diff.text` and the canvas path `/w/<slug>/p/<process id>`. Name every group and child process written, with each child's own canvas path.
- `### Conflicts`: step, field, who said what, the range used. Then the routing conflicts.
- `### Assumptions`: step, field, value, reasoning.
- `### Not overwritten`: values someone entered that were kept.
- `### First principles`: which of the seven steps are filled in, the quote or assumption behind each item, the flags and warnings returned, and the steps left empty with the reason.
- `### Suggestions`: each `headline`, with who said it, then any proposed issue or solution idea.
- `### Open questions`: for the consultant to ask or decide.
- `### Timing notes`: queue remarks, process-level promises (a servicing SLA is set under Settings, Services, not on a step), stated versus simulated cycle times.
- `### Ledger`: a table covering every number heard.

## Worked example

An invented "Example Co" (roles Account manager and Copywriter exist; 40-hour week). The transcript says at `[00:03:10]` Sam: "the brief takes me two to four hours" and at `[00:05:42]` Sam: "sending it is half an hour, and about one in five ask for changes".

```json
{"process_json": {"name": "Client brief", "kind": "servicing", "entity_name": "brief",
 "steps": [
  {"name": "Start", "kind": "start"},
  {"name": "Draft brief", "role": "Copywriter", "work_dist": "triangular", "work_params": {"min": 2, "mode": 3, "max": 4}, "wait_hours": 0, "rework_rate": 0,
   "evidence": [{"field": "work_hours", "source": "<source id>", "speaker": "Sam", "quote": "the brief takes me two to four hours", "timestamp": "00:03:10", "value": 3}],
   "assumptions": [
    {"field": "wait_hours", "reasoning": "Sam names no wait after drafting; 0 because the brief goes straight to sending."},
    {"field": "rework_rate", "reasoning": "Nobody said the draft comes back; 0 until a second speaker says otherwise."}]},
  {"name": "Send brief", "role": "Account manager", "work_hours": 0.5, "wait_hours": 0, "rework_rate": 0,
   "notes": "Routing: Sam said 'about one in five ask for changes', so 0.2 goes back to Draft brief. The app keeps no evidence on routing.",
   "evidence": [
    {"field": "work_hours", "source": "<source id>", "speaker": "Sam", "quote": "sending it is half an hour", "timestamp": "00:05:42", "value": 0.5}],
   "assumptions": [
    {"field": "wait_hours", "reasoning": "Sending is immediate once the brief is ready; 0."},
    {"field": "rework_rate", "reasoning": "Changes are modelled as routing back to Draft brief, so the step's own rework is 0."}]},
  {"name": "Brief sent", "kind": "end", "outcome": "done"}],
 "edges": [{"from": "Start", "to": "Draft brief"}, {"from": "Draft brief", "to": "Send brief"},
  {"from": "Send brief", "to": "Brief sent", "probability": 0.8}, {"from": "Send brief", "to": "Draft brief", "probability": 0.2}]}}
```

One suggestion from the same interview, where Sam also said "Northgate Foods pay us three grand a month now":

```json
{"name": "Northgate Foods", "mrr": 3000, "note": "Sam gives the current retainer as 3000 a month.",
 "evidence": [{"source_id": "<source uuid>", "speaker": "Sam", "quote": "Northgate Foods pay us three grand a month now", "timestamp": "00:09:30", "value": 3000}]}
```

(sent as `upsert_client`'s arguments).

A nested step from the same interview. Sam also describes onboarding a client in order: at `[00:07:05]` "setting up the account is an hour", at `[00:07:20]` "the kickoff call is an hour", at `[00:07:31]` "the welcome pack is half an hour". The three parts are in sequence with their own times, so the step becomes a group, and the numbers sit on the parts (a fragment of `process_json`):

```json
{"steps": [
  {"name": "Start", "kind": "start"},
  {"name": "Onboard client", "steps": [
    {"name": "Set up account", "role": "Account manager", "work_hours": 1, "wait_hours": 0, "rework_rate": 0,
     "evidence": [{"field": "work_hours", "source": "<source id>", "speaker": "Sam", "quote": "setting up the account is an hour", "timestamp": "00:07:05", "value": 1}],
     "assumptions": [{"field": "wait_hours", "reasoning": "Sam describes no wait before the kickoff; 0."}, {"field": "rework_rate", "reasoning": "Nobody says the set-up is redone; 0."}]},
    {"name": "Run kickoff", "role": "Account manager", "work_hours": 1, "wait_hours": 0, "rework_rate": 0,
     "evidence": [{"field": "work_hours", "source": "<source id>", "speaker": "Sam", "quote": "the kickoff call is an hour", "timestamp": "00:07:20", "value": 1}],
     "assumptions": [{"field": "wait_hours", "reasoning": "The call is in the diary straight after set-up; 0."}, {"field": "rework_rate", "reasoning": "A call is not sent back; 0."}]},
    {"name": "Send welcome pack", "role": "Account manager", "work_hours": 0.5, "wait_hours": 0, "rework_rate": 0,
     "evidence": [{"field": "work_hours", "source": "<source id>", "speaker": "Sam", "quote": "the welcome pack is half an hour", "timestamp": "00:07:31", "value": 0.5}],
     "assumptions": [{"field": "wait_hours", "reasoning": "Sent the same day as the kickoff; 0."}, {"field": "rework_rate", "reasoning": "Nobody says the pack comes back; 0."}]}]},
  {"name": "Onboarded", "kind": "end", "outcome": "done"}],
 "edges": [{"from": "Start", "to": "Onboard client"}, {"from": "Set up account", "to": "Run kickoff"},
  {"from": "Run kickoff", "to": "Send welcome pack"}, {"from": "Onboard client", "to": "Onboarded"}]}
```

If Sam had described onboarding as a process the delivery team runs on its own, the step would instead be `{"name": "Onboard client", "process": {"name": "Client onboarding", "steps": [...], "edges": [...]}}`, or `{"name": "Onboard client", "child_process": "Client onboarding"}` when that process already exists. Had Sam said only "onboarding takes about three hours", it stays one step.

First principles from the same interview, where Sam also said at `[00:08:10]` "the contract says the brief goes out within two days" and at `[00:08:40]` "Dana signs off every brief before it goes". The source was added with the title "Example Co interview: Sam, account manager (2026-10-05)", a 40 hour week (a working day is 8 h). Arguments of `update_first_principles`:

```json
{"process": "Client brief",
 "statements": [
  {"text": "A brief goes out within two days.", "kind": "truth", "source": "\"the contract says the brief goes out within two days\" [Example Co interview: Sam, account manager (2026-10-05) | Sam | 00:08:10]"},
  {"text": "Every brief needs sign-off before it goes.", "kind": "assumption", "source": "Assumed: Sam names a sign-off but not a rule behind it; it may be habit.", "test": "Send three briefs without sign-off and see whether anyone objects."}],
 "requirements": [
  {"text": "Dana signs off every brief", "owner": "Dana Webb", "step": "Send brief", "verdict": "challenge",
   "why": "\"Dana signs off every brief before it goes\" [Example Co interview: Sam, account manager (2026-10-05) | Sam | 00:08:40]. Assumed: Sam does not say why; Dana is named as owner because she does the sign-off."}],
 "measures": [
  {"text": "A brief goes out within two days: \"the contract says the brief goes out within two days\" [Example Co interview: Sam, account manager (2026-10-05) | Sam | 00:08:10]. Assumed: two working days at 8 hours a day is 16 working hours.",
   "kpi": "cycleHours", "comparator": "atMost", "target": 16}]}
```
