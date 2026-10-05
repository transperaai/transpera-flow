# 13. AI analysis: AI reads the run, a number check decides what is kept

Date: 1 Oct 2026 · Status: accepted, amended by ADR 0015 (B17: AI runs only on demand and writes proposed findings citing facts; the publish and market triggers are gone) · Issue: #111 (A46) · Builds on ADR 0011 (narration), PRD §7.3 and §8, D15, docs/analysis-rules.md "What AI does", docs/research/first-principles.md Part B

## Context

The rules (docs/analysis-rules.md) find what the numbers say. A person who has written down what a process is for (its
first principles, A54) wants the results read against that: "the job is a kickoff call in the diary, and work waits six
days for the proposal". That is judgement, so a language model writes it. But "the engine produces all numbers" (PRD §3,
D15), and ADR 0011 already decided how a model is held to that: every number in its text is matched against the run
before the text is shown.

## Decision

- **What it writes.** One analysis per process version: the **AI read** (up to three paragraphs), up to eight **AI
  insights** (title, type, a suggested rating, a step, evidence, why it matters), and a **review of the first
  principles** (up to twelve findings, each on one of the seven steps). Insights join the existing insight list with
  `origin: "ai"` (A45): they show the "AI" mark, carry the AI's suggested rating and cost "n/a" (AI computes no cost),
  and go through the same Acknowledge and Dismiss. An insight's key is `ai:insight:<hash of its title and step>`, so an
  acknowledged one stays matched when AI runs again.
- **What it is given** (`lib/ai/facts.ts`, `input.ts`). The run's headline results (the report's average-plus-range
  format), the rule findings as the pages list them (same rules, same cost per month, including the absence test and
  the shadow prices), the first principles in the team's words, the first-principles **rule checks** (the engine's
  `firstPrinciplesFlags`, e.g. automation proposed for a step still marked to delete), each success measure with the
  share of runs that meet it, and, only when the workspace switches it on, a few short quotes from the sources cited on
  the steps. People's names become labels ("Team member A") and are mapped back after the check; the workspace name and
  per-person utilisation are never sent.
