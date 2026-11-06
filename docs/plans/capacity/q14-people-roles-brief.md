# Q14: Set up → People & roles, redesigned (Austin, 6 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q14-people-roles`, from `claude/relaxed-babbage-51ysen`.
No migration.

Austin:
- the fields aren't standardised: some fields are hard-coded for some roles and missing for others, one line apart;
- the lists scroll sideways;
- it's information overload.

Redesign `app/w/[slug]/setup/people` and its components on the page kit. Keep every field and every save. The change is
how they're arranged, not what's stored.

**In parallel:** Q13 is changing Set up → Tiers & clients. Stay on the People & roles page. If you need a change in a
shared Set up component, keep it small and backwards compatible.

## Layout

1. **Page header** (kit): "People & roles", a meta line ("27 people · 10 roles"), and actions: "+ Add person" and
   "+ Add role".
2. **People card.** One standard row for **every** person, with the same columns for everyone:
   - name (with a title line);
   - role;
   - department;
   - hours a week;
   - team time %;
   - salary a month (hidden whole when pay is hidden);
   - label (contractor or offshore).

   - No column exists for only some roles. No sideways scrolling at 1440 px. At 400 px the row collapses to name,
     role and a chevron.
   - A `Toolbar` above: search, a Role filter, a Department filter.
   - Clicking a row opens the **person panel**: a side sheet on desktop, full-screen on a phone. It holds all that
     person's fields, in groups:
     - **Basics:** name, email, role(s), department (read from the role), hours, team time, speed, salary, label.
     - **Clients:** only for client-facing roles. Tiers they serve, portfolio count per tier, their named clients
       (read-only, linking to Tiers & clients). Add a one-line note: "Only people in client-facing roles look after
       clients."
     - **Time:** start and end dates, leave, own ramp.
     - **More:** skills, per-step speeds, notes. Whatever today's `PersonMore` holds.

     Edits save as they do today.
3. **Roles card.** One standard row per role:
   - name;
   - department;
   - kind (client-facing or shared team);
   - busy line %;
   - people count.

   The role panel holds the rest: rule of thumb (client-facing only), unit (shared teams only), leadership flag, and
   today's `RoleMore` fields.
4. **How the shared teams work:** one compact card listing each shared team, with its unit and rate status ("Rate not
   entered yet", D35).
5. **Advanced (folded, at the bottom):** the DLER "directors and managers count" switch, with its "to confirm" tag and a
   one-line explanation, and the ramp-up default, with a one-line explanation ("How much a new starter can carry in
   their first three months; used for future start dates and Sandbox hires.").

## Rules

- Use the kit (`PageHeader`, `SectionCard`, `Toolbar`, `ListRow` or a kit-styled table, `EmptyState`) and the existing
  Sheet or Dialog primitives for the panels.
- Keep `data-*` hooks and help (i) text. Update tests to the new structure without loosening them. Viewers see
  everything read-only, and pay-hidden rules still hold.

## Done when

- `pnpm lint && pnpm typecheck`, the setup and people tests (browser ones included), role gating and person privacy,
  and the web build pass.
- Screenshots of the page and a person panel (client-facing and shared-team person) at 1440 px light and dark, and at
  400 px, under `docs/plans/capacity/q14-shots/`.
