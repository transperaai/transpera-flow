# 15. Analysis: engine facts as evidence, AI findings on demand, findings by hand

Date: 5 Oct 2026 · Status: accepted · Issue: #175 (B17) · Decision D40 (replaces D35 and D36) · Amends ADR 0013 (when AI runs, what it writes)

## Context

The rules (docs/analysis-rules.md) turned run results into rated insights directly, and AI added its own beside them
after each publish (ADR 0013). In QA Austin found the rule-made findings hard-coded and predictive rather than an
assessment of what is actually wrong, and he wants to add his own findings.

## Decision

- **Facts are evidence.** The engine's rule results are shown on every process page ("Facts from the run") and on the
  Overview (each process's row, and "Across the company") as read-only evidence: nobody acknowledges or dismisses a fact,
  and none reaches the map. They are computed live in the browser as before, rated with the documented defaults
  (`apps/web/src/lib/analysis/defaults.ts`). They are never stored.
- **Findings** (`public.findings`, migration `20261205000000`) are what AI or a person concludes: a rating, a kind, where
  it sits (a process, or `process_id` null across the company, optionally a step), a title, what was found, why it
  matters, and the facts and quotes it rests on (`facts`, as they read when cited). `origin` is `ai` or `manual`; `status`
  is `proposed`, `accepted`, `dismissed` or `superseded`. Only accepted findings are listed; acknowledging one as an issue
  stores the issue with `detected_key = 'finding:<ai|by_hand>:<id>'`, so the existing insight list, Acknowledge dialog,
  map feed and D38 work unchanged.
- **AI runs on demand only.** "Analyse" on a process page analyses that process's live version; "Analyse" on the
  Overview analyses the company model (the pipeline the Overview simulates, with every process it runs beside) against
  the pipeline's first principles, stored against the company map's process. Both are Server Actions
  (`app/w/[slug]/ai-actions.ts`) running as the signed-in user. The publish and market triggers are gone, with their two
  switches (the columns stay).
- **Each finding cites facts.** The model is sent each fact with an id made of letters only (`fact-a`, `fact-b`: no digit
  can pass the number check as a figure) and each quote with one (`quote-a`). Its output gives each insight `facts: [ids]`;
  unknown ids are ignored, and a finding that cites none of the facts when the run has some is dropped like one that
  cites an invented number (`lib/ai/analyse.ts`). Every number is still checked as ADR 0011 and 0013 say.
- **Cached until what it read changes.** An analysis is stored with `model_hash`, two parts joined by a dot
  (`lib/ai/model-hash.ts`): the base, a SHA-256 the server works out of the engine model built at a fixed start date (so
  the calendar doesn't change it), the first principles, the scope, the prompt version, the Anthropic model id, the
  "AI reads sources" switch and, when it is on, every source citation on the model's steps (source id and quote); then
  the run's facts, digested by key and rating (`lib/ai/facts-digest.ts`, browser-safe; the page's own perception gaps,
  broken scenarios and forecast facts are left out, so the page and the server digest the same list). Pressing Analyse
  while both parts are unchanged returns the stored analysis without reserving or calling the model; **Analyse again**
  passes `force` and runs anyway, still through `reserve_ai_run`. The pages load the latest analysis of the process (any
  version) and mark it **out of date** once the base differs (the server) or the facts do (the browser, once its run is
  in). Rows from before have no hash and are compared by version.
- **Names are not saved (B1 2b, migration `20261207700000`).** An AI finding's text, like the analysis's, is stored as the
  model wrote it, with labels ("Team member A"), and `findings.person_labels` says which person each label is (`{}` for a
  finding by hand). The names go back when a page or the connector shows it, for each reader as ADR 0003 says. An editor who
  edits an AI finding sees names; `editFinding` turns them back into labels before storing, and stores a field exactly as it
  was when the editor didn't change it, so saving without a change doesn't mark the finding edited. A name an editor types
  that wasn't in the finding is human-typed text and is stored as typed. AI also reads a pay-free model, so its facts say
  "—" for a cost that needs a person's rate. The analysis hash (`model_hash`) reads neither names nor pay, so an owner's page
  and a member's agree on whether an analysis is out of date.
- **Cost bound** as ADR 0013: every model call first reserves a run (`reserve_ai_run`: 40 a workspace in 24 hours, one a
  minute per process; the company counts as the company map's process). The panel shows the model and an estimated cost
  from the stored token usage at list prices (`lib/ai/cost.ts`), "about $0.06".
- **Review.** An analysis's insights are stored as proposed findings citing it and the run that wrote it
  (`storeProposedFindings`; `findings.run_id`, since an analysis is kept one per version and a second run on the same
  version keeps its id). A key a person decided (accepted or dismissed) is left alone; a key still proposed, or
  superseded, is proposed again with what this run wrote; an AI insight acknowledged before B17 (`ai:insight:<hash>` on
  an issue) isn't proposed again; and the proposals of the same scope that an earlier run made and this one didn't are
  superseded. A superseded proposal can't be accepted or dismissed. Owners and editors accept, edit ("Save and accept")
  or dismiss them from the analysis panel, where each one's cited facts open under it before Accept; viewers see only
  that some are waiting.
- **Forgery and honesty.** The trigger stamps who and when, starts an AI finding proposed and requires it to cite an
  analysis the writer stored in the last 15 minutes and that analysis's run; a finding by hand starts accepted. The facts
  an AI finding cites never change after it is written (only a later run proposing it again replaces them), and when a
  person changes what an AI finding says, the trigger sets `edited`, so the page labels it "AI, edited" and says its
  edited words weren't checked. Every source a finding cites must be one of its workspace's. As ADR 0013 says, an editor could still write
  AI text through PostgREST after running an analysis; the database can't check the words.
- **Rules editor removed.** Settings → Analysis rules, its demo page and nav item, the editing helpers and the demo
  store are deleted. Every page passes the defaults; `analysis_rules` rows stay, unread. The MCP `list_issues`
  detections use the defaults too.
- **The connector** gains `get_facts`, `list_findings`, `get_analysis`, `list_sources` and `list_solutions`, so Claude
  outside the app can read everything an analysis reads (with `get_process`, `run_scenario`, `list_issues` and
  `get_first_principles`). Each is bounded: facts worst first up to a limit (40 by default) with sentences trimmed;
  findings and sources a page at a time (50 by default) with the total and the next offset; solutions without their
  copied maps.

## Consequences

- A workspace that had changed its cut-offs now sees the defaults' facts. Preflight before deploy:
  `select workspace_id from analysis_rules where settings <> '{}'::jsonb` lists who is affected.
- Insights acknowledged before B17 are kept: they are issues, and the finding list shows them (costed by the live fact
  while the run still finds it). Unacknowledged rule insights are not converted: they are the facts now.
- AI findings carry no cost per month of their own (a finding is a judgement); the facts it cites show theirs.
- An analysis runs only when someone asks, so a page can show an out-of-date analysis until someone does.
