import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PHONE_QUERY } from "../src/hooks/use-mobile";
import { EDIT_ONLY } from "../src/lib/phone";

// Issue #44: a phone is under Tailwind's `sm` (640px), width only.
describe("phones", () => {
  it("are under 640px wide", () => {
    expect(PHONE_QUERY).toBe("(max-width: 639px)");
  });
  it("hide edit entries with Tailwind's max-sm", () => {
    expect(EDIT_ONLY).toBe("max-sm:hidden");
  });
  it("leave the sidebar breakpoint alone", () => {
    expect(readFileSync(new URL("../src/hooks/use-mobile.ts", import.meta.url), "utf8")).toContain('const QUERY = "(max-width: 1023px)"');
  });
});
