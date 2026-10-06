import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Only agency admins, owners and editors may export the JSON backup (issue #39, B10 2a). The route answers 403 to anyone else
// (export-bundle-route.test.ts); this keeps the Overview from offering the item to people who would only be refused.

const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

describe("the JSON backup item", () => {
  it("is offered on the Overview only to people who can edit", () => {
    const page = read("components/overview/workspace-overview.tsx");
    expect(page).toContain("bundleHref={canEdit ? `${base}/export/bundle` : undefined}");
    expect(page).not.toContain("bundleHref={`${base}/export/bundle`}");
  });
});
