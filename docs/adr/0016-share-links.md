# 16. Share links: server-built frozen snapshots, checked by Postgres

Date: 6 Oct 2026 · Status: accepted · Issue: #32 (B3) · Decisions D12 (kept by D22), D47 · Builds on ADR 0010 (token links), ADR 0012 (roles), the #30 rule "members and viewers get no pay data"

## Context

Owners and editors want to send someone outside the workspace a read-only copy of the Overview, a process, an issue or a
solution. PRD §9 says the server builds a redacted snapshot per link, so the browser never receives what a toggle hides.
The ticket says "a Postgres function builds a redacted snapshot per link", and that restricted links verify the visitor
"by magic link". Two things changed since: Austin dropped magic link (Google sign-in only, 30 Sep; Supabase's built-in
email can't send to outside visitors without custom SMTP, a paid service), and on 6 Oct he ruled that **nobody but owners
and editors gets pay data**, which rules out the "role-average blended rate" the ticket describes (overlapping averages
give a rate away by subtraction).

## Decision

- **A link is a token and a frozen copy.** `public.share_links` holds the SHA-256 of a 256-bit token (shown once, never
  stored; the pattern of API tokens and ADR 0010's report links), what is shared (`kind`, `target_id`), the two toggles,
  the allowed emails, an optional expiry, and the **snapshot** (`jsonb`, at most 5 MB). The copy is frozen at creation;
  **Update copy** rebuilds it from today's page and the link stays the same. Revoking is permanent (a trigger refuses any
  change to a revoked row).
- **The Next.js server builds the snapshot, Postgres refuses a leaky one.** `loadShareData` (`packages/db/src/share.ts`)
  runs the same loaders the pages use, as the signed-in editor, through `shareReaderDb`, a `Db` that changes two calls:
  `team_capacity` becomes `public.share_team_capacity(ws, show_people)` (labels or names, **no pay for anyone**) and
  `can_see_people` answers the People toggle. `redactShareSnapshot` then redacts every bundle and every string, and
  `shareSnapshotLeaks` checks the result. On every insert and every snapshot change a BEFORE trigger runs
  `private.share_snapshot_problem`, which refuses (23514, naming what leaked, never the value) a snapshot that holds an
  email, a non-null `cost_rate`, a non-empty `provenance`, a client's name, with People off a person's name, or with
  Financials off a rate, margin or overhead. Rebuilding ~15 TypeScript loaders in SQL (the ticket's wording) would
  duplicate them and drift; this keeps one set of loaders and still puts the guarantee in the database.
- **A visitor reads only through `public.open_share_link(token)`**, a SECURITY DEFINER function granted to `anon` and
  `authenticated`. Unknown, malformed, expired and revoked tokens all return null (the page says "This link has expired
  or been turned off."). A restricted link answers `sign_in` to a signed-out caller and `not_allowed` to a signed-in one
  whose **confirmed** email isn't listed. It counts opens (a number and the last time; nothing about who) and never
  returns the workspace id, the hash, the emails or the creator. The visitor's page (`/s/[token]`) calls that one function
  and imports no loader that reads a table (a source-text test checks it).
- **Restricted links verify by Google sign-in**, not magic link: `open_share_link` needs a confirmed address on the list AND a Google identity (a password sign-up with a listed address is `not_allowed`). Any toggle on needs at least one allowed email and an
  expiry (a table constraint, and the dialog). The visitor signs in with Google using a listed address; a short-lived
  cookie (`tf_after_sign_in`, only ever `/s/<43 characters>`) sends `/auth/callback` back to the link.
- **No pay, ever.** `cost_rate` is null for every person in every snapshot, whatever the toggles; `ProcessBundle.payHidden`
  makes `toEngineModel` leave pay out even when People is on, so figures that need it show "—" exactly as they do for
  members. Financials on shows **role** rates, margins and overhead, and the money cost of insights; Financials off sets
  role rates and margins to 0, drops overhead and target margin, hides money costs behind "—" with an (i), and replaces
  money in free text with "[amount hidden]".
- **Real ids stay.** Ids seed the engine's random streams, so replacing them would move every number and break "the
  numbers match the unredacted run". Random uuids carry no data. (B4 checks that an id belongs to the workspace instead of
  mapping redacted ids back.)
- **Clients are always "Client N"**, notes dropped (the ticket's Clients toggle is gone: named clients are already hidden
  on screen, and groups carry no personal data).
- **MCP can't make a link** (the trigger refuses `api_token_id`, 42501) and has no tools for them.

## What is left out of every snapshot

Sources and their text, AI summaries, proposed findings, AI ideas, issue history (it names people), author names, drafts and
earlier versions, `provenance` (it holds evidence quotes), emails and notes. Accepted findings are included, named for the
snapshot's own viewer, **without** the word-for-word quotes from sources (`facts` of kind `quote`).

## Consequences

- A link is only as fresh as its last **Update copy**; a deleted target keeps its last copy.
- A new engine version simulates an old copy with today's engine; `engine_version` is stored for diagnosis.
- The snapshot format is versioned (`v`); an old link reads "This link needs to be made again".
- Names under three characters are not scrubbed or checked (the floor `labelNames` has). With People off a full name is
  matched in any case with any white space between its words (a no-break space, several spaces, a line break, JSON `\n`),
  and a surname of 3 or more letters is matched on its own, in any case; the database checks the same. **Accepted limit:** a
  lone first name is replaced only by the app, as written (a first name one person has becomes their label; one two people
  share becomes "a team member"), and the database does not check it (it would refuse links over words like "Will" and
  "Mark"). A name that is also a common word is replaced everywhere it appears. Clients are matched by the whole name, in
  any case, with any white space; a part of a client name alone ("Fenwick") is not.
- Money in text (Financials off) uses one pattern shared with B20's `propose_finding` check (`packages/db/src/money.ts`),
  plus amounts written in words ("4,100 pounds"); the database checks a conservative equivalent. A bare "4.1k a month" with no
  symbol, code or unit cannot be told from a count and is left.
- A role-rate change (`roles.<id>.cost_rate`) inside a scenario's patch or a solution's lever changes is dropped with
  Financials off (the visitor's browser would price work at the real rate); both checks refuse one.
- **Order:** with Financials off the visitor reads detected issues sorted by rating, then key (`sortWithoutMoney`). The editor's
  own order puts the dearest first, which needs rates and pay a link hides, so a link's order can't be the editor's cost
  order without leaking its rank; an editor and a visitor who sort this way read the same list.
- B4 (play links) replaces the write trigger, adds `mode` to the insert grant and a rate-limited submission function. It
  needs `lever_settings` in the snapshot.

- Names are looked for only in free text: an explicit list of keys (`SHARE_FREE_TEXT_KEYS`, the same list in
  `private.share_snapshot_problem`). JSON keys, ids, enums, paths and numbers are never scrubbed or checked for names, so a
  person called Tom Price, Jo Weeks or Ann Kind cannot turn `price`, `horizon_weeks` or `kind` into a label and change the
  engine's input. Emails and money are looked for in every string value.
- Matching is by letter tokens of a normalised view (percent-decoded, NFKC, default-ignorable code points, combining marks and
  variation selectors removed, casefolded). Any token that equals a part (3+ characters) of a person's or client's name is
  replaced, a run of tokens of one name with whatever sat between them (hyphen, dot, bracket, space) as one span mapped back to
  the original text. A name token can't survive next to a label. The check tokenises the output the same way, in the app and in
  the database (`private.share_norm`, `share_name_tokens`). The price: a word that is also part of a name ("Will", "Home",
  "Kind") is hidden in free text; the numbers don't move because free text is not engine input.
- One money pattern (`money.ts`) serves B20's `propose_finding` check and the share link's redaction, and the database applies
  the same forms to the normalised text. A step's `cost_override` is nulled with Financials off and refused by both checks.
- A Google identity counts only when its own email equals the account's confirmed email (any case) and that address is listed.
- An issue or a solution of an archived process is refused, in the app and by the write trigger.

## Rejected

- **A Postgres function that builds the snapshot** (the ticket's wording): a second copy of the loaders in SQL.
- **Magic link:** needs custom SMTP (a new paid service and secret). Austin decided Google sign-in only.
- **Live data on each visit:** every visit would run the loaders as a service role or an anonymous user, with nothing
  frozen to check.
- **Role-average blended rates:** overlapping averages leak one person's pay by subtraction (Austin, 6 Oct).
- **Redacted ids:** would move every number.
