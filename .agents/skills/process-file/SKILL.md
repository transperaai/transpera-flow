---
name: process-file
description: Turn interviews, rough process maps, SOPs and spreadsheets into transpera-process/2 JSON files, one per process, for "Upload process" in Transpera Flow.
---

# Build process files

Turn a mix of materials into upload files in the `transpera-process/2` format that Austin uploads on the app's Processes page. Each file becomes a **draft**; people, clients and ideas arrive as **suggestions** and **proposals** that wait for him to accept. The schema (`docs/import/transpera-process-2.schema.json`) and the example beside it hold the field names; read both first (in Claude desktop they are attached to the Project).

Leading words: **evidence** (a verbatim quote that backs a number), **assumed** (a reason for a number Austin told you to guess), **conflict** (sources give different numbers), **gap** (a value in the useful minimum that is absent), **question** (every gap and ambiguity is asked, never guessed).

## Flow

1. **Read** every material end to end: transcripts, SOPs, spreadsheets, and maps (look at the picture, or read the text).
   - Done when each material has an id, title, kind, date and speakers (leave out any you cannot read from the material). The `kind`: interview or call → `transcript`; SOP or document → `notes`; spreadsheet or export → `data`; a drawn map, as a picture or as text → `notes`; a screenshot of a tool → `screenshot`.
2. **List** what you found, in a message to Austin: processes (with the sources for each), people and roles, every number heard, and the places where sources disagree.
   - Done when every number heard is listed with its speaker and time.
3. **Ask** about every gap and every ambiguity, in one message, numbered and grouped by process so Austin can answer by number. Ask about:
   - each **gap** (a value in the useful minimum that is absent: role, hands-on time, wait, odds, incoming volume);
   - each **conflict** between sources;
   - each unclear step, branch or order, the process split, the hours in a working day (when a source says "days"), role titles, a surname for a first name;
   - each value the materials only imply ("same day", "never goes back"), a number only the interviewer proposed, and each withdrawn number.
   - Give every question a **suggested answer** with the quote it rests on (`Hana, 00:03:38: "One in five, I'd say." → 0.2?`), so confirming is one word.
   - Done when every gap, conflict and ambiguity from step 2 has a numbered question.
4. **Build** one JSON file per process only after the answers (see "One file per process"), then **check** it (see "Check"). A question left unanswered stays a gap until he answers it.
5. **Summarise** (see "Output and summary").

## Evidence

Every number carries evidence or an assumed reason. Every stated number is kept: nothing a speaker said is dropped for being awkward to place.

