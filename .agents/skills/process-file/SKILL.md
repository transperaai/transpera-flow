---
name: process-file
description: Turn interviews, rough process maps, SOPs and spreadsheets into transpera-process/2 JSON files, one per process, for "Upload process" in Transpera Flow.
---

# Build process files

Turn a mix of materials into upload files in the `transpera-process/2` format that Austin uploads on the app's Processes page. Each file becomes a **draft**; people, clients and ideas arrive as **suggestions** and **proposals** that wait for him to accept. The schema (`docs/import/transpera-process-2.schema.json`) and the example beside it hold the field names; read both first (in Claude desktop they are attached to the Project).

Leading words: **evidence** (a verbatim quote that backs a number), **assumed** (a reason for a number nobody stated), **conflict** (sources give different numbers), **gap** (a value in the useful minimum that is absent), **open question** (something Austin must ask or decide).

## Flow

1. **Read** every material end to end: transcripts, SOPs, spreadsheets, and maps (look at the picture, or read the text).
   - Done when each material has an id, title, kind, date and speakers (leave out any you cannot read from the material).
2. **List** what you found, in a message to Austin: processes (with the sources for each), people and roles, every number heard, and the places where sources disagree.
   - Done when every number heard is listed with its speaker and time.
3. **Ask** only what blocks the build, at most five questions, in one message. A question blocks when the answer changes the file split, the structure, or the units of many numbers: hours in a working day (when a source says "days"), which materials describe the same process, the role titles to use (when the materials never give them), a surname for a first name.
   - Give each question the default you will use if he does not answer, so "go" is a complete reply.
   - Everything else becomes an open question in the summary.
4. **Build** one JSON file per process (see "One file per process"), then **check** it (see "Check").
5. **Summarise** (see "Summary").

## Evidence

Every number carries evidence or an assumed reason. A value with neither is left out; the app marks it missing, and the gap shows in the summary.

- **Evidence** is the shortest verbatim stretch of one line that states the number, with `source`, `speaker` (the label as written), `time` (`00:03:12`, `page 3`, `cell B7`, `arrow from Review to Call`) and `value` in the field's units. Case and punctuation may differ; the words match.
- **Assumed** is one sentence: where the number comes from and how firm it is. Use it for a number the sources imply but nobody stated, and beside evidence for a converted number (it names the conversion).
- **Units.** Everything is hours per item; shares run 0 to 1; minutes divide by 60 (twenty minutes is 0.33). A "day" converts at the company's day (7.5 hours when it works a 37.5-hour week), asked once in step 3 when no material says. Keep the speaker's words in the quote and the converted number in `value`, with the day length in `assumed`.
- **Ranges.** A symmetric hedge ("two, three hours") is the midpoint in `hands_on_hours`, the bounds in `hands_on_range`, and the midpoint as the quote's `value`. A typical value with a tail ("usually an hour, sometimes a half-day") is the typical value, with the tail in `notes`. A bound ("within two weeks") is a ceiling: give `wait_range` and an assumed reason quoting it, and leave the typical value out.
- **Conflict.** When sources give different numbers for one value, leave the value out and give each source's quote with its own `value`. The checker reports the disagreement, and the app flags it on the draft and logs a perception gap when the numbers are twice as far apart. For odds, give each branch both quotes, so the branches still add to 1 (one in three win: 0.33 for won, 0.67 for lost).
- **Corrections.** A speaker who corrects themselves is quoted at the correction. A number the interviewer proposed and the speaker accepted is quoted at the agreement ("Yeah, roughly."), and `assumed` says who proposed it.
- **Withdrawn numbers.** A number the speaker would not stand behind ("I'd be making it up", "don't hold me to that", "not a number to model") stays out of the file and goes in `notes` or the open questions.
- **Queueing.** "Sits in her inbox because she is busy" is queueing, which the simulation produces from capacity. It goes in `notes`, and the stated count of items there goes in `waiting_now`. `wait_hours` is for time nobody works on the item: the client, the calendar, a courier.
- **Scope.** Two numbers for the "same" step that count different things (writing time against all-in effort, a call against the call plus prep) stay as a conflict, and `notes` says what each includes.