- **The number check** (`lib/ai/analyse.ts`; the checker is narration's, `lib/narration/numbers.ts`). Every number in
  every item (read, each insight's title, evidence and why, each review finding) is matched against the figures the
  engine wrote: the results, the findings' own sentences, the success measures and their pass rates, the rule checks.
  The first principles' and quotes' own digits are **not** facts (a team's "within 4 hours" can't be restated as a
  figure; its measure can, because the engine wrote "at most 21 working hours, met in 62% of runs"). The rule checks quote
  the team's answers (“We close 93% of leads within 17 days” has no source), so the checked copy of those texts has the
  quoted passages cut out, a measure's name is left out of the checked copy, and so is the name in rule 11's "Goal not
  reliably met: <name>" title. The model still sees all of it. Fractions and ratios in words or slashes ("a third",
  "three quarters of", "3/4", "one in ten", "seven figures") are refused like "half" and "twice". An item with an
  unmatched number is **dropped**, not corrected; there is no template to fall back to. One redraft is asked for,
  naming each dropped item and the figure that failed, and keeps whatever passed in either draft. A quotation in
  quotation marks must be a passage of the words the model was given (a step, an answer, a source's quote), or its item is
  dropped too. If nothing survives, the analysis is stored as failed, with the reason in words. The checks that
  narration's checker cannot make (a number attached to the wrong thing, a rise written as a fall) are not made here
  either; the AI mark and the page's "numbers checked" line say what was and wasn't verified.
- **First-principles checks.** The rule checks stay in the engine and run live in the browser as before. The AI review
  panel (A54's placeholder) shows what the model wrote about the *live* version's answers on the step on screen, after
  reading those rule checks and the run; it is a different set of findings, not a repeat.
- **Model and call.** The model narration uses, `claude-opus-5-5` (the latest per the claude-api guidance as of this
  date, so unchanged), through the same request (`ask` in `lib/narration/anthropic.ts`, still the only module that
  reads `ANTHROPIC_API_KEY`): adaptive thinking, effort `medium`, structured output, `fallbacks: "default"`, the facts
  block cached for the redraft. Tests never call the API: the model is injected and every test uses a fake.
- **When it runs** (`lib/ai/service.ts`, `trigger.ts`). After a publish (the Editor's Publish and MCP's
  `publish_process`), and after the market conditions or their schedule change, each handed to Next's `after()` so the
  person who acted never waits and a failure never reaches them; and on "Run again" (the one run that waits). Each is
  gated by its switch in Settings → AI analysis, except "Run again". Without an API key nothing is simulated or stored,
  and the page says "AI analysis isn't set up". A run skips a version whose facts hash is unchanged and a process with no
  first principles, and the database refuses it past the daily cap or inside the cooldown (above). A market change is
  **debounced**: it records `ai_settings.market_pending_at`, waits 20 s, and only the change whose mark is still in place
  claims it and reviews, so a burst of edits makes one review. The review goes through up to 5 live processes one at a
  time within a 150 s budget (a request has 300 s, a review can take 110 s), logging any it left.
- **Storage** (`ai_analyses`, one row per process revision; `ai_settings`, one row per workspace; migration
  `20261121000000`). The read, insights and review are stored per version, so a page view never calls the model, and an
  earlier version keeps what AI said about it. Every member reads; owners and editors write, **as themselves**: the
  server writes with the signed-in user's own client (the publisher, the settings editor, the person who clicked), so
  there is no service key, and a viewer's request writes nothing. A trigger stamps `created_by` with the caller (it
  can't be forged), refuses an analysis whose `run_id` isn't a run the caller reserved for that process, and nobody can
  delete an analysis or a run; the AI read says "Reviewed by AI · run by <name>". The five switches are written one
  column at a time.
- **Cost bound** (`ai_runs`, `reserve_ai_run`). Every model call first reserves a run in the database: an
  append-only `ai_runs` log that authenticated users can read and cannot write. `reserve_ai_run` is the one
  `SECURITY DEFINER` function (empty `search_path`); it writes no AI content, only counts. It checks `can_edit_workspace`,
  takes a per-workspace advisory lock, refuses at 40 runs in 24 hours for the workspace or a second run of the same process
  within 60 seconds, and otherwise logs the run (with the caller's id and the name of the person linked to their membership in
  People, else null: never an email or user metadata, which any member could read or a user could edit). A run keeps counting
  when its process is deleted (`process_id` is set null; the cap counts by workspace), so deleting processes can't reset it. "Run again" and runs that fail reserve too, so the cap can't be reset by deleting rows, re-running or
  editing. The cooldown also applies to publishes: two publishes of one process within a minute review only the first.
- **Remaining forgery risk.** The server writes the analysis with the user's own credentials, so any editor can write
  arbitrary text into an analysis against a run they reserved, through PostgREST with their own session: the trigger
  stamps `created_by`, and checks the run is theirs, for this process, backs one analysis and is under 15 minutes old, but
  the database can't check the text. It would read "Reviewed by AI · run by <them>". The proper fix is a server-side writer
  holding a service-role key, which needs a production config change (a Vercel secret) and is a follow-up for Austin to
  approve; that writer needs its own branch in the stamp trigger, because `auth.uid()` is null under `service_role`.
  Two switches (suggest issues, suggest solution ideas) are stored now for Suggestions
  (A52) and solution ideas (A49); their (i) says they do nothing yet.
- **Demo.** `/demo` shows text written in advance for the Northbeam sample (`lib/ai/demo.ts`) and "Run again" waits a moment
  and says nothing was sent. A test runs that text through the real number check against the sample's run.

## Consequences

- AI's judgement is only as true as the facts it was given. The number check proves its figures are the run's; it can't
  prove that "the strategist is the constraint" follows. That is why the insights are suggestions that someone acknowledges.
- A stored analysis is trusted when read. Any editor could write one through PostgREST (see the forgery risk above); they can already write
  issues. Unlike narration's cache, it is not re-checked on each page view, because that would need the run (a simulation).
- Reading sources sends interview quotes to Anthropic, so it is off by default (the other four default on).
- Cost is bounded: at most two requests of roughly 5–10k input tokens a version, the second mostly cached, 40 a workspace a day.
- MCP-built processes usually have no first principles yet, so publishing them writes no analysis until someone writes them.
- The AI insights are on the Overview and process pages. The Issues register page doesn't list them until acknowledged.
