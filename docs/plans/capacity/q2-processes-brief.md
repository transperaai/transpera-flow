# Q2: Processes page and process page fixes from Austin's QA (2 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q2-processes`, from `claude/relaxed-babbage-51ysen`.
No migration expected.

**In parallel:** Q1 is changing the Overview and the company map's playback controls (expand, fit, stop, speed,
horizon, History link from the Overview). Don't change those controls. Item 4 below touches the Overview's map canvas,
so keep that change small, and expect to merge Q1 when the orchestrator says it has landed.

## Changes

1. **Process page header: just the version.** Replace "Viewing live · version N" with "Version N". A draft-only process
   keeps a short "Draft, not published yet".
2. **"About this process":** remove the "On the company map", "Sources" and "Last published" rows. The Version row
   shows only the number ("7"). Remove anything that only fed those rows. Hidden Sources (P0) stays reachable by URL.
3. **Remove the servicing process box** (`servicing-banner.tsx`, "Servicing process. Run by … every … SLA …") from the
   process page. Where the services and recurrences are set (Set up and Settings) is unchanged.
4. **Swimlanes on the Overview's company map.**
   - The company map in the editor shows swimlanes; the Overview's company map preview doesn't. Find why (most likely
     the read-only canvas isn't given the lane data, or doesn't render it), and render the same lanes on the Overview.
   - Check the process page's read-only map at the same time: it should show its lanes too.
   - Add a browser test that the lanes are present.
5. **Company map history and versions from the Processes page.**
   - The Processes page's "Company map" button goes to the Overview. Keep that.
   - Add a "History" button for the company map beside it, styled like the others, opening the company map's version
     history (`/p/<companyMapId>/history`). Reuse whatever the Overview's History button opens; Q1 is fixing that link.
   - If the company map has no history page of its own, say so and stop on this item.
   - Also make sure "✎ Edit company map" is visible to the Owner and Agency admins whenever something is published, not
     only for an empty workspace, so a new company map version can be made: edit → draft → Publish.
   - Report how publishing a company map version works today, in two or three plain sentences, for Austin.

## Don't change yet (Austin is deciding)

- The Rating column on the Processes page.
- Process types ("Sales pipeline" / "Client work").
- "Worth adding for capacity".
- The Supporting data panels.

## Done when

- `pnpm lint && pnpm typecheck`, the process page, processes page, editor and map browser tests, and the web build pass.
- Screenshots of a process page and the Overview map with lanes, at 1440 px, saved under `docs/plans/capacity/q2-shots/`.
- The report covers each item, with item 4's cause and item 5's explanation.
