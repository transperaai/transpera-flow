# Storybook and visual regression

Storybook shows every shared component, chart and the process map in isolation. A Playwright suite screenshots every story
in the light and dark theme (and at 400 px for stories tagged `visual-phone`) and CI fails when a picture differs from its
committed baseline without anyone having approved it. No external service, no secret, no Git LFS.

## Run Storybook

```sh
pnpm storybook                                   # http://localhost:6006
pnpm --filter @transpera-flow/web build-storybook  # static build into apps/web/storybook-static
```

Use the Theme switch in the toolbar for light and dark. The stories render the real components with the app's own
`globals.css` and self-hosted fonts (`@fontsource`), so what you see is what the app draws. `next/link`, `next/navigation`
and `next/dynamic` are replaced by the stand-ins in `apps/web/test/build-harness-stubs/`, and Server Actions answer with an
error ("Not available in Storybook"). Stories use fixtures from `apps/web/stories/fixtures.ts` (Northbeam, one fixed run, a
fixed start date). Never use `new Date()` or random data in a story.

## How the comparison works

- `apps/web/visual/stories.spec.ts` reads the built Storybook's `index.json` and, for each story and theme, loads it in
  Chromium (1280 x 800, `en-GB`, `Europe/London`, a fixed clock, reduced motion), waits for the fonts, parks the mouse at the
  corner and calls `toHaveScreenshot`. It also fails on any console error or Storybook error page.
- `maxDiffPixels` is 0: any pixel past the per-pixel colour tolerance fails. There is no ratio that could hide a 1 px change.
- Baselines are PNGs in `apps/web/visual/__screenshots__/<story-id>--<theme>[--400].png`.
- **Baselines are made only inside the pinned Playwright image** `mcr.microsoft.com/playwright:v1.63.0-noble`, where Chromium,
  fonts and freetype are identical on every run. The image tag must equal the `@playwright/test` version; the config throws
  if they disagree, so bumping Playwright means bumping the image (in `.github/workflows/ci.yml` and here) too.

## Approving a visual change

CI's `visual` job (parallel to `check`, in the Playwright image) compares every push that touches UI code. If it fails, open
the run: the failing stories are annotated and listed in the job summary, and the `visual-report` artifact holds the HTML
report with expected, actual and diff side by side. If the change is intended:

```sh
git commit --allow-empty -m "Approve visual changes [visual-update]"
git push
```

The `visual` job sees `[visual-update]` in the commit subject, regenerates all baselines, deletes baselines whose story no
longer exists, runs the comparison again to prove the new baselines are stable, and commits the PNGs to your branch as
"Update visual baselines". Never on `main`.

1. `git pull --rebase` to get that commit.
2. Pushes made with `GITHUB_TOKEN` don't start workflows, so push any commit (an empty one is fine) so `check` and `visual`
   run on the new head. Branch protection needs `check` on the head SHA.
3. The reviewer opens the PR's "Files changed": GitHub renders PNG diffs (2-up, swipe, onion skin). Check that each changed
   image is intended.

A **new story** has no baseline, so `visual` fails with "missing snapshot" until you run the approve step. That is intended.

If `git push` from the job is refused (the organisation caps `GITHUB_TOKEN` at read), the job fails with a clear message and
uploads the regenerated PNGs as the artifact `visual-baselines`; unzip it into `apps/web/visual/__screenshots__/` and commit.

## Local runs

A local run uses your machine's Chromium, whose pixels differ from CI's, so it never reads or writes the committed
baselines: it uses the git-ignored `apps/web/visual/.local-screenshots/` instead. Use it to check your story renders and is
stable:

```sh
export CHROMIUM_PATH=/path/to/chrome            # or let Playwright use its own browser
pnpm --filter @transpera-flow/web build-storybook
pnpm --filter @transpera-flow/web visual:update  # writes .local-screenshots
pnpm --filter @transpera-flow/web visual         # compare; run it twice to prove stability
```

Look at the PNGs in `.local-screenshots/` to see what the story looks like.

### With Docker

Anyone with Docker can make the real baselines locally, in the same image CI uses:

```sh
pnpm --filter @transpera-flow/web visual:docker                           # compare
pnpm --filter @transpera-flow/web visual:docker --update-snapshots=all   # rewrite the baselines
```

## Adding a story

1. Add `apps/web/stories/<ui|shared|charts|map>/<name>.stories.tsx`. Title it `UI/<Name>`, `Shared/<Name>`, `Charts/<Name>`
   or `Map/<Name>`. Prefer one story per component that shows every variant, size and state in a grid (`Variants`); add a
   separate story only where a state can't share a frame (an open overlay, an empty state).
2. Tags (read by the suite from `index.json`): `visual-page` screenshots the whole viewport instead of `#storybook-root`
   (needed for anything in a portal: an open dialog, sheet, popover, menu, select, tooltip); `visual-phone` also shoots at
   400 px; `visual-skip` leaves the story out (say why in a comment).
3. A story that needs time to reach its picture marks its wrapper `data-visual-pending` until it is ready (see `HighlightMap`
   in `stories/map/process-canvas.stories.tsx`).
4. **The coverage test requires it.** `apps/web/test/stories-coverage.test.ts` (part of `pnpm test`) fails when a file in
   `src/components/ui` has no `stories/ui/<same-name>.stories.tsx`, or when a shared component or chart on its `SHARED` or
   `CHARTS` lists is not used by any story. Add a new shared component or chart to those lists.
5. Run `build-storybook`, then the local `visual:update` and `visual` twice, then push and approve with `[visual-update]`.

## After an engine version bump

The chart and map stories render real engine output (Northbeam, 30 runs, seed 1), so a change that moves the golden numbers
(`docs/engine-versioning.md`) also moves those baselines. That PR approves them with `[visual-update]`, as above.

## Not covered yet

Page-level compositions (Overview, process page, issues, sources) and dialogs such as `acknowledge-dialog`, `finding-dialog`
and `source-dialog`, the Editor's palette and inspector, and the playback layer. `visual` is not a required check in branch
protection; that is a call for the repository owner once it has run for a while without flakes.
