import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { E2E_ROUTES } from "../e2e/routes";

// The e2e crawl (issue #44) opens the pages that need no sign-in. Each one it lists must exist.
describe("the e2e crawl", () => {
  it("lists at least one page", () => expect(E2E_ROUTES.length).toBeGreaterThan(0));
  it("lists only pages that exist", () => {
    const missing = E2E_ROUTES.filter((r) => !existsSync(join(__dirname, "../src/app", r.route, "page.tsx"))).map((r) => r.route);
    expect(missing).toEqual([]);
  });
  it("lists no demo page: /demo is gone", () => {
    expect(E2E_ROUTES.filter((r) => r.route.startsWith("/demo"))).toEqual([]);
    expect(existsSync(join(__dirname, "../src/app/demo"))).toBe(false);
  });
});
