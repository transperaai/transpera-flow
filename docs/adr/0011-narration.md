# 11. Narration: Claude drafts, a number check decides, the template is the floor

> **Superseded: removed 28 Oct 2026, docs/plans/cut-list.md item 1.** In-app AI and findings are gone (migration `20270101000000_drop_in_app_ai.sql` drops the narration data). Kept as history.


Date: 30 Sep 2026 · Status: accepted (the executive-summary narration was removed with reports in A32 (#97); "explain this run" remains) · Issue: #29 · Implements PRD §7.3 "LLM", §5 `narrations`, §10 "LLM calls", D2, D15

## Context

The report's executive summary and an "explain this run" action may be written by a language model (PRD §7.3), but
"the engine produces all numbers" (§3, D15): one invented figure in a handover document undoes the product's claim.
The PRD fixes the shape: Anthropic API from server routes only, the average-plus-range format and the robustness
verdict in the prompt, every number checked against the input JSON "tolerant of rounding and formatting (£4,213 ≈
£4.2k)", one retry naming the offending numbers, the templated text as the fallback, cached per run or comparison,
on demand only, editable before export with the edit recorded in the provenance appendix. #28 left the hooks:
`content.summary = {source, paragraphs, editedBy}`, `reportFacts`, and the appendix line.

## Decision

- **Model and call.** `claude-opus-5-5` (the latest model per the repo's claude-api guidance), through
  `@anthropic-ai/sdk` in `apps/web/src/lib/narration/anthropic.ts`, which imports `server-only` and is the only module
  that reads `ANTHROPIC_API_KEY` (a test enforces both). Adaptive thinking at effort `medium`, structured output (a
  JSON schema: `{paragraphs: string[]}`), `max_tokens` 8000, no SDK retries, and `fallbacks: "default"` (beta
  `server-side-fallback-2026-07-01`) so a classifier refusal is re-run server-side on Anthropic's recommended model;
  the model that answered is recorded. The facts go in their own content block with `cache_control`, before the
  instruction, so the redraft reuses the cached prefix. Without a key the narrator is `null` and the template prints
  with the reason "narration isn't configured".
- **What is sent** (`facts.ts`). Only what the text needs: the process name, the period, replications and currency;
  each headline figure as the report prints it ("avg £33.0k (range £22.4k–£45.5k)") with its definition; the
  bottleneck sentences and the shadow price; client retention counts; each scenario's changes, headline, details,
  delta table, robustness verdict and three most sensitive inputs; issue counts by severity; and the templated
  summary as a model of the house style. Client and people names are replaced by labels ("Client A", "Team member B")
  and mapped back after the check. Never sent: the workspace name, evidence quotes, sources, issue titles or owners,
  per-person utilisation, cost rates, the appendix. "Explain this run" sends the saved run's headline results, the
  process name and the busiest role.
- **The number check** (`numbers.ts`, pure). Every number in the text is found: digits with sign, currency (`£`,
  `A$`, `GBP`), scale (`k`, `m`, `bn`, "thousand"), unit (`%`, percentage points/pts/pp, days/d, hours/h, weeks);
  ranges ("£3.1–5.0k", "87–101%", "5 to 9 days") share currency, scale and unit between their ends; spelled-out
  numbers from "two" up; dates; "week N"; quarters. Each must match a fact:
  - *Kind*: money only money, in the report's currency; % only shares; percentage points only points; days also
    hours converted at hours-per-week ÷ 5. Plain numbers, hours, days and weeks are otherwise interchangeable,
    because the engine's own sentences write "falls by 9.7 days (range 1.2–18.2)".
  - *Rounding*: the figure rounded at the precision written (`|written − fact| ≤ ½ step`, plus half the fact's own
    step when the fact is itself printed text), never more precise than the fact is known to ("£4,213" is refused
    when the facts only say "£4.2k"), and not coarser than two significant figures unless written in whole units
    ("£4k" for £4,213 is refused; "3 clients" for 3.4 is fine).
  - *Sign*: a written sign must agree with the fact's; an unsigned number is compared by size ("falls by 9.7 days").
    Words carry direction; the check can't read them, so the prompt insists and a reviewer reads the text.
  - *Dates and periods*: dates only if they are in the facts (day, month and year where written); a bare year only a
    fact date's year; "week N" only a week count in the facts (the horizon); quarters ("Q3") never.
  - *Not figures*: percentile labels (P10/P50/P90, "10th–90th percentile") and digits inside names the facts give
    (a scenario called "Hire 2 people"). *Refused outright*: multiples and fractions in words ("twice", "doubles",
    "half") and vague number words ("hundreds", "a dozen"), which state things nobody computed.
  - The facts are every string and number in the payload read with the same tokenizer (so each is known to the
    precision printed), plus the raw means and range ends behind them (so "£33,005" passes too). The templated text
    passes its own check (tested), so the fallback is always printable.
- **Retry and fallback** (`narrate.ts`). Draft; check; on any failure, one redraft whose instruction lists each
  failing number with its reason and quotes the rejected draft; then the template. Timeouts: 45 s a draft, 75 s for
  both, which with robustness (120 s) and printing fits the report route's 300 s. A refusal, timeout, API error, bad
  JSON or a draft with no or too many paragraphs (over 8, or 6,000 characters) also falls back. The outcome carries
  `validated`, `fallback`, the kind and the reason in words.
- **Cache and record** (`narrations`, migration `20261020000000_narration.sql`). One row per workspace, target
  (`run`), target id (the report's run), purpose (`summary`/`explain`) and input hash (SHA-256 of the payload and a
  prompt version), upserted with the text that printed, `validated`, `fallback`, `fallback_kind`, `fallback_reason`,
  the rejected drafts and their problems, the numbers checked, token usage, the model, and `edited_by` /
  `edited_by_name` / `edited_at`. The hash covers the chosen scenarios and sections, so "cached per run" means per
  run and question. A cached narration is used only after it passes the check again (a hand-edited row can't smuggle
  in a figure); a cached "invented twice" fallback is reused (redrafting would cost money and likely fail again)
  unless the caller regenerates; a timeout or API error is retried next time. A workspace may draft 60 a day
  (`NARRATION_DAILY_LIMIT`). RLS: summaries are read by editors only (they can name people with utilisation);
  explanations by anyone in the workspace; editors write; `edited_by` must be the writer.
- **On demand only.** Nothing narrates when a run is made. The report builder has a "Narrated summary" option (on by
  default when the key is set; `narrate` is false by default on the API and MCP), a stored report's summary page
  has "Draft with Claude"/"Redraft", and a saved run's page has "Explain this run" (editors draft; everyone reads the
  cache). `POST /api/narrate` serves both actions as the signed-in user.
- **Edits.** The report's summary page (`/w/<slug>/reports/<id>`) edits the summary: the text is checked the same
  way (real names allowed), saved with `editedBy` / `editedAt`, recorded on the narration row it came from (so the
  next report of the same run reuses it), and the PDF is re-printed. The appendix says which summary printed ("drafted
  by claude-opus-5-5 on …; all N numbers in it matched those figures", or "templated text …; a narrated summary was
  asked for but not used: <reason>"), and "Edited by <user> on <date>; the edit was checked the same way". The
  methodology's last paragraph says whether a language model wrote the summary, and a line under the summary says who
  drafted and who edited it. Because narrating or editing a stored report re-prints its PDF, `/api/narrate` and the
  summary page (`/w/[slug]/reports/[id]`, whose Server Action saves the edit) ship Chromium like the other printing
  routes (`outputFileTracingIncludes` in `next.config.ts`).
- **MCP.** `export_report` takes `narrate` (Claude injected by the web app's MCP route) and `summary` (paragraphs to
  print instead, checked like an edit; any figure not in the report refuses the export, naming it), and returns
  `summary_source` and `narration {used, cached, model, checked, fallback_reason}`.
- **Demo.** `/demo` is public, so it never calls the API: a deterministic stand-in writer composes prose from the
  same payload and goes through the same check, labelled as a stand-in wherever it prints. The demo builder loads,
  edits and checks the summary before printing ("edited by Demo visitor"); the demo's saved runs have "Explain this
  run" with the stand-in.

## Consequences

- A figure the engine didn't produce can't print, whoever wrote it: Claude, a person, or MCP. The cost is some false
  rejections (an honest paraphrase that computes a difference, a spelled-out number); those fall back to the
  template, which always passes.
- The check can't read meaning: "rises by 9.7 days" with a fall of 9.7 passes, as does attributing a correct number
  to the wrong metric. The prompt forbids both, the draft is shown before export, and the appendix names the model.
- Cost is bounded: at most two requests of ~3–5k input tokens (the second mostly cached) and ~1–3k output tokens per
  narration, about $0.05–0.15 at Opus 5.5 prices, cached per run and question, capped at 60 a workspace a day.
- The privacy page names Anthropic as a service provider and now says what narration sends and what it doesn't.
- `claude-opus-5-5`, the beta header and the `fallbacks` parameter are verified only against the SDK's types and a
  fake `fetch` in tests; the first real call happens on a deploy with the key (docs/supabase-notes.md).
