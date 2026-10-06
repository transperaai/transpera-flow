# C4 brief: Storybook and visual regression (#43)

Scoped by Opus on 6 Oct 2026 (overnight run) for a Sonnet builder. Build strictly from this brief; where it is silent or
wrong, ask the orchestrator rather than guess. **No migration. No engine change. No new secret or paid service.**

## Short version

Storybook 10.6.1 (`@storybook/react-vite`, **not** `@storybook/nextjs-vite`) in `apps/web`, stories in
`apps/web/stories/`, the app's real `globals.css` and self-hosted fonts, and a light/dark theme global. A separate
`@playwright/test` suite (`apps/web/visual/`) reads the static Storybook's `index.json`, screenshots every story in both
themes (and at 400 px for stories tagged `visual-phone`) and compares against PNG baselines committed in
`apps/web/visual/__screenshots__/`. Baselines are only ever made inside the pinned Playwright container
`mcr.microsoft.com/playwright:v1.63.0-noble`, so they are byte-stable. A new `visual` job in `.github/workflows/ci.yml`
runs in that container on every push, in parallel with `check`. To approve a diff, push a commit whose subject contains
`[visual-update]` (an empty commit is fine): the job regenerates the baselines, proves them stable with a second pass,
and commits them to the branch, where the PR diff shows the PNGs. No Chromatic, Percy, LFS or other service.

## Decisions (verbatim) and constraints

From issue #43:

> Protect UI quality as the app grows. Set up Storybook with stories for every shared component, canvas node and edge,
> and chart, each in light and dark themes. Playwright takes screenshots of the stories on each PR and fails on unapproved
> visual diffs, with a documented approve flow (PRD §8.1 Storybook).

