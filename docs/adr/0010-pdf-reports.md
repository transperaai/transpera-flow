# 10. PDF reports: one HTML document, printed by headless Chromium, stored in Postgres

Date: 30 Sep 2026 · Status: superseded: reports, the PDF route and `export_report` were removed in A32 (#97); the `robustness_results` table stays; the `reports` table and `report_download` were dropped 28 Oct 2026 (`20270101000000_drop_in_app_ai.sql`), unread since A32 · Issue: #28 · Implements PRD §9 "PDF", §7.1 `export_report`, §6.5, D2, D15

## Context

The report is the handover: cover, executive summary, company map, each process map with bottleneck callouts, client
health, issues by severity, scenario comparisons with ranges, utilisation, robustness, the evidence appendix and a
methodology page. It must be generated from the app and from MCP `export_report`, stored, and handed over as a signed
URL; the browser's "Save as PDF" is the fallback. It runs on Vercel (Pro, fluid compute: 300 s default, 250 MB
unzipped function bundle). The numbers must be reproducible from a saved run and every sentence templated (narration
is #29). The MCP server acts as the user through the Data API only (ADR 0002): no service-role key, and Storage doesn't
honour API tokens.

Options for the PDF:

- **Headless Chromium (`puppeteer-core` + `@sparticuz/chromium`) printing an HTML page.** What the PRD decided (§9,
  §10). One document serves the PDF and the browser print. SVG maps and charts stay vector. About 64 MB of brotli
  Chromium in the function; a cold start unpacks it to `/tmp` (1–2 s); printing takes a second or two.
- **A pure-JS PDF library (`@react-pdf/renderer`, pdf-lib).** Small and fast, but a second layout engine: the browser
  fallback would be a different document, and every table, chart and map would be drawn twice.
- **Browser print only.** No server cost, but no stored PDF and nothing for MCP to hand back.

## Decision

- **Content first.** `buildReportContent` (apps/web/src/lib/report/assemble.ts) runs the engine for the run (seed,
  replications, start date), one paired comparison per chosen scenario, the shadow price and the robustness checks,
  and returns `ReportContent`: every number (raw means and 10th–90th percentile ranges) and every sentence (the
  engine's templates and `summary.ts`). Pure and deterministic given its input and clock; unit tested against the run.
- **One HTML document.** `renderReportHtml(content)` (render.ts) is a string template with a print stylesheet: A4,
  `break-inside: avoid` on tables, figures and cards, repeated table headers for long tables, page numbers and a footer
  from `@page` margin boxes. Process maps are SVG drawn from the steps' saved canvas positions (svg.ts), not
  screenshots. The server prints exactly this string; `/w/[slug]/reports/[id]/print` serves exactly this string with a
  screen-only toolbar, so the fallback is the same document by construction. It is a string rather than a React tree
  because Next's server bundles don't allow `react-dom/server`, and because the PDF function then needs no React at all.
- **Chromium via `puppeteer-core` and `@sparticuz/chromium`** (pdf.ts), `page.setContent` then `page.pdf` with
  `preferCSSPageSize`. `CHROMIUM_PATH` (or an explicit path) points at a local Chrome for development and tests. Both
  packages are on Next's built-in `serverExternalPackages`; `outputFileTracingIncludes` ships
  `@sparticuz/chromium/bin` with the three routes that print (`/api/reports`, `/api/mcp`, `/demo/report/pdf`): about
  75 MB traced per function. The glob names the package's real directory (resolved in `next.config.ts`, under
  `node_modules/.pnpm`), because that is where the package looks for `bin/`; a glob through pnpm's
  `apps/web/node_modules` symlink shipped the files somewhere Chromium never looked (production 500s, fixed on
  `fix/pdf-on-vercel`). `outputFileTracingRoot` is the monorepo root. Web fonts load from Google Fonts with a 4 s cap; the fallback stack prints otherwise (the
  serverless Chromium ships Open Sans).
- **A failed print is never an empty 500.** `htmlToPdf` throws a `PdfError` naming the stage (`launch`: unpacking or
  starting Chromium; `print`) with a one-line reason (pdf-failure.ts); the full error goes to `console.error` for the
  function logs. `/demo/report/pdf` answers with a 500 that says why and links the printable report (a page for a
  browser, JSON otherwise). `POST /api/reports` and MCP `export_report` still store the report and return `pdf: false`,
  the reason and the printable report's URL (`printUrl` / `print_url`, plus `pdf_fallback` for MCP).
- **Reports come from a saved run.** Either a new run of the live model (saved to `runs` with its snapshot, 200
  replications by default) or a saved run whose model is unchanged (`changesSinceRun` is empty) and which re-runs to the
  numbers it saved (`sameResults`); otherwise generation is refused with the reason. The run's id, seed, replications,
  engine version and revisions print on the cover, the appendix and the methodology page.
- **Robustness runs on the server for every included scenario** (PRD §6.5: "automatically on PDF generation"), time
  capped at 120 s together, and is **cached job by job in `robustness_results`** under the engine's own job keys. The
  whole check is loaded before it runs (the engine's cache is synchronous) and new jobs are saved after, so an
  unchanged model and scenario cost nothing and a check cut short resumes next time. A capped check says so in its
  verdict.
- **Stored in Postgres, not Storage.** `reports` keeps the content (JSON) and the PDF (`bytea`, up to 20 MB). Writes
  and reads go through the Data API as the user, so the web app and MCP (API tokens, ADR 0002) share one path and RLS
  decides. Reports hold per-person utilisation, so only editors, owners and agency admins read them (PRD §2).
- **Signed URL = a random 256-bit token**, base64url, whose SHA-256 is stored on the report with an expiry (24 h by
  default, 7 days at most). `/api/reports/[id]/pdf?token=…` exchanges it through `public.report_download(token)`, a
  narrow security definer function that returns one report for one live token (granted to `anon`); the proxy lets that
  path through without a session. Making a new link replaces the old one. `format=json` returns the content.
- **One pipeline, two doors.** `generateReport` (server.ts) serves `POST /api/reports` (the signed-in user) and MCP
  `export_report` (the token's user; the web app injects it into the MCP server as a `ReportExporter`, since the
  renderer lives in the app). Both functions allow 300 s.
- **Narration slots in later (#29).** `content.summary` is `{source: "template" | "narration", paragraphs, editedBy}`;
  `reportFacts(content)` lists every number the report states for the validator; the appendix's provenance line
  already says which kind of summary printed and who edited it. Branding (#34) sets `content.branding` (accent, logo).

## Consequences

- The PDF and the printable page can't drift apart; changing the report means changing `render.ts` once.
- A report is a frozen document: re-opening it never re-runs the engine, and it survives later model changes and the
  deletion of its run (`run_id` is set null).
- Postgres holds the PDFs: about 0.3–1 MB each, so a thousand reports is under a gigabyte of the Pro plan's 8 GB. If
  that grows, move `pdf` to Storage behind the same download route without changing the link format.
- PostgREST carries the PDF as hex (twice its size) on upload; a 20 MB cap on the column keeps requests sane. Supabase's
  request size limit and the Chromium bundle on Vercel are verified only on a preview deploy (docs/supabase-notes.md).
- Anyone holding a link can read that report until it expires; links are for handing over, not access control.
