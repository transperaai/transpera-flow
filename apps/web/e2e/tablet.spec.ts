import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, expectNothingEscapes, open, watchErrors } from "./checks";
import { DEMO_ROUTES } from "./routes";

// Tablets (640px and up) keep every feature (issue #44).
for (const size of [
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
]) {
  test.describe(`tablet, ${size.width}px`, () => {
    test.use({ viewport: size });
    for (const { path, route } of DEMO_ROUTES) {
      test(path, async ({ page }) => {
        const errors = watchErrors(page);
        await open(page, path);
        await expectNoSidewaysScroll(page);
        await expectNothingEscapes(page);
        await expect(page.locator("[data-phone-notice], [data-phone-read-only]")).toHaveCount(0);
        if (route === "/demo/edit") {
          await expect(page.locator(".react-flow").first()).toBeVisible();
          await expect(page.locator("[data-phone-gate]")).toHaveCount(0);
        }
        if (route === "/demo/p/[processId]") await expect(page.getByRole("link", { name: /open in editor/i })).toBeVisible();
        expect(errors.list()).toEqual([]);
      });
    }
  });
}