> **Redesign note (1 Oct):** the style to capture is the applied **shadcn radix-nova preset** (`shadcn init --preset
> b1s91W1fU`: Inter, teal-blue brand, neutral greys; commit 6149a6a), with the redesigned shell (A33, #98), map (A34,
> #99), rating colours and the (i) help component. Best done once Austin's UI kit exists.

Acceptance criteria (#43):

> - Storybook covers all existing shared components, node/edge types and charts, in both themes
> - Visual regression runs in CI on each PR and reports diffs
> - There's a documented command to update baselines
> - The Storybook build runs in CI

PRD §8.1 (line 528): "**Storybook** for every component and chart in both themes; visual regression via Playwright
screenshots on each PR."

Overnight rules (`docs/HANDOVER.md`, Austin, 6 Oct): open questions take the brief's default; "Stop and skip … anything
needing a new secret or a paid service"; "Never weaken a test to get green."

## Audit (what exists on `origin/main`)

- `apps/web`: Next 16.3.6, React 19.2.8, Tailwind 4 via `@tailwindcss/postcss` (`postcss.config.mjs`), shadcn radix-nova
  (`components.json`), `vitest` 5.0.2 (`test/**/*.test.ts` only), `playwright-core` ^1.63.0 and `@playwright/test`
  ^1.63.0 (lockfile: 1.63.0; `@playwright/test` is currently unused), `vite` 8.3.1 already in the lockfile (via vitest),
  `esbuild` 0.28.2.
- Styles: `src/app/globals.css` imports `tailwindcss`, `tw-animate-css`, `shadcn/tailwind.css`, `../styles/tokens.css` and
  `@xyflow/react/dist/base.css`. Theme: `tokens.css` follows the OS (`prefers-color-scheme`) unless
  `:root[data-theme="light"|"dark"]` overrides; the `dark:` variant in `globals.css` follows the same rule. There is no
  theme toggle in the app.
- Fonts: `src/app/layout.tsx` uses `next/font/google` (Inter → `--font-inter`, IBM Plex Mono 400/500 →
  `--font-plex-mono`) and puts `h-full font-sans antialiased` on `<html>`, `flex min-h-full flex-col font-sans text-sm` on
  `<body>`. Storybook never renders this layout, so it must recreate those classes and variables itself.
- Components import only three Next modules: `next/link` (38), `next/navigation` (24), `next/dynamic` (4). Stand-ins
  already exist in `apps/web/test/build-harness-stubs/{link.tsx,navigation.ts,dynamic.tsx}`, and
  `apps/web/test/build-harness.ts` shows how `"use server"` modules are replaced by error-returning stubs.
- Browser tests (`test/*-browser.test.ts` + `test/*-harness/entry.tsx`) bundle with esbuild and drive `playwright-core`
  with `CHROMIUM_PATH`; they don't compile Tailwind (see the comment in `test/map-browser.test.ts`). They are behaviour
  tests and stay as they are; C4 adds pixel tests beside them.
- Map: `src/components/process-canvas.tsx` exports only `ProcessCanvas` (+ `NO_SELECTION`, `Selection`); its node types
  (`StepNode`, `TerminalNode`, `GroupNode`) and edge type (`BranchEdge`, plus handoff mode via `handoffs`) are internal,
  so they are covered by rendering `ProcessCanvas` with fixtures (see `test/map-harness/entry.tsx` for the bundles:
  `demoBundle()`, `withDemoGroups()`, the company bundle).
- Charts are hand-drawn SVG/CSS (no chart library): `overview/charts.tsx` (`MrrChart`), `overview/trend-charts.tsx`
  (`IssuesDonut`, `TimeSplitChart`, `OpenedResolvedChart`, `BeforeAfterChart`, `Legend`),
  `forecast/forecast-timeline.tsx` (`ForecastTimeline`, `TimelineLegend`), `utilisation-bars.tsx`, `wait-by-step.tsx`,
  `kpi-strip.tsx`. Several measure their width with `ResizeObserver` (0 on the first frame).
- CI (`.github/workflows/ci.yml`): one `check` job on `push` and `pull_request`, ~9–10 min, required by branch
  protection. Workflow-level `concurrency` cancels in-progress runs on the same ref. The repo is **public**, so Actions
  minutes and the MCR image cost nothing.
- Local container: Chromium at `/opt/pw-browsers/chromium-1194` (Playwright 1.56's build), `docker` CLI but **no daemon**.
  So local screenshots cannot match CI's pixels; baselines must come from CI (see "Baselines").

## Packages and versions (exact pins, `apps/web` devDependencies)

Install with `pnpm --filter @transpera-flow/web add -D -E <pkg>@<version>` and commit `pnpm-lock.yaml`
(CI uses `--frozen-lockfile`).

| Package | Version | Why |
|---|---|---|
| `storybook` | `10.6.1` | CLI and core (peer: vite ^5–^8, react ^19 ok) |
| `@storybook/react-vite` | `10.6.1` | Framework. Chosen over `@storybook/nextjs-vite` (which does support `next ^16`) because components use only `next/link`, `next/navigation` and `next/dynamic`, which we already stub; this keeps Storybook off Next 16 internals |
| `vite` | `8.3.1` | Peer of the framework; same version the lockfile already has, so no second copy |
| `@fontsource-variable/inter` | `5.3.0` | Self-hosted Inter (family name `"Inter Variable"`), no network at build time |
| `@fontsource/ibm-plex-mono` | `5.3.0` | Self-hosted Plex Mono; import `400.css` and `500.css` only |
| `@playwright/test` | change `^1.63.0` → `1.63.0` | Exact pin: the CI image tag must equal it (guarded, see below) |

Do **not** add `@storybook/addon-*`, `chromatic`, `@storybook/test-runner`, `@storybook/addon-vitest`, `eslint-plugin-storybook`
or `@vitejs/plugin-react` unless a step below says so. If JSX fails to compile ("React is not defined"), first set
`oxc: { jsx: { runtime: "automatic" } }` in `viteFinal`; only if that fails, add `@vitejs/plugin-react@6.1.2` (exact) and
note it in the PR. Storybook pulls `esbuild` within `^0.28`, so it dedupes with 0.28.2; check `pnpm why esbuild` shows one
0.28 copy. pnpm 10 may warn about blocked build scripts; do not add new `onlyBuiltDependencies` unless the build fails.

## Files

### New

```
apps/web/.storybook/main.ts
apps/web/.storybook/preview.tsx
apps/web/.storybook/preview.css
apps/web/.storybook/server-stubs.ts          # Vite plugin: "use server" modules and "server-only"
apps/web/stories/fixtures.ts                 # shared, memoised fixture data (Northbeam run etc.)
apps/web/stories/ui/<component>.stories.tsx # one per file in src/components/ui (23)
apps/web/stories/shared/*.stories.tsx
apps/web/stories/charts/*.stories.tsx
apps/web/stories/map/*.stories.tsx
apps/web/playwright.visual.config.ts
apps/web/visual/stories.spec.ts
apps/web/visual/serve.mjs                    # tiny static server for storybook-static (no deps)
apps/web/visual/prune.mjs                    # deletes baselines whose story no longer exists
apps/web/visual/docker.sh                    # runs the suite in the pinned image (for anyone with Docker)
apps/web/visual/__screenshots__/*.png        # baselines: committed by the CI update job, never by hand
apps/web/test/stories-coverage.test.ts       # vitest guard: every shared component/chart has a story
docs/visual-regression.md                    # how it works, the approve flow, commands
```

### Changed

- `apps/web/package.json`: devDeps above; scripts
  - `"storybook": "storybook dev -p 6006"`
  - `"build-storybook": "storybook build -o storybook-static --quiet"`
  - `"visual": "playwright test -c playwright.visual.config.ts"`
  - `"visual:update": "playwright test -c playwright.visual.config.ts --update-snapshots=all && node visual/prune.mjs"`
  - `"visual:docker": "bash visual/docker.sh"`
- Root `package.json`: `"storybook": "pnpm --filter @transpera-flow/web storybook"` (convenience only).
- `apps/web/tsconfig.json`: add `".storybook/**/*.ts"` and `".storybook/**/*.tsx"` to `include` (TypeScript's `**`
  skips dot-folders; `.next/types` is listed explicitly for the same reason). `stories/` and `visual/` are already
  covered by `**/*.ts(x)`, so `pnpm typecheck` checks every story.
- `apps/web/eslint.config.mjs`: add `"storybook-static/**"`, `"visual/.local-screenshots/**"`,
  `"playwright-report/**"`, `"test-results/**"` to `globalIgnores`.
- Root `.gitignore`: add `storybook-static/` and `apps/web/visual/.local-screenshots/` (`test-results/` and
  `playwright-report/` are already there).
- `.github/workflows/ci.yml`: new `changes` and `visual` jobs (below). The `check` job is untouched.
- `README.md`: one short "Storybook and visual tests" paragraph linking `docs/visual-regression.md`.
- `docs/plans/builder-brief.md`, "Before opening the PR": one bullet: "UI changes: if the `visual` job fails, look at
  its report, and if the change is intended push an empty commit with `[visual-update]` in the subject (see
  `docs/visual-regression.md`)."

Nothing in `src/` changes, except if a component cannot be rendered without a tiny export (for example exporting a
props type). Do not change component behaviour or styling to make a story work; if a component can't be storied without
that, list it in the PR under "Deferred" and ask.

## Storybook setup

### `.storybook/main.ts`

```ts
import type { StorybookConfig } from "@storybook/react-vite";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import { serverStubs } from "./server-stubs";

const stub = (f: string) => fileURLToPath(new URL(`../test/build-harness-stubs/${f}`, import.meta.url));

const config: StorybookConfig = {
  framework: { name: "@storybook/react-vite", options: {} },
  stories: ["../stories/**/*.stories.tsx"],
  addons: [],
  core: { disableTelemetry: true },
  typescript: { reactDocgen: false }, // faster builds; we don't use autodocs
  viteFinal: (c) =>
    mergeConfig(c, {
      plugins: [serverStubs()],
      resolve: {
        alias: [
          { find: /^@\//, replacement: fileURLToPath(new URL("../src/", import.meta.url)) },
          { find: /^next\/link$/, replacement: stub("link.tsx") },
          { find: /^next\/navigation$/, replacement: stub("navigation.ts") },
          { find: /^next\/dynamic$/, replacement: stub("dynamic.tsx") },
        ],
      },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    }),
};
export default config;
```

Adjust to the real Storybook 10 / Vite 8 API (read `node_modules/storybook` and `node_modules/@storybook/react-vite`
types; don't guess). Reuse the existing harness stubs; don't copy them. Tailwind compiles through the existing
`postcss.config.mjs`, which Vite picks up; if utilities are missing from the build, add `@tailwindcss/vite` at the version
matching the lockfile's `tailwindcss` and say so in the PR.

### `.storybook/server-stubs.ts`

A Vite plugin with the same logic as `stubs` in `test/build-harness.ts`: for a `.ts/.tsx` file under `apps/web/src`
whose source starts with `"use server"`, return a module exporting each named function as
`async () => ({ status: "error", message: "Not available in Storybook." })`; and resolve `server-only` to an empty module.
Extract nothing from `build-harness.ts` (it's test code; a small copy is fine) but keep the regexes identical.

### `.storybook/preview.tsx` and `preview.css`

- Imports, in order: `@fontsource-variable/inter`, `@fontsource/ibm-plex-mono/400.css`, `@fontsource/ibm-plex-mono/500.css`,
  `../src/app/globals.css`, `./preview.css`.
- `preview.css`: `:root { --font-inter: "Inter Variable"; --font-plex-mono: "IBM Plex Mono"; }` (the variables
  `next/font` would set).
- `globalTypes.theme` (toolbar: Light / Dark, icon `mirror`), `initialGlobals: { theme: "light" }`.
- One decorator that, **before** rendering the story, sets `document.documentElement.dataset.theme = globals.theme`,
  `document.documentElement.className = "h-full font-sans antialiased"` and `document.body.className = "font-sans
  text-sm"` (as `layout.tsx` does), and wraps the story in nothing else.
- `parameters`: `layout: "padded"`, `backgrounds: { disable: true }` (the body's `bg-background` must show; check the
  Storybook 10 parameter name in its docs), `controls: { disable: true }` is fine.

## Stories

Titles: `UI/<Name>`, `Shared/<Name>`, `Charts/<Name>`, `Map/<Name>`. Keep shot count down: one story per component
showing all its variants/sizes/states in a grid (`Variants`), plus separate stories only where a state can't share a frame
(an open overlay, an empty state, an error state). Stories render real components with fixture props; no mocks of our
own modules beyond the Next stubs.

**Tags** (read by the visual suite from `index.json`):
- `visual-page`: screenshot the whole viewport instead of `#storybook-root` (needed for anything in a portal: open
  `Dialog`, `Sheet`, `Popover`, `DropdownMenu`, `Select`, `Tooltip`, the open `Help`).
- `visual-phone`: also screenshot at 400 × 900.
- `visual-skip`: not screenshotted (use only with a comment saying why; none expected).

### Wave 1: what this ticket must cover (in this order; commit and push after each group)

1. **UI primitives** (`src/components/ui/*`, all 23): alert, avatar, badge, button, card, dialog, dropdown-menu, input,
   native-select, popover, scroll-area, select, separator, sheet, sidebar, skeleton, switch, table, tabs, textarea,
   toggle-group, toggle, tooltip. Each: `Variants` (every `variant`/`size` cva value, disabled, and `aria-invalid` for
   inputs). Overlays: an `Open` story using the component's controlled `open`/`defaultOpen` prop, tagged `visual-page`.
   `Dialog` and `Sheet` open also get `visual-phone`. `Sidebar` needs `SidebarProvider`; render a short nav.
2. **Shared components** (used in 3+ places, or the redesign note names them):
   - `help.tsx`: `Help` and `HelpLabel`, closed and open (`visual-page`).
   - `shell/page.tsx` (`Page`, `PageHeader` with eyebrow, description and actions), `shell/shell-header.tsx`.
   - `fields.tsx`: `TextField`, `DateField`, `NumberField`, `SelectField`, `ToggleField`, `ChecklistField`, and
     `ConflictPrompt` (read each signature; pass no-op callbacks; for a "save" prop that's a server action, pass an async
     no-op).
   - Ratings: `overview/rating-pill.tsx` `RatingPill` (all four ratings) and `processes/rating.tsx` `RatingDot` /
     `RatingPill` (all ratings and `null`).
   - `pay-hidden.tsx`, `simulation-gaps.tsx` (`GapList`, `MissingForSimulation`, `IncompleteDataNote`),
     `horizon-picker.tsx`, `solutions/solution-cards.tsx` (`VerdictWord` for each verdict and null; `SolutionCards` with
     two solutions), `provenance-badge.tsx`, `step-issue-badges.tsx`.
3. **Charts** (each `visual-phone` too): `MrrChart` (with and without `compare`), `IssuesDonut`, `TimeSplitChart`,
   `OpenedResolvedChart`, `BeforeAfterChart`, `ForecastTimeline` + `TimelineLegend`, `UtilisationBars`, `WaitByStep`,
   `KpiStrip` (status done; and the loading/empty state where the props allow it). Derive props the way
   `overview/overview.tsx` does (lines ~370–390: `timeSplitByProcess`, `openedVersusResolved`, `timelineData`,
   `mrrSeries`; `impactNumbers` for `BeforeAfterChart`), from fixtures in `stories/fixtures.ts`. Hand-written small
   arrays are fine where that's simpler (`IssuesDonut`, `OpenedResolvedChart`).
4. **Map** (`ProcessCanvas`, all `visual-phone` except the editable one):
   - `ReadOnly`: Northbeam (`demoBundle()`), with a `result` (queues) and a `rating` function giving every rating band
     at least one step, `showPlayback={false}`.
   - `GroupsOpen`: `withDemoGroups(demoBundle())`, `expanded` = all group ids (`DEMO_GROUP_IDS`), so `GroupNode` open and
     closed both appear (open some, not all).
   - `Highlight`: `highlight` = two step ids (dimmed rest).
   - `CompanyMap`: the company bundle as in `test/map-harness/entry.tsx` `companyBundle()`, `handoffs`.
   - `Editable`: `ProcessEditor(base, new MemoryStore(base))` as the map harness does, `height="fill"` inside a 1200 ×
     560 box.
   This covers `StepNode`, `TerminalNode`, `GroupNode`, `BranchEdge` (with shares) and handoff edges. Wrap each in a
   fixed-width block (1200 px, `width: 100%` for phone), never a bare flex row (the #99 flake: a read-only map in a flex
   row shrink-wraps and refits late).

**`stories/fixtures.ts`**: `northbeamRun()` memoised: `const bundle = demoBundle(); const model = toEngineModel(bundle);
const result = simulate(model, 30, 1);` (`toEngineModel` from `@transpera-flow/db`, `simulate` from
`@transpera-flow/engine`). Use `DEMO_FORECAST_START` (`src/lib/forecast/demo.ts`) as every chart's start date; never
`new Date()` in fixtures. Seed and reps are fixed, so output is deterministic (the engine is; see
`docs/engine-versioning.md`). Consequence: a golden-moving engine change also moves chart/map baselines; that PR runs
the approve flow (note it in `docs/visual-regression.md`).

### Later waves (out of scope here; list in the PR as follow-ups)

Page-level composites (`Overview`, `ProcessView`, `IssuesPage`, `SourcesPage`, dialogs like `acknowledge-dialog`,
`finding-dialog`, `source-dialog`), the Editor's palette/inspector, playback layer.

## Visual regression

### `playwright.visual.config.ts`

- `testDir: "./visual"`, `testMatch: "*.spec.ts"`, `fullyParallel: true`, `workers: process.env.CI ? 4 : 2`,
  `retries: 0`, `forbidOnly: !!process.env.CI`, `timeout: 30_000`.
- `snapshotPathTemplate`: `"{testDir}/__screenshots__/{arg}{ext}"` when `process.env.VISUAL_BASELINES === "1"`, else
  `"{testDir}/.local-screenshots/{arg}{ext}"`. Only the pinned container sets `VISUAL_BASELINES=1`, so a local run can
  never write or compare against the committed baselines with the wrong Chromium.
- **Version guard:** when `VISUAL_BASELINES === "1"`, throw unless `process.env.PLAYWRIGHT_IMAGE ===
  \`v${version}-noble\`` where `version` comes from `@playwright/test/package.json`. A Playwright bump without an image
  bump fails loudly instead of producing slightly different pixels.
- `use`: `baseURL: "http://127.0.0.1:6007"`, `viewport: { width: 1280, height: 800 }`, `deviceScaleFactor: 1`,
  `locale: "en-GB"`, `timezoneId: "Europe/London"`, `reducedMotion: "reduce"`, and
  `launchOptions.executablePath: process.env.VISUAL_BASELINES ? undefined : process.env.CHROMIUM_PATH || undefined`.
- `expect.toHaveScreenshot`: `{ animations: "disabled", caret: "hide", scale: "css", maxDiffPixels: 0, threshold: 0.2 }`.
  (`threshold` is per-pixel colour tolerance, the Playwright default; `maxDiffPixels: 0` means any pixel past it fails.
  Same container, same pixels: no ratio allowance that could hide a 1 px border change.)
- `reporter`: CI → `[["github"], ["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]`; local → `list`.
- `webServer`: `{ command: "node visual/serve.mjs storybook-static 6007", url: "http://127.0.0.1:6007/index.json",
  reuseExistingServer: !process.env.CI, timeout: 30_000 }`.

### `visual/stories.spec.ts`

- Read `storybook-static/index.json` synchronously at module load; if missing, throw "Run `pnpm build-storybook` first".
  Stories = `Object.values(index.entries)` with `type === "story"` and without the `visual-skip` tag, sorted by id.
- For each story × theme (`light`, `dark`), plus × `400` for `visual-phone`: one `test(\`${id} ${theme}${phone}\`)`:
  1. `page.setViewportSize` (400 × 900 for phone), `page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })`
     (so `prefers-color-scheme` agrees with `data-theme`).
  2. `await page.clock.setFixedTime(new Date("2026-10-05T09:00:00Z"))` before navigation (relative dates like
     "3 days ago" stay put; timers still run).
  3. Collect `pageerror` and console `error` messages.
  4. `page.goto(\`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}\`)`; wait for
     `#storybook-root > *` (or, for `visual-page`, `body` with the story's content); assert `body` does not have class
     `sb-show-errordisplay`.
  5. `await page.evaluate(() => document.fonts.ready)`, then assert
     `document.fonts.check('16px "Inter Variable"')` is true (a font that silently falls back is the commonest
     cross-machine diff).
  6. If `.react-flow__viewport` exists, wait until its `transform` is the same on two consecutive animation frames.
  7. `page.mouse.move(0, 0)`.
  8. `await expect(target).toHaveScreenshot(\`${id}--${theme}${phone ? "--400" : ""}.png\`)` where target is
     `page.locator("#storybook-root")` or `page` for `visual-page`. (`toHaveScreenshot` itself waits for two identical
     consecutive shots, which absorbs `ResizeObserver` charts and React Flow's fit.)
  9. `expect(errors).toEqual([])`.

### `visual/serve.mjs`, `prune.mjs`, `docker.sh`

- `serve.mjs <dir> <port>`: `node:http` + `node:fs` static server bound to `127.0.0.1`, correct `Content-Type` for
  html/js/css/json/woff2/svg/png, 404 otherwise, path traversal refused. ~40 lines.
- `prune.mjs`: list `visual/__screenshots__/*.png` (or `.local-screenshots` when `VISUAL_BASELINES` isn't set), compute
  the expected names from `index.json` exactly as the spec does (share the naming function in a tiny
  `visual/names.mjs` imported by both), delete the rest, print what it deleted.
- `docker.sh`: reads the installed `@playwright/test` version, runs
  `docker run --rm --ipc=host -v "$repo":/work -w /work/apps/web -e VISUAL_BASELINES=1 -e PLAYWRIGHT_IMAGE=v$V-noble
  mcr.microsoft.com/playwright:v$V-noble bash -lc "corepack enable && pnpm install --frozen-lockfile && pnpm
  build-storybook && pnpm visual $*"`. For people with Docker; the cloud container has no daemon, so agents use the CI
  flow.

## Baselines: storage, update, review

- **Stored** as PNGs in git at `apps/web/visual/__screenshots__/<story-id>--<theme>[--400].png`. Expected ~130 files,
  ~3–6 MB. Plain git, no LFS (LFS bandwidth is a metered service).
- **Made only in the pinned container** (`mcr.microsoft.com/playwright:v1.63.0-noble`): Chromium, fonts, ICU and
  freetype are identical every run, so comparisons are exact. Local runs (cloud container Chromium 1194) write to the
  git-ignored `.local-screenshots/` and are for the builder's own checks.
- **Approve flow (the documented command):** push a commit whose **subject** contains `[visual-update]`, e.g.
  `git commit --allow-empty -m "Approve visual changes [visual-update]" && git push`. The `visual` job then runs
  `pnpm visual:update` (all baselines, then prune), runs `pnpm visual` again to prove the new baselines are stable, and
  commits `apps/web/visual/__screenshots__` as "Update visual baselines" to the branch (only if anything changed).
  Commits pushed with `GITHUB_TOKEN` don't start workflows, so **then push any commit** (an empty one is fine) so `check`
  and `visual` run on the new head; branch protection needs `check` on the head SHA. Never on `main` (guarded).
  With Docker: `pnpm --filter @transpera-flow/web visual:docker --update-snapshots=all` gives the same result locally.
- **Review:** the baseline commit shows in the PR's "Files changed"; GitHub renders PNG diffs (2-up, swipe, onion skin).
  The reviewer checks each changed image is intended. On a failing compare, the job uploads `playwright-report/` and
  `test-results/` as the artifact `visual-report` (7 days): expected, actual and diff side by side; the `github` reporter
  annotates each failing story on the run, and the job writes the failing story ids to `$GITHUB_STEP_SUMMARY`.
- A new story with no baseline fails compare ("missing snapshot") until approved: intended.

## CI changes (`.github/workflows/ci.yml`)

Add two jobs; leave `check` exactly as it is.

```yaml
  changes:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    outputs:
      visual: ${{ steps.f.outputs.visual }}
      update: ${{ steps.f.outputs.update }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - id: f
        env: { BEFORE: "${{ github.event.before }}" }
        run: |
          subject=$(git log -1 --format=%s)
          update=false
          if [ "$GITHUB_REF" != "refs/heads/main" ] && printf '%s' "$subject" | grep -qF '[visual-update]'; then update=true; fi
          if [ "$update" = true ] || [ -z "$BEFORE" ] || [ "$BEFORE" = 0000000000000000000000000000000000000000 ] || ! git cat-file -e "$BEFORE" 2>/dev/null; then visual=true
          elif git diff --name-only "$BEFORE" "$GITHUB_SHA" | grep -qE '^(apps/web/(src|stories|\.storybook|visual|package\.json|postcss)|packages/(engine|db)/src/|pnpm-lock\.yaml|\.github/workflows/)'; then visual=true
          else visual=false; fi
          echo "visual=$visual" >> "$GITHUB_OUTPUT"; echo "update=$update" >> "$GITHUB_OUTPUT"

  visual:
    needs: changes
    if: needs.changes.outputs.visual == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 25
    permissions:
      contents: write
    container:
      image: mcr.microsoft.com/playwright:v1.63.0-noble
      options: --ipc=host
    env:
      VISUAL_BASELINES: "1"
      PLAYWRIGHT_IMAGE: v1.63.0-noble
      STORYBOOK_DISABLE_TELEMETRY: "1"
    steps:
      - uses: actions/checkout@v4
      - run: git config --global --add safe.directory "$GITHUB_WORKSPACE"
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @transpera-flow/web build-storybook
      - name: Compare with the baselines
        if: needs.changes.outputs.update != 'true'
        run: pnpm --filter @transpera-flow/web visual
      - name: Update the baselines, check they are stable, commit them
        if: needs.changes.outputs.update == 'true'
        run: |
          pnpm --filter @transpera-flow/web visual:update
          pnpm --filter @transpera-flow/web visual
          git add -A apps/web/visual/__screenshots__
          if git diff --cached --quiet; then echo "Baselines unchanged."; exit 0; fi
          git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
            commit -m "Update visual baselines" -m "Regenerated in the pinned Playwright image from $(git rev-parse --short HEAD)."
          git push origin "HEAD:$GITHUB_REF_NAME"
      - name: Upload the visual report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: visual-report
          path: |
            apps/web/playwright-report
            apps/web/test-results
          retention-days: 7
```

Notes for the builder:
- `visual` runs on `push` only: `check` runs twice per PR push (push and pull_request); doubling the screenshot job buys
  nothing and the update mode needs a branch ref to push to.
- The bot commit's subject is "Update visual baselines", so it can never retrigger update mode even if it did start a run.
- If `git push` is refused (403: the org caps `GITHUB_TOKEN` at read), the job must fail with a clear message and still
  upload the regenerated `apps/web/visual/__screenshots__` as artifact `visual-baselines`; record it as a finding for
  Austin (see open question 3). Do not add a PAT or any secret.
- Verify the YAML with `actionlint` if available (`/opt/node-tools` or `go run`), otherwise read it twice.

**Time cost.** Image pull ~40–60 s, install ~40 s, Storybook build ~30–60 s, ~130 screenshots on 4 workers ~1–2 min:
**~4–6 min** in compare mode, ~+2 min in update mode. It runs in parallel with `check` (~9–10 min), so a PR's wall-clock
time doesn't grow. Docs-only pushes (handover updates) skip it via `changes`. The repo is public: no minutes billed.

**Required check?** Not added to branch protection in this ticket (changing protection is Austin's call; see open
question 2). A failing `visual` job still shows a red X on the PR.

## Edge cases

- **Fonts:** never `next/font` in Storybook (network at build time, different subsets). Self-hosted `@fontsource`
  files are bundled into `storybook-static`. The spec asserts `document.fonts.check` after `document.fonts.ready`.
  Glyphs Inter lacks fall back to the container's fonts: same container, same fallback.
- **Animations:** `reducedMotion: "reduce"` (stops `.bottleneck-pulse` per `globals.css`), `animations: "disabled"`
  (finishes CSS animations/transitions, incl. `tw-animate-css` enter animations on dialogs), `caret: "hide"`.
  `Skeleton`'s `animate-pulse` is frozen by the same. React Flow's animated fit (`duration: 200`) is waited out (step 6).
- **Dark mode:** `data-theme` set by the decorator **and** `emulateMedia({ colorScheme })`, so tokens, `dark:` variants
  and native `color-scheme` (scrollbars, form controls) agree. Every story is shot in both.
- **400 px:** charts, the map and the phone-relevant overlays carry `visual-phone`. A story that overflows sideways at
  400 px is a real bug: record it under "Findings" in the PR (don't fix product code in this ticket unless it's one line
  and the orchestrator agrees).
- **Time and locale:** fixed clock, `en-GB`, `Europe/London`; fixtures use `DEMO_FORECAST_START`. Currency formatting
  runs in Chromium's ICU (pinned by the image), so the container's "£27.4K" vs "£27.4k" quirk can't reach baselines.
- **Portals:** Radix overlays render under `body`, outside `#storybook-root`; `visual-page` shoots the viewport.
- **Focus rings:** dialogs autofocus their first control; Chromium shows `:focus-visible` for that consistently. Leave it.
- **Hover:** mouse parked at (0,0) before each shot.
- **Random ids:** `crypto.randomUUID` / `useId` don't affect pixels. If a story renders random text, fix the fixture.
- **Flakiness:** `retries: 0`. If a story differs between two runs in the same container (the update job's second pass
  catches this), fix the story (wait for its ready state, freeze its data), never loosen `maxDiffPixels`. Locally, run
  `pnpm visual:update` then `pnpm visual` (both into `.local-screenshots`) twice in a row as the stability check.
- **Concurrency:** the workflow's `cancel-in-progress` cancels an update job if you push again before it finishes; wait
  for it, then pull its commit (`git pull --rebase`) before pushing more.
- **Storybook build vs Next build:** stories never reach `next build` output (no route imports them), but `next build`
  type-checks them through `tsconfig.json`; that's wanted.
- **`vitest`:** its `include` is `test/**/*.test.ts`, so `visual/*.spec.ts` never runs under `pnpm test`.

## Tests

1. `apps/web/test/stories-coverage.test.ts` (vitest, runs in `pnpm test`): reads `src/components/ui/*.tsx` and asserts a
   `stories/ui/<same-name>.stories.tsx` exists for each; and for an explicit list (`SHARED`, `CHARTS`) of
   `[sourceFile, exportName]` pairs from Wave 1, asserts some story file imports that export from that module (regex on
   the stories' import lines). Also asserts every `ProcessCanvas` story file renders `ProcessCanvas`. A new ui component
   without a story fails `pnpm test`.
2. The visual suite itself (CI `visual` job): every story × theme (× 400) matches its baseline, renders without console
   errors and without Storybook's error display, with Inter loaded.
3. Builder's local evidence: `pnpm --filter @transpera-flow/web build-storybook` succeeds; with
   `CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, `pnpm visual:update && pnpm visual` passes, and a
   second `pnpm visual` passes too (stability). Look at a sample of `.local-screenshots` PNGs (Read tool) in light and
   dark, 1280 and 400, and describe them in the PR.
4. `pnpm lint && pnpm typecheck && pnpm test` and `pnpm --filter @transpera-flow/web build` stay green.

## Build order (commit and push after each)

1. Packages, scripts, `.storybook/*`, one `UI/Button` story; `build-storybook` works; Tailwind and fonts visible in a
   local screenshot.
2. Wave 1 groups 1–4 in order (one commit per group).
3. `playwright.visual.config.ts`, `visual/*`, local runs pass twice.
4. `stories-coverage.test.ts`, eslint/tsconfig/gitignore, `docs/visual-regression.md`, README, builder-brief bullet.
5. CI jobs. Push; the first `visual` run fails with "missing snapshot" for every story (expected).
6. Push `git commit --allow-empty -m "First visual baselines [visual-update]"`; wait for the job to commit the baselines;
   `git pull --rebase`; check the count of PNGs equals the test count; open a few with the Read tool.
7. Push an empty commit to re-run CI; `check` and `visual` both green. Open the draft PR (`Closes #43`).
8. Prove the gate: push a throwaway commit changing one story (e.g. a button label), confirm `visual` fails, annotates
   that story and uploads `visual-report`; then revert it (`git revert`) and confirm green. Mention both run links in the PR.

## Out of scope

- Chromatic, Percy, Argos, Applitools, Git LFS, any token or secret.
- Page-level stories and the Editor's panels (Later waves above).
- Fixing visual bugs found in stories (list them as findings).
- Changing branch protection.
- Storybook docs/autodocs, interaction tests (`play` functions), a11y addon, publishing Storybook anywhere (Vercel or
  Pages). The static build is a CI artifact only.
- Replacing the existing `*-browser.test.ts` harnesses.

## Done criteria

- [ ] Storybook 10.6.1 builds in CI (`visual` job) and runs locally (`pnpm storybook`).
- [ ] Stories for all 23 `ui/*` components, the Wave 1 shared components, all listed charts, and the map stories covering
      step, terminal, group (open and closed), branch and handoff edges; every one in light and dark; charts and map at 400 px.
- [ ] `visual` job compares on every push touching UI code, fails on any unapproved diff, annotates failing stories and
      uploads the report.
- [ ] `[visual-update]` flow works end to end on this PR (baselines committed by the job, second pass green).
- [ ] `docs/visual-regression.md` documents: how to run Storybook, the approve command, local runs vs baselines, Docker,
      what to do after an engine version bump, how to add a story (and that the coverage test requires one).
- [ ] `pnpm lint && pnpm typecheck && pnpm test` and the web build green; `check` green.
- [ ] PR body (`pr` skill) lists Deferred components, Findings, the gate-proof run links, and the open-question defaults
      taken.

## Open questions (each with a default)

1. **Start before Austin's UI kit exists?** (#43: "Best done once Austin's UI kit exists.") **Default: yes.** Baselines
   capture today's radix-nova look; when the kit lands, one `[visual-update]` commit refreshes them. Record on #43.
2. **Make `visual` a required check?** **Default: no** in this ticket; recommend it to Austin after a week without
   flakes. Recorded under "Design calls Claude made" in the handover.
3. **`GITHUB_TOKEN` can't push (org caps it at read)?** **Default:** the job fails clearly and uploads `visual-baselines`;
   the builder downloads it if the MCP tools give a usable URL and commits the PNGs, else stops and reports. No PAT.
4. **`@storybook/react-vite` vs `@storybook/nextjs-vite`?** **Default: react-vite** with our stubs (above). Switch only
   if a Wave 1 component needs something the stubs can't give; say so in the PR.
5. **Shot count/size** (~130 PNGs, ~5 MB in git, growing with each wave). **Default: accept**; if the PNG folder passes
   25 MB, raise moving to a baseline branch with Austin.
6. **Theme toggle in the app?** None exists; Storybook's toolbar is test-only. **Default: don't add one** (product call).
7. **Engine-driven fixtures couple charts to golden numbers.** **Default: accept** (one `[visual-update]` on engine bumps,
   documented); hand-written fixtures where a chart takes plain arrays.
8. **`--update-snapshots=all` rewrites unchanged files?** Playwright re-encodes identical pixels to identical bytes, so
   git sees no change. **Default: `all` + prune.** If git shows byte churn on unchanged images, switch to `changed` (check
   the Playwright 1.63 CLI help for its semantics) and say so.
