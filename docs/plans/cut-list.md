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
   - Remove the share-link "Try your own changes → send an idea" submission (visitor proposals). The play links
     themselves stay (item 7).
3. **Findings are removed; issues are logged directly (Austin: 2b).** An issue is created by a person, by hand.
   - Remove findings (`public.findings`), "findings by hand" and the accept/dismiss step.
   - Keep the engine's **facts** as read-only evidence on pages.
4. **The forecast becomes a full sandbox.** It keeps working as a simulator and gets every kind of lever: market,
   personnel, lead volume and others: scenarios with whole-run and timed changes, saved, run and compared. Design draft:
   `docs/plans/sandbox-design.md`.

## Decided 28 Oct (Austin)

5. **MCP is fully read-only.** Claude or ChatGPT can query everything, but no MCP tool writes. That removes:
   - process drafts (`import_process`, `add_step`, `update_step` and the rest of the building tools, plus the extraction
     skill's write path);
   - `add_source`;
   - `log_issue` and the other issue writes;
   - `set_active_workspace`, which only stores a preference on the token, stays.
6. **Existing AI data is dropped completely:** AI analyses, AI findings (accepted or not), AI runs, narrations, the AI
   settings, and their tables. Nothing is converted into issues.
7. **Share-link play links stay.** Visitors try levers on a link and nothing is saved. Only "send an idea" goes
   (item 2).
8. **Sandbox:** profit comes early (phase 2), and the default purpose categories are fine for now. See
   `docs/plans/sandbox-design.md`.

9. **Three roles replace all of today's roles (Austin, 28 Oct).** They replace both the sign-in roles (Admin, Editor,
   Viewer) and the per-workspace roles (owner, editor, member, viewer).
   - **Owner:** Austin, in every client's deployment. Everything, including deployment settings and anything technical.
   - **Agency admin:** the client's founder and head of CS.
     - Edits processes, people, clients and issues.
     - Uses the sandbox and saves scenarios, and creates share links.
     - **Manages who can sign in**: adds and removes viewers and agency admins.
     - **Sees individual pay rates.**
   - **Viewer:** everyone else at the client.
     - Reads everything except individual pay (B1 privacy stays for viewers).
     - Runs saved scenarios but can't save them.

   This goes with the strip of the multi-tenant machinery (rework-direction decision 1). Existing memberships map like
   this:
   - agency admin flag → Owner;
   - owner or editor → Agency admin;
   - member or viewer → Viewer.

## Forecast sandbox: brainstorm notes

What the engine and data already model, so it's a starting point for the levers:

- **Market:** market conditions and their schedule, seasonality, churn drivers.
- **Lead volume:** lead sources and demand settings (volume, growth per month).
- **Personnel:** hires, leave, FTE, roles, skills, rates, and capacity factors per person.
- **Process:** the existing process levers (Settings → Levers) and solutions going live from a month.
- **Commercial:** services, pricing and client mix.

To decide together: which levers the sandbox shows, whether changes are set per month on the timeline or as one
scenario, how scenarios are saved and compared, and what it shows (revenue, clients at risk, utilisation, waits).
