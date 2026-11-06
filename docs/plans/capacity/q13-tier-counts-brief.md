# Q13: client counts per tier, typed in, with a discrepancy check (Austin, 6 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q13-tier-counts`, from `claude/relaxed-babbage-51ysen`.
Migration range `20270130000000`–`20270130009999`, if needed.

**Today** (P1), a tier's client count is worked out, not entered: named clients on the service + the sum of everyone's
`person_portfolio` for it + `client_groups.client_count` (counted clients nobody holds). Austin wants to type the count
per tier directly, and to be warned when the numbers don't add up.

## Changes

1. **A typed count per tier.**
   - In Set up → Tiers & clients, each department's tier table gets an editable **Clients** cell.
   - It stores the tier's **total** clients. Recommended: a new `services.client_total int null`, where null means
     "worked out as today". Store it with provenance like the other tier fields.
   - When it's set, the unassigned counted clients are `total − named − sum(portfolios)`. That's what the engine gets
     as the group's unassigned remainder, through P2b's mapping in `packages/db/src/capacity-model.ts`.
   - When it's not set, everything works as today. Existing workspaces and the snapshot tests must not change.
2. **A discrepancy check.** For each tier service with a typed total:
   - **"Over":** named + portfolios > total. "Portfolios and named clients add up to 46, but the tier has 40 (6 too
     many)."
   - **"Unassigned":** total > named + portfolios. "12 clients aren't in anyone's portfolio." This is informational,
     not an error.
   - It shows on the tier row as a small warning pill, with the sentence in a tooltip or inline.
   - It's also listed in `missingForCapacity`, so it appears on Capacity and the Overview's missing list. "Over" is a
     warning; "Unassigned" is a note.
   - **In the engine mapping,** "over" uses the portfolios as they are, with no negative remainder, and says so in the
     check.
   - **People & roles:** the portfolio columns show the same pill beside the tier's column total.
3. **Tests:**
   - the mapping with and without a total, and unchanged models when it's unset;
   - both discrepancy kinds, with their wording;
   - the Set up page edit through the browser;
   - bundle and restore carry the column;
   - `copy-from-supabase`.

## Done when

- `pnpm lint && pnpm typecheck`, the setup, capacity-setup, capacity-model and capacity page tests, `copy-from-supabase`
  and the web build pass. Goldens are unchanged.
- Screenshots of Tiers & clients with one tier over and one with unassigned clients, under `docs/plans/capacity/q13-shots/`.
