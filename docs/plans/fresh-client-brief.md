# Fresh client build brief: no 404s in a new workspace, and a way to build it out

Scoped 8 Oct 2026 against `origin/main` at 53835548 (handover #241; production at row 72). Read
`docs/plans/builder-brief.md` first. This brief adds to it and wins where they differ. Build strictly from it. If something
here doesn't match the code, **ask; don't guess.** Every open question has a default below: use it. Austin is not to be
asked.

Branch: `claude/fresh-client-setup` (this brief's branch; build on it). Commit and push after every step.

## What Austin reported (production, full-screen laptop, workspace `transpera-ai`)

> "theres no option to manualy build out company processes if tits a new client. we need that. the same way we add new
> processes or edit a company map. we need to kick of a fresh client."

> "a couple of 404 pages. when i am in a new client"

`transpera-ai` holds only what `create_workspace` makes: the company map (published version 1, no cards), Austin's
`agency_admin` membership and the four seeded scenarios. No roles, people, clients or processes.

## The short version

1. **Root cause.** `loadProcessBySlug` (`packages/db/src/queries.ts:509-535`) drops the company map
   (`const all = everything.filter((p) => !p.is_company && !p.archived_at)`, line 522) and, with no `processId`, picks the
   first ordinary process **with a live revision** (line 524). A workspace with only the company map, or only drafts,
   gets `null`. `loadLiveProcess` (`apps/web/src/lib/data.ts:168`) passes the `null` on, and seven pages call
   `notFound()` on it. **The loader is right** (the company map is never simulated, ADR 0014, D39); **the pages are
   wrong** to treat "nothing published" as "no such workspace". Fix the pages, not the loader.
2. **No 404s.** Each of the seven pages gets an exact change (Part 1): a workspace-level loader for the access check and
   a designed empty state, `NotPublished`, in place of what needs a simulation. The company map's own URLs redirect.
3. **A start page.** The empty Overview (`EmptyOverview`) becomes `StartOverview`: for editors, **New process**, **Upload
   process** and **Build the company map**, and a five-item checklist (roles, people, clients, first process, publish)
   ticked from cheap counts. Claude/MCP import and Restore a backup stay as secondary options. Members and viewers read a
   plain "nothing published yet" (Part 2).
4. **Processes page.** "Company map" no longer loops back to the start page; the empty table gets working buttons
   (Part 3).
5. **No migration.** Every read already exists and RLS already allows it (Part 7).

## Verified on origin/main (8 Oct)

Every claim in the investigation holds. Line numbers are as of 53835548.

| Where | What happens in a fresh workspace |
|---|---|
| `app/w/[slug]/issues/page.tsx:11-12` | `loadLiveProcess` → null → `notFound()` |
| `app/w/[slug]/solutions/page.tsx:10-11` | same; the page uses the bundle **only** for `bundle.workspace.id` |
| `app/w/[slug]/people/page.tsx:9-10` | same |
| `app/w/[slug]/forecast/page.tsx:11-12` | same |
| `app/w/[slug]/settings/calibration/page.tsx:24-25` | `loadCalibrationPage` (`lib/calibration/data.ts:43-44`) → null → `notFound()` |
| `components/workspace-process-page.tsx:25-26` | `/p/<companyId>`: `loadProcessForEditing(slug, processId)` without `includeCompany` → null → `notFound()` |
| `components/workspace-first-principles-page.tsx:20-21` | `/p/<companyId>/first-principles`: same |
| `components/overview/workspace-overview.tsx:23-30, 88-143` | renders `EmptyOverview`: only "add roles" and "import a process with Claude (MCP)"; no New process, Upload or Edit company map. The full Overview's `companyEditHref` (`overview.tsx:482`, `workspace-overview.tsx:74`) is never reached |
| `app/w/[slug]/processes/page.tsx:25` | `companyMapHref={base}` → the empty Overview (a loop) |
| `components/processes/processes-table.tsx:60-61` | "No processes yet. Start one with New process." is text, not a button |
| `app/w/[slug]/p/[processId]/edit` | works: `loadProcessForEditing(..., { includeCompany: true })`; exits to `/w/<slug>` for the company map (`workspace-editor-page.tsx:45`) |
| `app/w/[slug]/p/[processId]/history` | works for the company map (`lib/history/data.ts:23`, `includeCompany: true`) |
| Settings (roles, people, clients) | works with no process; `settings/page.tsx:27` already tolerates a null bundle |

Also found:
- **A draft-only workspace 404s the same pages.** `createProcess` (`app/w/[slug]/process-actions.ts`) makes a draft and
  redirects to its Editor; until it is published every page above still 404s. The fix must cover "company map + drafts",
  not only "company map alone".
- **New processes get a company-map card automatically** (`private.sync_company_map`, migration
  `20261126000000_company_map.sql`): the company Editor is useful as soon as one process exists (place cards, draw
  handoffs), and harmless before.
- `create_workspace` (`app/actions.ts`) redirects a new workspace to `/w/<slug>`, so the start page is the first thing an
  agency admin sees.
- `workspaceIsEmpty` (`lib/restore/empty.ts`) turns false as soon as a role exists, so the Restore card disappears once
  setup starts. That is the existing rule; keep it.
- Not 404s to fix: `issues/[number]` and `solutions/[id]` 404 only for a number or id that doesn't exist, which is
  correct (a fresh workspace has none). `blocks`, `sources`, `suggestions`, `share`, `settings/*` other than calibration
  already load by workspace head.

## Austin's decisions that bind this work (quoted from docs/HANDOVER.md and the PRD)

- #30 (B1): "members and viewers see 'Team member N' labels, only their own row, 'A team member' for other names, and
  **no pay data**." Nothing added here may show a person's name or pay to a member or viewer, or a count of people that
  isn't already visible to them.
- #175 (B17): "company analysis is judged against the main pipeline's first principles." So the company map has **no
  first principles of its own** (Part 1.7).
- D39 / ADR 0014: the company map is a stored, versioned process; "The engine never simulates the company process."
  `workspace-editor-page.tsx:44`: "The company map is read at the Overview, not at a process page of its own."
- #44 (C5): phones under 640 px are read only; every control that changes something carries `EDIT_ONLY` and
  `data-edit-entry` (`lib/phone.ts`). Dark mode is tokens only (`test/raw-colours.test.ts`).
- Austin, 30 Sep: "Austin will usually give Claude the process structure ... over MCP and fill in times and percentages
  on the canvas." So MCP import stays on the start page, as a secondary option.

## Part 1. No 404 in a workspace with only the company map (or only drafts)

### 1.0 Shared pieces (build these first)

**`NotPublished`**, new shared component, `apps/web/src/components/shell/not-published.tsx` (server-safe, no hooks of
its own; it may render the client `NewProcessButton`):

```tsx
export function NotPublished({ what, canEdit, base, firstDraft, create }: {
  /** One sentence: what this page shows once a process is published. */
  what: string;
  canEdit: boolean;
  /** `/w/<slug>`. */
  base: string;
  /** The oldest draft-only process, if any: the next step is publishing it. */
  firstDraft: { id: string; name: string } | null;
  /** createProcess bound to the workspace; only passed to editors. */
  create?: CreateProcess;
})
```

It renders the C5 `EmptyState` (`components/shell/empty-state.tsx`) with `data-not-published` and:
- `title`: "Nothing published yet"
- body: `what`, then for editors "Publish a process and this page fills in." and for everyone else "An owner or editor
  publishes a process first, then this page fills in."
- `action`, editors only:
  - with `firstDraft`: a `Link` to `${base}/p/${firstDraft.id}/edit` reading "✎ Open {name} to publish it", classes
    `cn(buttonVariants({ size: "sm" }), "bg-edit text-edit-fg hover:bg-edit/90", EDIT_ONLY)`, `data-edit-entry` (copy
    `overview.tsx:482`);
  - without: `<NewProcessButton create={create} />` (already `EDIT_ONLY` + `data-edit-entry`);
  - in both cases a plain link "Open Processes →" to `${base}/processes` (`font-medium text-accent hover:underline`, as
    `people-page.tsx:381`). Navigation, not an edit: no `EDIT_ONLY`.
- Members and viewers get **no action** and no names or counts.

**Loader.** Reuse `loadWorkspaceOverview(slug)` (`lib/data.ts:362`): it returns the workspace and every ordinary,
unarchived process with `live` and `draft` flags, RLS-checked as the signed-in user. Add one helper next to it:

```ts
/** For a page with nothing published: the workspace, whether anything is published, and the oldest draft-only process. */
export async function loadPublishState(slug: string): Promise<{ workspace: { id: string; name: string; slug: string }; published: boolean; firstDraft: { id: string; name: string } | null } | null>
```

`null` exactly when `loadWorkspaceOverview` returns null (the workspace doesn't exist or isn't visible): **that** stays
`notFound()`. This keeps every access check as it is: the layout's `loadWorkspaceHead` already 404s a workspace the user
can't read, and RLS decides the rest.

### 1.1 `/w/<slug>/issues` (`app/w/[slug]/issues/page.tsx`)

The list rates issues against a simulation of the live process (`useIssueCosts`, `issues-page.tsx:84`), so it needs the
bundle. When `loadLiveProcess(slug)` is null:

```tsx
const state = await loadPublishState(slug);
if (!state) notFound();
const canEdit = await canEditWorkspace(state.workspace.id);
return <Page title="Issues" eyebrow="Improve" description={/* unchanged */}>
  <NotPublished what="Issues are problems you confirm on a published process: its findings, or ones you log by hand." canEdit={canEdit} base={base} firstDraft={state.firstDraft} create={canEdit ? createProcess.bind(null, state.workspace.id, slug) : undefined} />
</Page>;
```

With a bundle, nothing changes.

### 1.2 `/w/<slug>/solutions` (`app/w/[slug]/solutions/page.tsx`)

The bundle is used only for its workspace id. Replace `loadLiveProcess` with `loadWorkspaceHead(slug)` (`if (!head)
notFound()`), keep every other loader. Then, when `live` (from `loadWorkspaceLiveRevisionIds`) is empty, render
`NotPublished` (what: "A solution is a changed copy of a published process, simulated against its issues.") in place of
`SolutionsList`, and no `NewSolutionButton` (it already returns null with no live process). Otherwise unchanged.

### 1.3 `/w/<slug>/people` (`app/w/[slug]/people/page.tsx`)

What People needs the bundle for (`components/people-page.tsx`): `useEngineModel(bundle)` and `useSimulation` for "how
busy each person is", client health, the absence test and the forecast panel; `bundle.people` and `viewerOf(bundle)`
for the privacy-filtered rows. **With no live process there is nothing to simulate**: today's fallback text ("This
workspace's live process can't be simulated yet ... Fix it on the map first", line 143) would be wrong here. So: when
`loadLiveProcess` is null, `loadPublishState` + `canEditWorkspace` and render, inside the same `Page`:

- `NotPublished` with what: "How busy each person is, and how healthy your clients are, come from a simulation of a
  published process."
- **Editors only**, below it, a second plain link "Add people in Settings →" to `${base}/settings#people-heading` (the
  anchor `SettingsSection id="people"` makes; the sidebar already links there).

**Privacy (#30):** no roster, no names, no counts, no pay on this state, for anyone. Members and viewers see the sentence
only. Default taken: don't build a non-simulated roster here (Settings → People is the roster, and for members it
already shows only their own row).

### 1.4 `/w/<slug>/forecast` (`app/w/[slug]/forecast/page.tsx`)

The forecast is a month-by-month simulation (`forecastModel(live, ...)`). When null: `loadPublishState` +
`canEditWorkspace`, then `<Page title="Forecast" width="max-w-6xl">` (header shown, not `hideHeader`) with `NotPublished`
(what: "The forecast runs the published processes forward month by month to show who gets too busy, and when."). No
plans are loaded.

### 1.5 `/w/<slug>/settings/calibration` (`app/w/[slug]/settings/calibration/page.tsx`)

`loadCalibrationPage` returns null with no live process; `loadClientCalibration` too (the client card is already
skipped when null). The leads and invoices checks and the Imports card are workspace-wide and work without a process.
When `data` is null:

1. `const head = await loadWorkspaceHead(slug); if (!head) notFound();`
2. `canEditWorkspace(head.id)`, `loadImports(head.id)`, and lead sources from a new tiny loader in
   `lib/calibration/import-data.ts`: `loadLeadSourceOptions(workspaceId)` → `{ id, name, volumeWeek }[]` (`select id,
   name, volume_week from lead_sources where workspace_id = ... order by created_at, id`; RLS: everyone in the workspace
   reads lead sources, as the demand settings do).
3. Render the same `Page` and `PhoneReadOnly`, with `NotPublished` (what: "Calibrating compares a stage history, deals or
   time logs with a published process.") in place of `CalibrationPanel`, then `OtherImportsPanel` and `ImportsHistory`
   exactly as now.

`loadCalibrationPage`'s default choice of process is unchanged (draft-only processes still open with `?process=<id>`).

### 1.6 `/w/<slug>/p/<companyId>` (`components/workspace-process-page.tsx`)

Decision: **redirect, never render the company map as a process page.** It can't be simulated (`run-actions.ts:22`),
and the app already treats the Overview as its page (`workspace-editor-page.tsx:44`, history's `viewBase`). When
`loadProcessForEditing(slug, processId)` is null:

```ts
const head = await loadWorkspaceHead(slug);
if (head && (await loadCompanyId(head.id)) === processId) redirect(version ? `/w/${slug}?version=${version}` : `/w/${slug}`);
notFound();
```

`loadCompanyId(workspaceId)` is new in `lib/data.ts`, wrapped in React `cache`, calling a new
`loadCompanyProcessId(db, workspaceId)` in `packages/db/src/queries.ts` (`select id from processes where workspace_id =
$1 and is_company`, `maybeSingle`, RLS as the signed-in user; export it from `packages/db/src/index.ts`). Only the
company id redirects; any other unknown id still 404s. `redirect` and `notFound` come from `next/navigation`; check the
bundled Next 16 docs (`node_modules/next/dist/docs/`) for both before writing. Encode the slug with
`encodeURIComponent` as `createProcess` does.

### 1.7 `/w/<slug>/p/<companyId>/first-principles` (`components/workspace-first-principles-page.tsx`)

First principles don't apply to the company map (#175: the company is judged against the main pipeline's). Same
pattern as 1.6, redirecting to `/w/<slug>` (no version).

### 1.8 Loading states

Each page keeps its existing `loading.tsx` (`issues`, `solutions`, `people`, `forecast`, `settings` and
`p/[processId]` all have one; `test/loading-coverage.test.ts` checks). Add none.

## Part 2. The start page (`/w/<slug>` and `/w/<slug>/overview` with nothing published)

### 2.1 Data (`components/overview/workspace-overview.tsx`)

The `if (!live) { ... }` branch (lines 24-31) becomes:

```ts
const head = await loadWorkspaceHead(slug);
if (!head) notFound();
const [overview, canEdit] = await Promise.all([loadWorkspaceOverview(slug), canEditWorkspace(head.id)]);
const canRestore = canEdit && (await workspaceIsEmpty(await createClient(), head.id));
const setup = canEdit ? await loadWorkspaceSetup(head.id) : null;
return <StartOverview ... />;
```

Keep the line `const canRestore = ...` textually equivalent and update `test/restore-gating.test.ts` to the new text
(it asserts the exact line). Load setup counts **only for editors**: members and viewers never get counts.

**`loadSetupCounts(db, workspaceId)`**, new in `packages/db/src/queries.ts`, exported from `index.ts`:

```ts
export interface SetupCounts { roles: number; people: number; clients: number; clientGroups: number; processes: number; published: number; companyId: string | null }
```

Seven reads in one `Promise.all`, each `select("id", { count: "exact", head: true }).eq("workspace_id", ws)` (the
pattern of `shellCounts`, `lib/company-data.ts:199`): `roles`; `people`; `clients`; `client_groups`; `processes` with
`.eq("is_company", false).is("archived_at", null)`; the same with `.not("live_revision_id", "is", null)`; and the
company id (`loadCompanyProcessId`). Throw on error, as `shellCounts` does. `lib/data.ts` gets a wrapper
`loadWorkspaceSetup(workspaceId)` calling it with `createClient()`.

**`setupChecklist(counts, base, firstDraft)`**, new pure function in `apps/web/src/lib/overview/setup.ts` (no
`server-only`, unit-tested):

| # | key | Label | Link | Ticked when |
|---|---|---|---|---|
| 1 | `roles` | Add roles | `${base}/settings#roles-heading` | `roles > 0` |
| 2 | `people` | Add people | `${base}/settings#people-heading` | `people > 0` |
| 3 | `clients` | Add clients or client groups | `${base}/settings#clients-heading` | `clients + clientGroups > 0` |
| 4 | `process` | Start the first process | `${base}/processes` | `processes > 0` |
| 5 | `publish` | Publish it | `${base}/p/${firstDraft.id}/edit` if there is a draft, else `${base}/processes` | `published > 0` |

Returns `{ key, label, href, done }[]` in that order. Item 5 is never ticked on this page in practice (publishing
replaces the start page with the full Overview); keep it for the order and the test.

### 2.2 `StartOverview` (`apps/web/src/components/overview/start-overview.tsx`, replaces `EmptyOverview`)

A synchronous component, all data as props, so it renders with `renderToStaticMarkup` in tests and in Storybook:

```ts
{ slug: string; name: string; canEdit: boolean;
  checklist: SetupItem[] | null;           // editors only
  drafts: { id: string; name: string }[];  // editors only (shown as today's "These haven't been published yet")
  companyEditHref: string | null;          // `${base}/p/${companyId}/edit?from=${encodeURIComponent(base)}`, editors with a company map only
  create?: CreateProcess; upload?: UploadProcess;
  canRestore: boolean }
```

Layout (existing classes only; invent no new style; `ShellHeader title="Overview"` on top as today):

**Editors** (`canEdit`):
1. Card (`mx-auto mt-6 w-full max-w-3xl rounded-token border border-line p-6`, as the restore card), `data-start-overview`:
   - `h1` "Set up {name}" and one line: "Build the company's processes by hand, upload them from a file, or lay out the
     company map. The Overview shows the map, headline numbers and trends once a process is published."
   - `<PhoneNotice />` (`components/shell/phone-read-only.tsx`): on a phone the buttons below are hidden, so say why.
   - Primary actions row (`flex flex-wrap items-center gap-2`): `<NewProcessButton create={create} />` (the existing
     dialog and `createProcess` action, unchanged; it opens the new draft in the Editor), `<UploadProcessButton
     upload={upload} />` (existing, `previewUpload`/`createUpload` bound as on `processes/page.tsx:28`), and, when
     `companyEditHref`, a `Link` "✎ Build the company map" with the classes and attributes of `overview.tsx:482`
     (`bg-edit`, `EDIT_ONLY`, `data-edit-entry`, plus `data-build-company-map`). All three are `EDIT_ONLY` and
     `data-edit-entry`.
   - Under the row, `text-fg-2 text-sm`: "New processes get a card on the company map. Arrange the cards and draw the
     handoffs between them in its Editor."
2. Checklist card, `data-setup-checklist`: `h2` "Getting started", an `<ol>` of the five items. Each `<li
   data-setup-item={key} data-done={done ? "" : undefined}>` holds a lucide icon (`CircleCheck` with `text-good` when
   done, `Circle` with `text-fg-3` when not; `aria-hidden`; if the installed `lucide-react` lacks `CircleCheck`, use `Check`,
   which the app already imports), the label as a `Link` to its `href` (plain link styling, as
   `people-page.tsx:381`), and a visually hidden "(done)" / "(to do)" for screen readers. Links are navigation: no
   `EDIT_ONLY`.
3. The drafts list, if any (today's markup and text, editors only).
4. Secondary options, a smaller card with `h2` "Other ways to start":
   - "Import with Claude": today's MCP sentence verbatim ("import a process with Claude (`set_active_workspace`, then
     `import_process`). Create a token under API tokens to connect it.") with the `/settings/tokens` link.
   - The **Restore a backup** card's content, unchanged (title, `Help` text, sentence, "Choose a backup file" link),
     shown only when `canRestore`. Keep `data-restore-card`.

**Members and viewers**: one `EmptyState` (`data-start-overview`, `title` "{name} has nothing published yet") with "The
Overview shows the company map, headline numbers and trends once an owner or editor publishes a process." No buttons,
no checklist, no drafts, no counts, no names.

Delete `EmptyOverview`. Nothing else imports it (checked).

## Part 3. Processes page

`app/w/[slug]/processes/page.tsx` and `components/processes/*`:

1. **Company map button.** `published = rows.some((r) => r.version !== null)`. When `published`, unchanged ("Company map"
   → `/w/<slug>`). When not: editors get `companyMapHref = ${base}/p/${companyId}/edit?from=${encodeURIComponent(base +
   "/processes")}` (company id from `loadCompanyId`) and the button reads "✎ Edit company map" with `bg-edit text-edit-fg
   hover:bg-edit/90`, `EDIT_ONLY`, `data-edit-entry`; members and viewers get no button (there is nothing to see).
   Implement as a new optional `ProcessesPage` prop `companyMap?: { href: string; edit: boolean }`; omit it to hide the
   button. The demo page (`app/demo/processes/page.tsx`) passes `{ href: "/demo", edit: false }`, so the demo is unchanged.
2. **Empty table.** Add an optional `empty?: ReactNode` prop through `ProcessesList` to `ProcessesTable`; when rows are
   empty it renders `EmptyState` with that content, else today's sentence (demo and readers). `ProcessesPage` passes, for
   editors (`create` present): `EmptyState` "No processes yet." with `action` = `<NewProcessButton create={create} />`
   and `<UploadProcessButton upload={upload} />` when present. For members and viewers: "No processes yet. An owner or
   editor adds them." (no button).

## Part 4. Keep editing reachable and consistent

- Every new control that changes something (New process, Upload, Build/Edit company map, Open … to publish) uses
  `EDIT_ONLY` and `data-edit-entry` (`lib/phone.ts`), as in PR #240. Links that only navigate do not.
- Tokens only (`text-good`, `text-fg-3`, `bg-edit`, `border-line`, …); `test/raw-colours.test.ts` must pass. Check dark
  mode in Storybook.
- `EmptyState` for every empty state; `NotPublished` is built on it.
- No new loading files; the existing skeletons cover every page touched.
- Plain words (PRD §8): "publish", "process", "company map"; no "bundle", "revision", "live revision" on screen.

## Part 5. Tests

1. **Fixture: a workspace with only the company map.**
   - `packages/mcp/test/fresh-workspace.ts` (new): `createFreshWorkspace(admin: pg.Client, secret: string)` makes an
     agency admin user (`app_metadata: { agency_admin: true }`), calls `create_workspace` **as that user** over SQL (the
     production path: company map, agency_admin membership, seeded scenarios), adds an owner, an editor, a member and a
     viewer, and returns `{ wsId, slug, companyId, users: Record<"agency" | "owner" | "editor" | "member" | "viewer", { id,
     jwt }> }` with JWTs from `signJwt` (`test/helpers.ts`). Copy the setup of `postgrest-company-version.test.ts` and
     `postgrest-roles.test.ts`.
   - `apps/web/test/fresh-workspace-fixture.ts` (new): the loader results for that workspace for the mocked page tests
     (head, `loadWorkspaceOverview` with `processes: []`, `loadPublishState` with `published: false, firstDraft: null`, a
     second variant with one draft, `SetupCounts` all zero, a company id).
2. **PostgREST test** `packages/mcp/test/postgrest-fresh-workspace.test.ts` (skips without `POSTGREST_URL`, like its
   siblings), as agency admin, owner, editor, member and viewer:
   - `loadProcessBySlug(db, slug)` is null and `loadLiveCompanyPart` is not (pins the root cause);
   - `loadCompanyProcessId` returns the company id for all five;
   - `loadSetupCounts` for agency admin, owner and editor returns zeros and the company id;
   - **the path:** as the editor, insert a role, a person, a client, then a process (as `createProcess` does: insert,
     `open_draft`, start and end steps and the edge), and after each step `loadSetupCounts` ticks exactly one more item;
     then `publish_process(target_process, true)`; afterwards `published = 1` and `loadProcessBySlug(db, slug)` is not
     null. Clean up only your own workspace.
3. **Route tests** `apps/web/test/fresh-workspace-routes.test.ts` (mocked, in the style of
   `export-bundle-route.test.ts`): mock `@/lib/data`, `@/lib/access-data`, `@/lib/calibration/*`, `@/lib/supabase/server`
   and `next/navigation` (`notFound` and `redirect` throw tagged errors). For each of **agency admin, owner and viewer**
   (agency admin and owner: `canEditWorkspace` true; viewer: false), and for both fixture variants (company map only;
   company map + one draft), import and call the default export of `issues`, `solutions`, `people`, `forecast`,
   `settings/calibration`, `/` and `/overview` (call `WorkspaceOverview` and render the resolved element), and assert
   **`notFound` is never called** and the result contains `data-not-published` or `data-start-overview`. Assert:
   - editors get the edit button (`data-edit-entry`) and readers get none;
   - readers' HTML has no person name and no number from `SetupCounts` (feed distinctive names and counts to the mocks
     and assert they're absent);
   - `/p/<companyId>` redirects to `/w/<slug>` (and keeps `?version=2`); `/p/<companyId>/first-principles` redirects to
     `/w/<slug>`; `/p/<some other unknown id>` still calls `notFound`;
   - an unknown workspace (`loadPublishState`/`loadWorkspaceHead` null) still calls `notFound` on every page.
4. **Unit tests**: `setupChecklist` (`apps/web/test/setup-checklist.test.ts`): order, hrefs (with and without a draft),
   each tick from its count, clients ticked by client groups alone.
5. **Start page tests** `apps/web/test/start-overview.test.ts` (`renderToStaticMarkup`): editor sees New process,
   Upload process, Build the company map (with the `from=` href), the five items with `data-done` matching the counts,
   the MCP option, and Restore only when `canRestore`; with no company map, no Build link; a member/viewer sees only the
   plain message. Update `test/restore-gating.test.ts` to read `start-overview.tsx` for the card's text and keep its
   checks (wording, "backup" not "bundle").
6. **Processes page**: extend `test/process-admin-browser.test.ts` or add a source test: the empty table shows New
   process for editors and no button for readers; the Company map button goes to the Editor when nothing is published.
7. **Browser test** `apps/web/test/start-overview-browser.test.ts` with a harness (`test/start-overview-harness/entry.tsx`,
   copy `phone-harness`): mount the editor start page at 1280 px (buttons visible; New process opens its dialog) and at
   400 px (no `[data-edit-entry]` visible, the phone notice shows, the checklist links are visible). No console errors.
8. **e2e.** The e2e suite (`apps/web/e2e`, #240) runs `next start` in demo mode with no Supabase and no sign-in, so it
   can't open a signed-in fresh workspace. **Default taken: no e2e test;** the PostgREST path test (2) plus the route
   tests (3) and the browser test (7) cover the fresh-client path. Don't add a demo route for it.
9. **Stories and visuals.** Add stories (both themes, fixed data, no `new Date()`):
   - `stories/shared/empty-state.stories.tsx`: `NotPublishedEditor`, `NotPublishedEditorWithDraft`, `NotPublishedReader`;
   - new `stories/shared/start-overview.stories.tsx`: `Editor` (nothing done), `EditorHalfway` (roles and people done,
     one draft, Restore hidden), `EditorFresh` (with Restore), `Reader`; tag `Editor` `visual-phone`;
   - add `["shell/not-published", "NotPublished"]` and `["overview/start-overview", "StartOverview"]` to `SHARED` in
     `test/stories-coverage.test.ts`.
   After the first push, CI's `visual` job fails on the new stories: approve with an empty commit `Approve visual changes
   [visual-update]`, pull the bot's baseline commit, push again, and check each new PNG (docs/visual-regression.md).
10. Run `pnpm lint && pnpm typecheck && pnpm test` (Postgres at `DATABASE_URL`; restart it as in the handover), the
    PostgREST tests if you can start PostgREST locally (otherwise CI runs them), and `pnpm --filter @transpera-flow/web
    build`.

## Part 6. Out of scope

- Changing `loadProcessBySlug`'s default (it stays "first published process"; the company map never becomes a default).
- Rendering the company map as a process page, or giving it first principles.
- A roster on the People page without a simulation.
- Viewing an earlier company-map version (`?version=N`) while nothing is published: the start page ignores it.
- Calibrating a draft-only process by default (`?process=<id>` already works).
- `issues/[number]`, `solutions/[id]` (they 404 only for ids that don't exist).
- A create-workspace flow change, onboarding tours, or any AI-driven setup.
- An e2e or demo route for a signed-in fresh workspace (Part 5.8).
- Any engine, golden or `ENGINE_VERSION` change.

## Part 7. Migration

**None.** Every read uses tables and functions that exist and RLS that already allows the caller: counts of `roles`,
`people`, `clients`, `client_groups` and `processes` (editors read all of them; members and viewers are never sent
counts), `processes.is_company` for the company id (everyone in the workspace reads `processes`), `lead_sources`, and the
existing `create_workspace`, `open_draft` and `publish_process`. No `save_fields` change. Production stays at row 72; no
apply file, preflight or ledger row. **If the build finds it needs one, stop and ask.**

## Defaults taken (choose conservatively; Austin is not asked)

1. The pages show an empty state; the loader is not changed (the company map stays out of every default).
2. `/p/<companyId>` redirects to the Overview (keeping `?version=N`); `/p/<companyId>/first-principles` redirects to the
   Overview (no company first principles, per #175).
3. Empty states: an edit button for editors (New process, or "Open {draft} to publish it" when a draft exists) plus a
   plain "Open Processes" link; members and viewers read a sentence only.
4. People with nothing published shows the empty state only, with no roster, names or counts for anyone; editors also
   get a link to Settings → People.
5. Calibration with nothing published still offers the leads and invoices checks and the Imports list.
6. The checklist is for editors only and ticks from counts: roles; people; clients **or** client groups; any process;
   any published process. Counts are never shown, only ticks.
7. The drafts list on the start page moves to editors only (today everyone sees it).
8. Processes page with nothing published: editors get "✎ Edit company map" (to the Editor, returning to Processes);
   members and viewers get no Company map button.
9. No e2e test (the suite is demo-only); PostgREST, mocked route and browser tests instead.
10. No migration.

## Done criteria

- In a workspace with only the company map, and in one with the company map and a draft, none of `/w/<slug>`,
  `/overview`, `/issues`, `/solutions`, `/people`, `/forecast`, `/settings/calibration`, `/p/<companyId>`,
  `/p/<companyId>/first-principles` returns 404 for an agency admin, an owner or a viewer; an unknown workspace or
  process id still does.
- An editor on the start page can, in the app alone: create a process (dialog → Editor), upload one, open the company map
  Editor, and reach roles, people and clients from the checklist, with each item ticking once done.
- Members and viewers see plain "nothing published yet" text: no edit buttons, names, pay or counts.
- Processes: "Company map" never loops to the start page; the empty table has working buttons for editors.
- At 400 px no new edit control is visible; dark mode uses tokens only.
- Tests in Part 5 pass; visual baselines approved with `[visual-update]`; lint, typecheck, tests and build green in CI.
- No migration; nothing in production changes except the deployed app.

## Files and functions to change

| File | Change |
|---|---|
| `packages/db/src/queries.ts` | add `loadCompanyProcessId(db, ws)`, `SetupCounts`, `loadSetupCounts(db, ws)` |
| `packages/db/src/index.ts` | export them |
| `apps/web/src/lib/data.ts` | add `loadPublishState(slug)`, `loadCompanyId(ws)` (cached), `loadWorkspaceSetup(ws)` |
| `apps/web/src/lib/overview/setup.ts` (new) | `SetupItem`, `setupChecklist(counts, base, firstDraft)` |
| `apps/web/src/lib/calibration/import-data.ts` | add `loadLeadSourceOptions(ws)` |
| `apps/web/src/components/shell/not-published.tsx` (new) | `NotPublished` |
| `apps/web/src/components/overview/start-overview.tsx` (new) | `StartOverview` |
| `apps/web/src/components/overview/workspace-overview.tsx` | the `!live` branch renders `StartOverview`; delete `EmptyOverview` |
| `apps/web/src/app/w/[slug]/issues/page.tsx` | Part 1.1 |
| `apps/web/src/app/w/[slug]/solutions/page.tsx` | Part 1.2 |
| `apps/web/src/app/w/[slug]/people/page.tsx` | Part 1.3 |
| `apps/web/src/app/w/[slug]/forecast/page.tsx` | Part 1.4 |
| `apps/web/src/app/w/[slug]/settings/calibration/page.tsx` | Part 1.5 |
| `apps/web/src/components/workspace-process-page.tsx` | Part 1.6 |
| `apps/web/src/components/workspace-first-principles-page.tsx` | Part 1.7 |
| `apps/web/src/app/w/[slug]/processes/page.tsx` | pass `companyMap` and the empty-state actions (Part 3) |
| `apps/web/src/components/processes/processes-page.tsx`, `processes-list.tsx`, `processes-table.tsx` | `companyMap` and `empty` props (Part 3) |
| `apps/web/src/app/demo/processes/page.tsx` | pass `companyMap={{ href: "/demo", edit: false }}` |
| tests and stories | Part 5 |

## Order of work (commit and push after each)

1. `packages/db` loaders + PostgREST fixture and test.
2. `NotPublished`, `loadPublishState`, `loadCompanyId`; Parts 1.1–1.7; route tests.
3. `setupChecklist`, `StartOverview`, the Overview branch; start-page tests; restore-gating update.
4. Processes page (Part 3) and its tests.
5. Stories, browser test, `[visual-update]` approval.
6. Full checks; open the PR with `Closes #<issue>` and a comment on the issue naming the branch.