- **Evidence** is the shortest verbatim stretch of one line that states the number, with `source`, `speaker` (the label as written), `time` (`00:03:12`, `page 3`, `cell B7`, `arrow from Review to Call`) and `value` in the field's units. Case and punctuation may differ; the words match.
- **Assumed** is written only when Austin says "skip" or "use your best guess" for an item: `Assumed: <reason> (Austin said to assume)`. A converted number also carries it, naming the conversion and the day length Austin gave.
- **Silence.** A value nobody stated and Austin did not supply is left out, never invented. The app marks it missing, and the gap shows in the summary.
- **Shapes.** A step's `evidence` and `assumed` are objects keyed by field, and only `hands_on_hours`, `wait_hours`, `rework_rate`, `waiting_now` and `sla_hours` take them: `"evidence": {"wait_hours": [{...}]}`, `"assumed": {"wait_hours": "reason"}`. A link's `evidence` is a list of quotes and its `assumed` a string. Every company, proposal and first-principles item takes `evidence` (a list) and `assumed` (a string).
- **Units.** Everything is hours per item; shares run 0 to 1; minutes divide by 60 (twenty minutes is 0.33). A "day" converts at the company's day (7.5 hours when it works a 37.5-hour week), asked once in step 3 when no material says. Keep the speaker's words in the quote and the converted number in `value`, with the day length in `assumed`.
- **Ranges.** A symmetric hedge ("two, three hours") is the midpoint in `hands_on_hours`, the bounds in `hands_on_range`, and the midpoint as the quote's `value`. A typical value with a tail ("usually an hour, sometimes a half-day") is the typical value, with the tail in `notes`. A **ceiling** ("within two weeks", "up to an hour") is the number to use: put it in `wait_hours` (or `hands_on_hours`) with an assumed reason that quotes it and says it is a maximum, and add the range when a minimum is known too ("some come back in a day").
- **Conflict.** When sources give different numbers and Austin does not settle them, leave the value out and give each source's quote with its own `value`; when he settles one, use his number with both quotes kept. The checker reports the disagreement, and the app flags it on the draft and logs a perception gap when the largest is at least twice the smallest. For odds, give each branch both quotes, so the branches still add to 1 (one in three win: 0.33 for won, 0.67 for lost).
- **Corrections.** A speaker who corrects themselves is quoted at the correction. A number the interviewer proposed and the speaker accepted is asked about first (it is the interviewer's number); once Austin confirms, it is quoted at the agreement ("Yeah, roughly.") and `assumed` says who proposed it.
- **Withdrawn numbers.** A number the speaker or the interviewer withdrew ("I'd be making it up", "don't hold me to that", "not a number to model") is asked about, with "leave it out" as the suggested answer, and stays out of the file unless Austin supplies it.
- **Queueing.** "Sits in her inbox because she is busy" is queueing, which the simulation produces from capacity. It goes in `notes`, and the stated count of items there goes in `waiting_now`. `wait_hours` is for time nobody works on the item: the client, the calendar, a courier.
- **Elapsed times.** "Out in a day", "takes two days to go out" is time at the step, not hands-on time: it goes in `wait_hours` (converted at the working day), with `notes` saying it is elapsed. A promise ("within five working days") is `sla_hours`.
- **Scope.** Two numbers for the "same" step that count different things (writing time against all-in effort, a call against the call plus prep) stay as a conflict, and `notes` says what each includes.

## Turning materials into steps

| Material | Take |
|---|---|
| Rough map | Box text is a step name; arrows are links; a diamond or a split is a decision; arrow labels (Yes, No, 30%) are `label` and odds; a lane or colour is a role; a note with a time is a number (`time` says where on the map). A box with no number gets none. |
| Interview | The order the speaker walks through is the link order; "then", "after that", "goes to" are links. Each person who does work is a role; "only X does it" is `person`; software named is `tool`. |
| SOP | Numbered steps are steps; stated deadlines and promises are `sla_hours` on a step, or a first-principles requirement when they span steps. |
| Spreadsheet | Columns of times, volumes and prices are numbers (`time` is the cell or row); a roster is `company.people`, an account list is `company.clients`. |

- **Step types.** `start` (exactly one, leading to exactly one step), `step` (someone works), `wait` (nobody works), `decision` (items branch), `end` (one per way an item finishes: won, lost, not a fit).
- **Decisions and odds.** "Some go to X, others Y" is a decision, or odds on the links out of a step when the branch is that step's own result. Branches out of one step add to 1. "Most" or "a few" with no number gets no odds.
- **Loops.** Work sent back to be redone is `rework_rate` with `rework_to` (the step it returns to; its own step when omitted), never a link back. A loop in the links exists only when a decision step decides when it stops.
- **Order.** A step a speaker describes that another source omits is a step ("Tom does a pricing check Grace never mentions"). Say so in `notes` and in the summary's conflicts.
- Leave `x` and `y` out. Names and ids are unique; ids are short (`first-look`).

## One file per process

A process is one trigger to one outcome, with one kind of thing flowing through it.

- Several sources about the same process make one file (two interviews, one SOP).
- A different trigger or a different thing flowing (a monthly report against onboarding a client) makes a separate file. A passing mention of another process stays out of the steps and is asked about.
- `kind` is `pipeline` when new leads become clients (it needs lead volume), `servicing` when work recurs for existing clients.
- Each source appears in every file it supports. Put each company fact in one file only, the one it belongs to, so it is suggested once.

## Company, proposals, first principles

- **`company`**: only stated facts go in.
  - `people`: `fte` (days of five), `roles`, `start_date` (a new hire's first day), `leave` (booked leave only: `[{start_date, end_date, note}]`). A person the materials name belongs here too, a freelancer included, with the role they hold.
  - `roles` the materials name that nobody holds; `clients`: `services`, `mrr`, `active` (`false` for a client that has left), `assignments` (`{"Account director": "Tom Whitfield"}`, role to person, both already in the company); `demand`: lead sources (volume a week), seasonality (all twelve months, unspoken months at 1).
  - **Later correction wins.** When a speaker corrects an earlier fact ("Ruby starts on the ninth, not the second"), the file takes the correction and cites both quotes. Two sources that simply disagree keep both quotes, leave the value out and say "settle it before accepting" in `assumed`. Approximate figures say so in `assumed`.
- **Not file content, asked about instead**: plans, targets and unbooked leave. A change that starts later ("four days from November") is suggested with its date in `assumed`, because accepting applies it at once, and is also asked about.
- **`proposals`**: a problem a speaker names that touches a step is an `issue` with the quote (`type` `issue`, `steps` the ids it touches). A `solution_idea` needs both `for_issue` (an issue Austin already tracks, by number or title) and `proposed_steps` (the steps it would put in place, in order, each with a `name`); without a tracked issue, the idea goes in the issue's `detail`.
- **`first_principles`**: a requirement a speaker stated (with `owner`, a named person, never a team), a truth that cannot be argued away (a contract term, `kind` `truth`; a belief is `assumption` with a `test`), a target as a measure, and the job and the why-chain when someone said them. Leave the rest out.
  - Measure: `kpi` is one of `won`, `winsPerWeek`, `winRate`, `newMrr`, `billed`, `cycleHours`, `labour`, `wipEnd` (leave it out when none fits); `comparator` is `atLeast` or `atMost` ("within", "under" are `atMost`); `target` is in the unit people read (30 for a 30% win rate, 40 for five working days at 8 hours).
  - Requirement `verdict` is `keep`, `change`, `drop` or `challenge`, set only when a speaker said so.

## Check

Run the checker's rules over each file before showing it; the upload preview applies them again and quotes any it finds.

- Top level: `format`, `name`, `steps` (at least one). Every field is in the schema.
- Step and source ids and step names are unique; every link, `rework_to`, group member and proposal step names an existing id; every quote's `source` is a source id.
- One `start`; it leads to one step. Nothing leaves an `end`; no link into the start or from a step to itself; no link twice.
- Branch odds add to 1. No loop without a decision. A step with `rework_to` has a rework rate, stated or quoted.
- A quote's `value` is in the field's units; `hands_on_range` surrounds `hands_on_hours`.
- Each quote is a stretch of one line at its time, said by its speaker, and each assumed reason says why.
- Count the **gaps** (the useful minimum):
  1. a role on every work step;
  2. hands-on time on every work step;
  3. a wait on every wait step;
  4. odds on every branch of a decision;
  5. incoming volume (lead volume for a pipeline, a recurrence for servicing).

## Output and summary

Write each file as `<process-slug>.json` in the working folder when files can be created; otherwise reply with one code block per file, labelled with its file name, containing only the JSON. A Claude Design page comes only when Austin asks for one (the same JSON in one `<script type="application/vnd.transpera-process+json">` block).

End with a short summary, in these sections (an empty one says "none"):

- **Built**: each file with its kind, steps, links, sources, and the counts of suggestions and proposals.
- **Questions asked and answers**: each numbered question with Austin's answer (or "unanswered").
- **Assumptions**: only the items Austin told you to assume: step, value, reason.
- **Conflicts between sources**: who said what, what Austin decided, and how the file holds it.
- **Missing for simulation**: per file, each gap in plain words ("Write proposal has no hands-on time", "Client decides: branch odds missing", "No incoming volume").
- **Left out**: withdrawn numbers, plans, and facts the format cannot hold.
- **Still open**: questions he did not answer, and what he must ask others, the ones that fill the gaps first.
- **Ledger** (optional, when he wants to audit): one line per number heard, with speaker, time, quote and where it went (a step field, odds, a suggestion, notes, or left out and why).
