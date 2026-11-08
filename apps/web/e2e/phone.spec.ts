import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, expectNothingEscapes, expectReadOnly, open, watchErrors } from "./checks";
import { E2E_ROUTES } from "./routes";

// Phones (under 640px) are read-only and nothing scrolls sideways (issue #44).
test.describe("phone, 400px", () => {
  test.use({ viewport: { width: 400, height: 900 } });
  for (const { path } of E2E_ROUTES) {
    test(path, async ({ page }) => {
      const errors = watchErrors(page);
      await open(page, path);
      await expectNoSidewaysScroll(page);
      await expectNothingEscapes(page);
      await expectReadOnly(page);
      // No text tells a phone to use a control it doesn't have (`innerText` leaves out what CSS hides).
      expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/press Open in Editor|drag a marker/i);
      expect(errors.list()).toEqual([]);
    });
  }
});
