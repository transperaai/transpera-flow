# Answer key: Copperleaf Marketing (QA)

> **Out of date, 28 Oct 2026.** Written for the removed MCP extraction flow. The "suggestions" below are company facts to enter in the app by hand now; the tool payloads are history. The planted conflicts, traps and numbers still apply to the `process-file` skill.


**Do not open this before or during the timed run.** It is for judging afterwards. Claude must never see it: run Claude outside the repo (see `README.md`), so this file, the dry-run examples and the skill's tests are out of reach.

The two transcripts are invented and deliberately messy. This key lists what each planted item is and how a good run handles it, in prose. It holds no tool payloads: a correct run is judged by what the draft, the checklist and the Suggestions page end up showing.

Conventions used below:
- Times are the `[hh:mm:ss]` stamps in the transcripts.
- Copperleaf works a 37.5 hour week, so **a working day is 7.5 hours** and a week is 37.5. Every conversion below uses that. A run that uses 8 hours a day has fallen into the trap.
- "Cited" means the number sits in the step's evidence with the speaker, the verbatim quote and the timestamp, and the value in hours (or a 0 to 1 share, or items).
- Names must be the workspace's own: roles are Managing director, Account director, Paid media specialist and Finance. There is deliberately no Designer role.

## The process both interviews describe

Enquiry to signed client is a **pipeline** whose entity is a lead. One start step and two end steps, Won and Lost. The steps, in order, as Grace describes them:

1. Enquiry received (start).
2. Qualify enquiry: Grace, Managing director.
3. Book discovery call: a wait for the diary.
4. Discovery call: Grace, Managing director.
5. Account audit: Ellie mostly, Kofi as backup, Paid media specialist.
6. Pitch deck: Maddie, who has no role in the workspace.
7. Proposal: Grace, Managing director.
8. Client decision: a wait for the client.
9. Contracts: Tom, Account director.
10. Onboarding call: Tom with the account team, Account director.
11. Won (end), and Lost (end).

Step names may differ; what matters is one step per piece of work, exactly one start step, and outgoing branches that add up to 1. Interview 2 adds **Pricing sign-off** between Proposal and Client decision. Losers leave at Qualify enquiry and at Client decision.

## Interview 1: Grace Adeyemi (managing director)

### Numbers on steps

| Planted item | Where | Expected handling |
|---|---|---|
| A point value | "An hour, give or take" at `[00:05:59]`, said twice | Discovery call hands-on time 1 hour, cited to Grace. Not a range: "give or take" is a plain point value here. |
| A symmetric hedge | "two, three hours" for the proposal at `[00:10:08]` | Proposal hands-on time as a triangular range 2 / 2.5 / 3 hours, cited at the midpoint 2.5. Not lognormal, not 2 or 3 alone. |
| A hedge and a unit trap | "two or three days out" for the discovery booking at `[00:04:21]` | A wait, not work. Two to three days is 15 / 18.75 / 22.5 hours at 7.5 hours a day, triangular, cited at the midpoint 18.75. On an 8 hour day it would be 16 / 20 / 24, which is wrong. |
| A long wait and a unit trap | "within two weeks" for the client decision at `[00:13:15]` | A wait of 75 hours (ten working days at 7.5). "Within" is a ceiling, so good reasoning says so; 80 (8 hour days) is wrong. |
| A self-correction | "same day... actually no, Tom does contracts now, more like two days" at `[00:14:33]` | Cite only the correction: 2 days is 15 hours, on the Account director role (Tom). The step's notes say Grace corrected herself from same day. Not 7.5. |
| Typical plus tail | "Onboarding call is an hour, big accounts get a half-day workshop" at `[00:15:44]` | Onboarding call hands-on time 1 hour cited; the half-day workshop for big accounts (3.75 hours) in the notes, not a range. Role Account director (Tom runs it). |
| Rework | "one proposal in four needs a second version" at `[00:12:10]` | Proposal rework rate 0.25, cited. The second version repeats the Proposal step itself, so no other rework target. |
| Routing, a third are tyre-kickers | "A third are tyre-kickers" at `[00:03:03]` | From Qualify enquiry, about 0.33 to Lost and the rest to Book discovery call. The quote goes in Qualify enquiry's notes: routing has no evidence in the app. |
| Routing, win about half | "We win about half" at `[00:13:40]` | From Client decision, 0.5 to Won and 0.5 to Lost, quote in the notes of Client decision. |
| Work in progress | "five proposals on my desk" at `[00:11:10]` | Proposal current WIP 5, cited (she adds "four on my desk and one half in my head", still five). |
| A service level | "within five working days of the call" at `[00:12:41]` | Proposal SLA 37.5 hours (5 x 7.5), cited. The promise runs from the call, so it spans more than this step: a timing note says so and asks whether the audit and deck sit inside it. |
| A queue trap | "they sit on my desk a week because I'm pitching" at `[00:11:29]` | A timing note about queueing behind Grace's other work, which the engine simulates. It is not a wait: Proposal's wait stays an assumed 0. |
| An unknown role | "Maddie, our designer, does the pitch deck" at `[00:08:41]` | The Pitch deck step has no role (there is no Designer role yet). An `upsert_role` suggestion for Designer, citing this quote, and an open question to set Pitch deck's role once it is accepted. A suggestion for Maddie Kerr as a person with no roles (she is not on the team list; the Designer role can only be given to her after both are accepted). |
| An unstated time | Maddie's deck time: "I honestly couldn't tell you" at `[00:09:16]` | Pitch deck hands-on time is an assumption with reasoning (for example an analogy to the audit or the proposal, and Grace's "I've never asked"). It is given explicitly, not left to the server default. |
| A leading question | "So four hours for the audit?" then "Yeah, roughly." at `[00:08:05]` and `[00:08:10]` | Audit hands-on time 4 hours, cited with Grace as speaker. The quote may be the two lines together (exactly as they appear, contiguous) or Grace's "Yeah, roughly." with the interviewer's "four hours" recorded in the notes. Either way the value is 4, on the Paid media specialist role. |
| An unstated time, qualify | "It's quick. It's a coffee-length thing" at `[00:03:55]` | Qualify enquiry hands-on time is an assumption with reasoning; Grace declines to give a number. |

