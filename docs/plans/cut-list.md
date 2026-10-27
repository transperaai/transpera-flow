# Cut list and changes from Austin's QA

Started 27 Oct 2026 during QA of the Neon preview. These changes are built **after the cutover** to Neon, as small PRs to
`main` (agreed 27 Oct). Each item gets a brief before it's built.

## Decided

1. **Remove all in-app AI.** Data is queried from outside, by connecting Claude or ChatGPT through MCP.
   - Remove the **Analyse** button and AI findings (process pages and the Overview).
   - Remove **Explain this run** (narration).
   - Remove **Settings → AI analysis**, the app's Anthropic calls, and the need for `ANTHROPIC_API_KEY`.
   - Remove anything else connected to in-app AI: the "AI" marks, AI cost lines and AI tables, after a data decision.
2. **Remove the Suggestions page (Austin: 1b). MCP becomes read-only for company data.** Claude can query and report;
   changes to people, clients, services, demand and company settings are made in the app.
   - Remove the MCP company-model write tools (`set_company`, `upsert_service`, `upsert_person`, `upsert_client`,
     `set_demand`) and the suggestion tools (`list_suggestions`, review).
   - Remove the MCP finding proposals (B20) and the AI solution ideas.
   - Remove the share-link "Try your own changes → send an idea" submission (visitor proposals). Whether the play
     sandbox itself stays is still open (below).
3. **Findings are removed; issues are logged directly (Austin: 2b).** An issue is created by a person, by hand.
   - Remove findings (`public.findings`), "findings by hand" and the accept/dismiss step.
   - Keep the engine's **facts** as read-only evidence on pages.
4. **The forecast becomes a full sandbox.** It keeps working as a simulator and gets every kind of lever: market,
   personnel, lead volume and others: scenarios with whole-run and timed changes, saved, run and compared. Design draft:
   `docs/plans/sandbox-design.md`.

## Open questions

- **MCP and processes.** Item 2 makes MCP read-only for *company data*. Should MCP still be able to:
  - draft process changes (`import_process`, `add_step` and the like write drafts that someone publishes in the app)?
  - add sources?
  - log issues?
- **Existing data.**
  - Production has AI analyses and findings.
  - Some findings are accepted but not yet issues: should they become issues, or be dropped?
  - Should the AI text be kept, read-only, or deleted?
- **Share-link play sandbox.** Without "send an idea", should play links stay (visitors try levers, nothing is saved),
  or go?

## Forecast sandbox: brainstorm notes

What the engine and data already model, so it's a starting point for the levers:

- **Market:** market conditions and their schedule, seasonality, churn drivers.
- **Lead volume:** lead sources and demand settings (volume, growth per month).
- **Personnel:** hires, leave, FTE, roles, skills, rates, and capacity factors per person.
- **Process:** the existing process levers (Settings → Levers) and solutions going live from a month.
- **Commercial:** services, pricing and client mix.

To decide together: which levers the sandbox shows, whether changes are set per month on the timeline or as one
scenario, how scenarios are saved and compared, and what it shows (revenue, clients at risk, utilisation, waits).
