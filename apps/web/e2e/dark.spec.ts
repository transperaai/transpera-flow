import { expect, test } from "@playwright/test";
import { darkProblems, open, watchErrors } from "./checks";
import { DEMO_ROUTES } from "./routes";

// Dark mode draws no light surface and no dark text on a dark one (issue #44). A client logo sits on white by design
// (issue #34) and is marked `data-allow-light`.
test.describe("dark, 1280px", () => {
  test.use({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  for (const { path } of DEMO_ROUTES) {
    test(path, async ({ page }) => {
      const errors = watchErrors(page);
      await open(page, path);
      expect(await darkProblems(page)).toEqual([]);
      expect(errors.list()).toEqual([]);
    });
  }
});