**Also accept for Contracts:** Grace says Tom "does them in batches", so a run may reasonably treat the two days (and Tom's working day) as elapsed time rather than hands-on time: `wait_hours` on Contracts, or a timing note about batching with an assumed hands-on time. Mark it correct if the choice is explained; the perception-gap count then drops by one.

Also on every task step: a wait and a rework value nobody stated are given explicitly with reasoning, never left to the server default. The checklist must show your own reasoning against each, never "Server default for a task step".

### Not to be modelled

- "maybe a fifth of them" of enquiries skip the audit at `[00:07:23]`: Grace herself says don't hold her to it, and the interviewer agrees it is not a number to model. It belongs in the ledger as not modelled.
- "sixty per cent, ish" of website enquiries from Google at `[00:20:44]`: a guess Grace admits to making up. Not modelled.
- "Forty-odd last year, ish" proposals at `[00:23:16]`: a guess, not modelled.
- "ten minutes" (Ellie's cameo, about a call-back): not modelled.

### Suggestions from interview 1

Each carries evidence in the suggestion shape (the source id, the speaker, the verbatim quote, the timestamp) and a note.

| Planted item | Expected suggestion |
|---|---|
| Ellie to four days "from November" at `[00:17:18]` | Ellie Marsh FTE 0.8. The note gives the timing (November, "the first Monday I think") and the same point is an open question, because the date is not firm. |
| A new hire at `[00:17:46]` | Add Ruby Chen with the Paid media specialist role and a start date of 2026-11-02. FTE is not stated (the app defaults it to 1; the summary says so). |
| Leave at `[00:18:11]` | Kofi Mensah leave 2026-12-07 to 2026-12-24 (inclusive). |
| A client change at `[00:18:52]` | Ashgrove Garden Centre MRR 3600 with services PPC management and Paid social. |
| A new client at `[00:19:24]` | Add Harlow & Pike Opticians (either spelling of "and" is fine, but consistent) with service Paid social, MRR 2500 with the hedge ("about two and a half grand") in the note, and an assignment of Account director to Tom Whitfield. "Signed last week" gives no firm date, so the start date is an open question, not a suggestion. |
| Website demand at `[00:20:22]` | Website enquiries volume 9 a week, with the range 8 to 10 in the note. Referrals at "about one a week" match the workspace, so nothing is suggested for them despite the self-correction. |
| A new lead source at `[00:21:14]` | Add LinkedIn with volume 2 a week. |
| Seasonality at `[00:21:34]` | December multiplier 0.5. |

### Traps that must NOT become suggestions

- "We want to grow twenty per cent next year" at `[00:22:02]`: a target and a plan, not a fact. It is an open question. It must not become a demand growth figure or a company setting.
- "Over the summer we're going four-day weeks for everybody" at `[00:22:19]`: a plan the model cannot represent, so an open question (and a note that capacity in July and August would change).

## Interview 2: Tom Whitfield (account director)

This is a second interview on the same process. A correct run writes into the existing process (it does not create a second one), lists only the steps Tom speaks about plus the new one, cites only Tom's numbers, and leaves the field values out so the server combines Grace's evidence and Tom's into a range. The process list must still show one process, and the draft must show a diff.

**Confirmed values.** The ranges below assume Grace's values were published as estimates. Confirming a value on the canvas makes it `entered`, and an entered value is never overwritten. So for any value Austin confirmed between the interviews, the step keeps Grace's number (Proposal keeps 2 / 2.5 / 3), is flagged with a conflict listing both speakers, and gets no range. The perception-gap issue is logged either way. The import's `not_overwritten` stays empty, because the run sends citations and no field values; the kept value shows up in `conflicts`.

### Numbers on steps

| Planted item | Where | Expected handling |
|---|---|---|
| Corroboration | "About an hour" for the discovery call at `[00:01:53]` | Cite Tom's 1 hour on Discovery call. It agrees with Grace, so no conflict and nothing flagged. |
| A conflict with a ratio of 4.5 | "a day and a half, all in" for the proposal at `[00:04:39]` | Cite 11.25 hours (1.5 x 7.5) on Proposal, working time rather than elapsed (Tom confirms). It conflicts with Grace's 2.5: the server builds a triangular range 2.5 / 6.875 / 11.25, flags a conflict, and logs a perception-gap issue on its own (11.25 against 2.5 is 4.5 times apart). The summary shows both quotes. |
| A conflict with a ratio of 2 | "Half the time, yeah" for proposal rework at `[00:06:18]` | Cite 0.5 on Proposal rework, conflicting with Grace's 0.25; median 0.375, a perception gap (exactly 2 times apart). |
| A new step | Pricing sign-off, "Twenty minutes" at `[00:07:06]` | A new task step, Pricing sign-off, Account director, hands-on 0.33 hours (twenty minutes), cited to Tom (he corrects himself from "fifteen, twenty" to twenty; cite the correction). It sits between Proposal and Client decision: Proposal now leads to Pricing sign-off and that leads to Client decision. Wait and rework are assumed with reasoning ("it's not a queue"). |
| A routing conflict | "one in three, if we're honest" at `[00:08:42]` | Client decision to Won becomes the median of Grace's 0.5 and Tom's 0.33, about 0.42 (and 0.58 to Lost). Both quotes go in Client decision's notes. The summary lists it under "Routing conflicts (not tracked by the app)": routing has no evidence, so it cannot become a conflict in the app. |
| A conflict, or a kept value | "They're out in a day" at `[00:10:30]` and "A working day" at `[00:11:26]` | Contracts hands-on 7.5 hours (one working day), cited to Tom. It conflicts with Grace's 15 (range 7.5 / 11.25 / 15, perception gap of 2 times). If Austin confirmed Contracts on the canvas between the interviews, the confirmed value is kept and Tom's 7.5 is flagged as a conflict against it (see "Confirmed values" above). |
| A conflict | "Two hours with prep" at `[00:13:39]` | Onboarding call hands-on 2 hours cited to Tom, against Grace's 1. Range 1 / 1.5 / 2 and a perception gap of 2 times. "Half a day on top" for big accounts is a note. |
| Work in progress | "Three contracts waiting on signatures" at `[00:11:39]` | Contracts current WIP 3, cited (he self-corrects to three). |

Not to model: Tom's "Harlow and Pike were quick, they signed in three days" at `[00:12:02]` (one data point he says not to average), the signature chase (no time given), and the proposal's elapsed week (a queue, the same timing note as Grace's).

### Suggestions from interview 2

| Planted item | Expected handling |
|---|---|
| Kofi's FTE at `[00:15:15]` | Kofi Mensah FTE 0.8, cited to Tom ("four days, always has been"). |
| Ruby's start date at `[00:15:47]` | Interview 1 already created a pending suggestion to add Ruby Chen starting 2026-11-02, so **no second suggestion to add her**. It is an open question: edit the pending suggestion's start date to 2026-11-09 (Tom: "HR moved it"). If Austin already accepted it, Ruby exists and a suggestion to change her start date is the right size. |
| A lost client at `[00:16:20]` | Brambleway Farm Shop inactive (they went in-house last month). |
| A disagreement at `[00:16:59]` | Interview 1's LinkedIn suggestion (2 a week) is pending or accepted, and Tom says about one a week. No new suggestion: both quotes become an open question for Austin to settle. |
| Not booked at `[00:17:57]` | Tom says his leave is not booked and asks not to record it. Nothing is suggested; at most an open question. |

## What the summary must contain

The report ends with these sections, in this order, each present even if empty: the draft (new, or the diff against live and the canvas path), Conflicts (with the routing conflicts after them), Assumptions, Not overwritten, Suggestions, Open questions, Timing notes and the Ledger. The ledger holds a line for every number in the transcript, including the ones that are not modelled, and the timing notes cover the queue, the five working day promise and any stated versus simulated cycle time.

## Perception-gap issues to find on the Issues page after interview 2

Four are expected: Proposal hands-on time, Proposal rework, Contracts hands-on time and Onboarding call hands-on time. Discovery call (agreement) and Client decision (routing) raise none. A value Austin confirmed still raises its issue: the kept value stands against Tom's.

## Reading the checklist

After interview 1 there are no conflicts, only assumptions: each cited value appears with its quote, and each uncited value has reasoning written by the run. After interview 2 the checklist lists the conflicts first, each with both speakers' quotes.
