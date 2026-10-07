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
  symbol, code or unit cannot be told from a count and is left. A number joined to a code after it by a hyphen or a slash
  ("4100-GBP") counts only as a standalone amount (B3 follow-up, 7 Oct, migration `20261228000000`): not the end of a date or a
  version, and not right after a word such as "iso", "windows" or "page" (`JOIN_WORDS`), so "2026-10-06-CAD", "ISO 4217-GBP",
  "Windows 10-USD", "v1.2/EUR" and "page 3/GBP" stay as written. With a space between ("2026-10-06 CAD") the rule is unchanged,
  so a range such as "4,100-4,500 GBP" is still caught.
- A role-rate change (`roles.<id>.cost_rate`) inside a scenario's patch or a solution's lever changes is dropped with
  Financials off (the visitor's browser would price work at the real rate); both checks refuse one.
- **Order:** with Financials off the visitor reads detected issues sorted by rating, then key (`sortWithoutMoney`). The editor's
  own order puts the dearest first, which needs rates and pay a link hides, so a link's order can't be the editor's cost
  order without leaking its rank; an editor and a visitor who sort this way read the same list.
- B4 (play links) replaces the write trigger, adds `mode` to the insert grant and a rate-limited submission function. It
  needs `lever_settings` in the snapshot.

- Default deny: a string is free text, and is scrubbed and checked, unless its key is on `SHARE_NON_TEXT_KEYS` (ids, dates,
  enums, selectors and paths the engine reads; `private.share_snapshot_problem` has the same list). A new column or field nobody
  classified therefore fails closed. JSON keys are never touched, so a person called Tom Price, Jo Weeks or Ann Kind cannot turn
  `price`, `horizon_weeks` or `kind` into a label and change the engine's input. A key that is text anywhere (`source`) stays
  off the list. A type-level map of every string column of every table (from `database.types.ts`) fails to compile when a column
  or table is added until it is classified; so does a map of the JSON shapes a snapshot carries (`patch[]`, `lever_changes[]`,
  `facts[]`, `links[]`, `recurrence`, `settings`, the snapshot's envelope). Every key on the list carries a one-line reason
  (`SHARE_NON_TEXT_REASONS`: where it appears and why it is never typed words), and a test fails when a key is text in one shape and
  not text in another (B3 follow-up, 7 Oct). Emails and money are looked for in every string value.
- Matching is by letter tokens of a normalised view (percent-decoded, NFKD with combining marks dropped and the letters that
  don't decompose folded, default-ignorable code points and variation selectors removed, lower-cased, uuids and hex hashes masked).
  A person: any token that equals a part (3+ characters, 2 for a part with no Latin letter in it) of the name is replaced, a run
  of tokens of one name with whatever sat between them (hyphen, dot, space) as one span mapped back to the original text, brackets
  kept balanced; names in Han, Kana or Hangul are also found as substrings of an unspaced run, and an unspaced name by its first and last two characters (田中太郎 is 田中 and 太郎). German umlauts are folded to ae, oe, ue (Müller is Mueller), and a name is also tried without them (Muller). A client: only the whole of its
  name, as a run of tokens (or run together; "and", "the", "ltd" and "&" may sit between its words, and a Han, Kana or Hangul client is also found inside unspaced text), never one of its words, so "Group review" is no client; if Austin wants partial
  client names hidden too, that is his decision and a change here. A name token can't survive next to a label. The check
  tokenises the output the same way, in the app and in the database (`private.share_norm`, `share_name_tokens`). The price on the
  people side: a word that is also part of a name ("Will", "Grant", "Kind") is hidden in free text; the numbers don't move
  because free text is not engine input. A tag (`condition_tag` on an edge, `path_tags` on a service) is text: a name in it becomes the same label on both sides, so
  the tags still match and the numbers stay equal. Not looked at: a name split across two fields ("Pri" / "ya").
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

## Play links (B4, D48)

Issue #33. A share link made in `play` mode (a process only) shows the same redacted snapshot plus the lever kinds the workspace hides;
the visitor moves the shown levers in their browser and can send what they tried. Decisions D48 (Claude's defaults, for Austin to confirm).

- **The one anon write.** `anon` gains exactly one EXECUTE, `public.submit_play_proposal`, and still holds no table privilege (a test
  compares the set of public functions anon can execute with the one before B4 plus this). It is SECURITY DEFINER and volatile, and
  writes one pending `solution_idea` into `suggestion_proposals` with `created_via = 'play_link'` and `created_by` null; nothing else
  changes, and nothing is ever applied: only a person's Build it or Dismiss acts on it. A definer insert bypasses RLS (as `open_share_link`
  does), so every check is in the function. Only that function can make a `play_link` row: it sets the transaction-local
  `transpera.play_submitting` for its own statement (as `import_process_bundle` does with `transpera.importing`) and the trigger honours
  it; any other insert is `mcp` or `upload` with no link and no visitor details.
- **Real ids are checked, not mapped.** The ticket says redacted ids are mapped back to real ones; B3 kept real ids (ADR above: they seed the
  engine's random streams), so nothing is translated. Every id a visitor sends must be in the link's frozen snapshot FIRST, then in the
  workspace; every miss reads the same sentence, so the answer reveals nothing the page didn't show (an id of another workspace, a real
  id of this one that the link doesn't show, a retired step and an invented one are indistinguishable). Build it checks each change again
  against today's live process (`mapPlayChanges`) and drops those whose step, role, person or service has gone, with a note.
- **Limits and their order.** Format checks (cheap, no workspace data), then the rate limits under `for update` on the link row (5 per
  10 minutes and 50 per day per link, 10 per email per link per day, 200 pending visitor ideas per workspace), then the lever check, the
  issue check and the visitor-text check. A link at its limit answers `rate_limited` without running the dearer ones. A refused call stores
  nothing and isn't counted (accepted, as for `open_share_link`, which anon also calls without limit). No per-IP limit (the database sees
  Vercel's address; no shared store); the Send dialog has a honeypot. 1 to 50 changes; title 120, name 100, email 254, note 1,000 characters.
  The pending cap is per workspace, so it is serialised with an advisory lock on the workspace id (the link lock alone would let two links
  both read 199). An open link's email is checked strictly (letters, digits and `._+-`, no `?`, `&`, `%`, `#`, `/` or white space), because the
  team's "Reply by email" is a `mailto:` link.
- **Accepted limits** (reviewed, left as they are):
  - *Timing.* `share_snapshot_problem` returns at the first hit, so held text and clean text take slightly different times. Every probe is a
    stored idea the team sees, at 5 per 10 minutes and 50 a day per link, so the signal is weak.
  - *Current state.* "Pick an issue from this page, or none." and "...points at something that isn't in this page." also fire for an issue
    resolved, or a step deleted, after the copy was made. The visitor learns that something changed since their page, nothing about what
    or about anyone else's data. So "reveals nothing the page didn't show" holds for other workspaces and for what the link hides, not for
    changes since the copy.
  - *Nested non-text keys.* `hiddenLevers` is refused anywhere but the top (a nested copy would skip the name checks). B3's other non-text keys
    (`key`, `kind`, `id` ...) keep B3's accepted limit: a name nested under one is not looked for.
- **Proposals land in Suggestions**, not a separate queue (D37): `suggestion_proposals` gains `share_link_id` (no foreign key: links are
  never deleted) and `visitor_text`; a visitor's idea may be for no issue (the check is widened for `play_link` only; `build_proposal`
  accepts it, for the process the idea names). Owners and editors see the changes in words, the visitor's email (`play_proposal_contacts`,
  neither column is granted to `authenticated`) and Build it or Dismiss with a reply (kept as the review note; nobody is emailed: no SMTP).
- **The visitor-text rule.** Text a visitor writes is read by the workspace's members and viewers, so it must meet the rules those readers
  live under (#30, as B3's checks encode them for a People-off, Financials-off link): no team member's name, no client's name, no email
  address, no money amount. The link's own toggles don't loosen this: they set what the visitor may read, not what members may. The
  title, note and name are each checked with `private.share_snapshot_problem` as for such a link. A field that fails is **held, never
  refused** (a refusal would tell an outsider which words are the team's or a client's names) and not rewritten (the database has no
  scrubber and the app can't read the names for an anonymous visitor): members and viewers read "A visitor's idea", no note or "A visitor";
  owners, editors and agency admins read the original. The visitor is told only `ok`. Austin's #30 Q10 (typed titles keep names) is about
  the workspace's own editors, not outsiders.
- **`hiddenLevers` is a non-text key of known ids.** The snapshot carries the workspace's list of hidden lever kinds. B3's default deny would
  have treated it as free text (a person called "Wait" or "Leave" would have turned `process.wait` into a label), so it is on
  `SHARE_NON_TEXT_KEYS` and `non_text_keys`, and `share_snapshot_problem` refuses one that isn't an array of at most 30 distinct known
  kind ids (`private.lever_kind_ids()`, kept equal to the catalogue and to `LEVER_KIND_IDS` by tests). Old view links lack it (read as none); a
  play link without it is refused. A link keeps its frozen list until Update copy.
- **Lever changes in a solution are now simulated** (amends D46): `solutions.lever_changes` were stored and never used; a visitor's idea can
  be levers only, so they are applied wherever a solution is simulated: the Editor's solution run, the server verdict, the Solution page,
  the Overview's impact, the demo link check and the Forecast's plans. No stored solution had any (preflight 4), so nothing moved; no engine
  change.
- **Also in this migration:** the `suggestions` delete-user bug (the foreign key's set-null tripped `suggestions_before_write`) is fixed as
  `suggestion_proposals` was.
- **Rejected:** a per-visitor account (the point is to ask outsiders); emailing replies (needs SMTP, a paid service); translating ids (would move
  every number); refusing a visitor whose text names someone (an oracle for the team's and clients' names); accepting a visitor's idea as a
  saved scenario (the PRD's old `scenario_submissions`, superseded by D37).
