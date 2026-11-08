import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, expectNothingEscapes, open, watchErrors } from "./checks";
import { E2E_ROUTES } from "./routes";

// Tablets (640px and up) keep every feature (issue #44).
for (const size of [
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
]) {
  test.describe(`tablet, ${size.width}px`, () => {
    test.use({ viewport: size });
    for (const { path } of E2E_ROUTES) {
      test(path, async ({ page }) => {
        const errors = watchErrors(page);
        await open(page, path);
        await expectNoSidewaysScroll(page);
        await expectNothingEscapes(page);
        await expect(page.locator("[data-phone-notice], [data-phone-read-only]")).toHaveCount(0);
        expect(errors.list()).toEqual([]);
      });
    }
  });
}
