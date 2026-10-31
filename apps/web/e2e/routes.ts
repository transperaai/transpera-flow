/**
 * The pages the e2e crawl opens: the ones that open without a database or sign-in. The public demo pages (`/demo/**`) are gone, so
 * for now this is the privacy page; a page behind sign-in joins the list when the crawl can sign in. `route` is the file's route
 * pattern (`test/e2e-routes.test.ts` checks that each exists under `src/app`).
 */
export const E2E_ROUTES: { path: string; route: string }[] = [{ route: "/privacy", path: "/privacy" }];
