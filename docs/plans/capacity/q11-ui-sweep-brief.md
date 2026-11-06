# Q11: one look across the app, on the page kit (Austin, 6 Nov)

Read `docs/plans/capacity/README.md` first. No migration.

Austin: the UI is inconsistent across the app. Q8 (process page), Q9 (Issues list) and Q10 (issue page) built and use the
shared page kit in `apps/web/src/components/page-kit/`: `PageHeader`, `MetaLine`, `SectionCard`, `Toolbar` (with
`ToolbarSearch`, `FilterMenu` and `ClearFilters`), `StatusPill`, `StatusPillMenu`, `EmptyState`, `Timeline` and
`EditableText`. This sweep moves every other page onto it, so every page reads the same way:
- a `PageHeader`: title, pills, a meta line, actions on the right as one button group;
- then `SectionCard`s, in reading order;
- toolbars above lists;
- `EmptyState`s for anything empty, and no grey text in dashed boxes;
- the same button sizes and variants, the same pill component, the same spacing.

Three builders run in parallel, one per group. Each builder:
- changes only its own pages' files;
- uses the kit as it is. If it needs a new kit component, adds it as a **new file** in `page-kit/` and exports it from
  `index.ts`. Never changes an existing kit component's props or look: those are shared.
- keeps every feature, server action, `data-*` hook and help (i). Updates tests to the new structure without loosening
  what they assert.
- takes before and after screenshots at 1440 px light and dark and at 400 px light, under
  `docs/plans/capacity/q11-shots/<group>/`.
- runs `pnpm lint && pnpm typecheck`, the tests of its pages (browser tests included), and the web build.

## Group A, branch `claude/cap-q11a-dashboards`: Overview, Capacity, Sandbox

- **Overview:** page header (title, "Last updated · N processes", actions). The whole-business row, department cards,
  company map, What the time achieves and Team load each become `SectionCard`s, with consistent card titles.
- **Capacity:** page header, then each widget as a `SectionCard` with its sentence first and "How this works" folded,
  in the same style.
- **Sandbox:**
  - page header;
  - the company processes panel, levers and results as `SectionCard`s;
  - the lever groups with consistent headings;
  - the changes list as kit rows;
  - the "What happens" verdict as the first result card.

## Group B, branch `claude/cap-q11b-setup-settings`: Set up and Settings

- **Set up → Tiers & clients** and **Set up → People & roles:** page header, each table in a `SectionCard` with its
  `Toolbar` (add buttons on the right). Notes as muted lines, not floating paragraphs.
- **Settings and every subpage:** Workspace, Simulation, Demand, Market, Churn drivers, Health, Access, Branding, Change
  log, Purposes, Calibration and any others under `app/w/[slug]/settings/**`.
  - Each gets a page header, and its sections become `SectionCard`s.
  - The Settings index lists its subpages as tidy link rows or cards, not a loose button row.
- **The account's** `/settings/tokens` page too.

## Group C, branch `claude/cap-q11c-improve`: Solutions, Blocks, History, and the leftovers

- **Solutions list:** page header plus a `Toolbar` (search, a Status filter using Q10's solution status, a Process
  filter). Rows with `StatusPill`.
- **Solution page:** the rest of the page as `SectionCard`s under Q10's header (maps, measures, verdicts, linked issues).
- **Block library and block page:** page header, cards, `EmptyState`.
- **History pages** (process and company map): page header, versions as kit rows or a `Timeline`.
- **Issue page right column** (Target, Linked to, Sources): `SectionCard`s with the kit's title style, replacing the
  small uppercase headings.
- **The map card on the issue page:** height fits a short map, with no large empty space.
- **Process page "Other improvements":** its "Nothing else yet" dashed box becomes an `EmptyState`. Do this inside
  `solution-cards.tsx` if that's where it lives, so every page that uses it gets it.
- **The Editor's own chrome** (top bar, side panels): match button sizes and variants only. Don't restructure it.
- **Hidden Sources page:** page header and cards only.

## Done when (each group)

The checks above pass. The report lists each page changed, any new kit component, and anything left as is with the
reason.
