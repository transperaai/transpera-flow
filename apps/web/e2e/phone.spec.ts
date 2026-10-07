import { expect, test } from "@playwright/test";
import { editControls, expectNoSidewaysScroll, expectNothingEscapes, expectReadOnly, open, watchErrors } from "./checks";
import { DEMO_ROUTES } from "./routes";

// Phones (under 640px) are read-only and nothing scrolls sideways (issue #44).
test.describe("phone, 400px", () => {
  test.use({ viewport: { width: 400, height: 900 } });
  for (const { path } of DEMO_ROUTES) {
    test(path, async ({ page }) => {
      const errors = watchErrors(page);
      await open(page, path);
      await expectNoSidewaysScroll(page);
      await expectNothingEscapes(page);
      if (path === "/demo/edit") {
        await expect(page.locator("[data-phone-gate]")).toBeVisible();
        await expect(page.locator(".react-flow")).toHaveCount(0);
      }
      await expectReadOnly(page);
      expect(errors.list()).toEqual([]);
    });
  }
});

// The read-only check must be able to find something: on a wide screen the process page has "Open in Editor".
test.describe("sanity, 1280px", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("the edit-control check finds Open in Editor on the process page", async ({ page }) => {
    await open(page, DEMO_ROUTES.find((r) => r.route === "/demo/p/[processId]")!.path);
    expect((await editControls(page)).join("\n")).toMatch(/open in editor/i);
  });
});