## Turning materials into steps

| Material | Take |
|---|---|
| Rough map | Box text is a step name; arrows are links; a diamond or a split is a decision; arrow labels (Yes, No, 30%) are `label` and odds; a lane or colour is a role; a note with a time is a number (evidence kind `screenshot`, `time` says where). A box with no number gets none. |
| Interview | The order the speaker walks through is the link order; "then", "after that", "goes to" are links. Each person who does work is a role; "only X does it" is `person`; software named is `tool`. |
| SOP | Numbered steps are steps; stated deadlines and promises are `sla_hours` on a step, or a first-principles requirement when they span steps. |
| Spreadsheet | Columns of times, volumes and prices are numbers (evidence kind `data`, `time` is the cell or row); a roster is `company.people`, an account list is `company.clients`. |

- **Step types.** `start` (exactly one, leading to exactly one step), `step` (someone works), `wait` (nobody works), `decision` (items branch), `end` (one per way an item finishes: won, lost, not a fit).
- **Decisions and odds.** "Some go to X, others Y" is a decision, or odds on the links out of a step when the branch is that step's own result. Branches out of one step add to 1. "Most" or "a few" with no number gets no odds.
- **Loops.** Work sent back to be redone is `rework_rate` with `rework_to` (the step it returns to; its own step when omitted), never a link back. A loop in the links exists only when a decision step decides when it stops.
- **Order.** A step a speaker describes that another source omits is a step ("Tom does a pricing check Grace never mentions"). Say so in `notes` and in the summary's conflicts.
- Leave `x` and `y` out. Names and ids are unique; ids are short (`first-look`).

## One file per process

A process is one trigger to one outcome, with one kind of thing flowing through it.

- Several sources about the same process make one file (two interviews, one SOP).
- A different trigger or a different thing flowing (a monthly report against onboarding a client) makes a separate file. A passing mention of another process stays out of the steps and goes in the open questions.
- `kind` is `pipeline` when new leads become clients (it needs lead volume), `servicing` when work recurs for existing clients.
- Each source appears in every file it supports. Put each company fact in one file only, the one it belongs to, so it is suggested once.

## Company, proposals, first principles

- **`company`**: people (FTE as days of five, roles), roles the materials name that nobody holds, clients (services, monthly fee), lead sources (volume a week), seasonality (all twelve months, unspoken months at 1). Only stated facts go in. A fact the sources disagree on keeps both quotes, leaves the value out and says "settle it before accepting" in `assumed`. Approximate figures say so in `assumed`.
- **Open questions, not file content**: plans, targets, unbooked leave, and booked leave (the format has no leave field). A change that starts later ("four days from November") is suggested with its date in `assumed`, because accepting applies it at once, and is also an open question.
- **`proposals`**: a problem a speaker names that touches a step is an `issue` with the quote. A `solution_idea` needs `for_issue`, an issue Austin already tracks; without one, the idea goes in the issue's `detail`.
- **`first_principles`**: a requirement a speaker stated (with `owner`, a named person, never a team), a truth that cannot be argued away (a contract term), a target as a measure with its KPI and `atMost` for "within". The job and the why-chain are filled when someone said them. Leave the rest out.

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
- **Assumptions**: step, value, reason.
- **Conflicts between sources**: who said what, and how the file holds it.
- **Missing for simulation**: per file, each gap in plain words ("Write proposal has no hands-on time", "Client decides: branch odds missing", "No incoming volume").
- **Left out**: withdrawn numbers, plans, and facts the format cannot hold.
- **Open questions**: what Austin must ask or decide, the ones that fill the gaps first.
