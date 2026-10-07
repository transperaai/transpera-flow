import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_ROUTES, SKIPPED } from "../e2e/routes";

// The e2e crawl (issue #44) opens every demo page. A new demo page must be listed there, or skipped with a reason.
const DEMO = join(__dirname, "../src/app/demo");

function pages(dir: string, prefix: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) pages(join(dir, e.name), `${prefix}/${e.name}`, out);
    else if (e.name === "page.tsx") out.push(prefix);
  }
  return out;
}

describe("the e2e crawl covers every demo page", () => {
  const found = pages(DEMO, "/demo");
  it("finds the demo pages", () => {
    expect(found.length).toBeGreaterThan(15);
  });
  it("lists each one in DEMO_ROUTES or SKIPPED", () => {
    const known = new Set([...DEMO_ROUTES.map((r) => r.route), ...Object.keys(SKIPPED)]);
    expect(found.filter((r) => !known.has(r))).toEqual([]);
  });
  it("lists only pages that exist", () => {
    const exist = new Set(found);
    const extra = [...DEMO_ROUTES.map((r) => r.route), ...Object.keys(SKIPPED)].filter((r) => r.startsWith("/demo") && !exist.has(r));
    expect(extra).toEqual([]);
  });
  it("gives every skip a reason", () => {
    for (const [route, why] of Object.entries(SKIPPED)) expect(why.length, route).toBeGreaterThan(10);
  });
});
