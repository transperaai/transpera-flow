import { describe, expect, it } from "vitest";
import { AFTER_SIGN_IN_COOKIE, SHARE_TOKEN, afterSignInPath } from "@/lib/share/after-sign-in";
import { daysFromNow, parseEmails, parseShareInput, MAX_EMAILS, type ShareInput } from "@/lib/share/input";
import { openedText, shareDate, shareStatus, showsFinancials, showsPeople, whoText } from "@/lib/share/format";
import { isInternalHref } from "@/components/share/inert-links";
import { workspaceNav, flatItems } from "@/lib/shell/nav";

// What a person types into the Share dialog (issue #32, B3), the sign-in return path, and the small pure helpers around them.

const NOW = new Date("2026-10-06T12:00:00Z");
const ID = "0d5f6f0e-0000-4000-8000-000000000001";
const input = (over: Partial<ShareInput> = {}): ShareInput => ({ kind: "overview", targetId: null, people: false, financials: false, emails: "", expiresOn: null, label: "", ...over });
const parse = (over: Partial<ShareInput> = {}) => parseShareInput(input(over), NOW);
const message = (over: Partial<ShareInput>) => {
  const r = parse(over);
  return r.ok ? null : r.message;
};

describe("parseShareInput", () => {
  it("accepts an open link: both switches off, no emails, no end date", () => {
    expect(parse()).toEqual({ ok: true, value: { kind: "overview", targetId: null, people: false, financials: false, emails: [], expiresAt: null, label: null } });
  });

  it("an open link may still have an end date, which is the end of that day (UTC)", () => {
    const r = parse({ expiresOn: "2026-10-07" });
    expect(r).toMatchObject({ ok: true, value: { expiresAt: "2026-10-07T23:59:59.000Z" } });
  });

  it("a switch on needs an address, and then an end date", () => {
    for (const toggle of [{ people: true }, { financials: true }, { people: true, financials: true }]) {
      expect(message({ ...toggle, expiresOn: "2026-11-01" })).toBe("Add at least one email address.");
      expect(message({ ...toggle, emails: "a@x.example" })).toBe("Choose when the link stops working.");
      expect(parse({ ...toggle, emails: "a@x.example", expiresOn: "2026-11-01" }).ok).toBe(true);
    }
    // Both missing: the address first.
    expect(message({ people: true })).toBe("Add at least one email address.");
  });

  it("splits addresses on commas, semicolons, spaces and new lines; lower-cases; drops duplicates; keeps the order", () => {
    expect(parseEmails("Sam@X.example, ops@x.example;\n sam@x.example   Ana@x.example")).toEqual(["sam@x.example", "ops@x.example", "ana@x.example"]);
    const r = parse({ people: true, emails: "B@x.example a@x.example b@x.example", expiresOn: "2026-11-01" });
    expect(r).toMatchObject({ ok: true, value: { emails: ["b@x.example", "a@x.example"] } });
  });

  it("refuses a bad address by name, and more than 50", () => {
    expect(message({ people: true, emails: "a@x.example, nope", expiresOn: "2026-11-01" })).toBe("“nope” isn't an email address.");
    expect(message({ people: true, emails: "a@@x.example", expiresOn: "2026-11-01" })).toMatch(/isn't an email address/);
    const many = Array.from({ length: MAX_EMAILS + 1 }, (_, i) => `p${i}@x.example`).join(", ");
    expect(message({ people: true, emails: many, expiresOn: "2026-11-01" })).toBe("Add no more than 50 email addresses.");
    expect(parse({ people: true, emails: many.split(", ").slice(0, MAX_EMAILS).join(", "), expiresOn: "2026-11-01" }).ok).toBe(true);
  });

  it("addresses are ignored when both switches are off (the link is open to anyone)", () => {
    expect(parse({ emails: "nope" })).toMatchObject({ ok: true, value: { emails: [] } });
  });

  it("the end date must be a real day after today", () => {
    expect(message({ expiresOn: "2026-10-06" })).toBe("Choose a day after today.");
    expect(message({ expiresOn: "2026-10-01" })).toBe("Choose a day after today.");
    expect(message({ expiresOn: "2026-02-31" })).toBe("Choose when the link stops working.");
    expect(message({ expiresOn: "tomorrow" })).toBe("Choose when the link stops working.");
    expect(parse({ expiresOn: "2026-10-07" }).ok).toBe(true);
  });

  it("the name is trimmed, empty is none, and 120 characters is the most", () => {
    expect(parse({ label: "  For the board  " })).toMatchObject({ ok: true, value: { label: "For the board" } });
    expect(parse({ label: "   " })).toMatchObject({ ok: true, value: { label: null } });
    expect(parse({ label: "x".repeat(120) }).ok).toBe(true);
    expect(message({ label: "x".repeat(121) })).toBe("Keep the name under 120 characters.");
  });

  it("a page other than the Overview needs its id; the Overview takes none", () => {
    expect(message({ kind: "process", targetId: null })).toBe("Choose a page to share.");
    expect(message({ kind: "issue", targetId: "nope" })).toBe("Choose a page to share.");
    expect(parse({ kind: "solution", targetId: ID })).toMatchObject({ ok: true, value: { kind: "solution", targetId: ID } });
    expect(message({ kind: "overview", targetId: ID })).toBe("Something went wrong. Try again.");
    expect(message({ kind: "page" as never })).toBe("Choose a page to share.");
    expect(parseShareInput(null, NOW)).toMatchObject({ ok: false });
  });

  it("the dialog's default end date is 30 days on", () => {
    expect(daysFromNow(30, NOW)).toBe("2026-11-05");
    expect(parse({ expiresOn: daysFromNow(30, NOW) }).ok).toBe(true);
  });
});

describe("afterSignInPath (the callback's cookie check)", () => {
  const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
  it("has a 43-character token and a fixed cookie name", () => {
    expect(token).toHaveLength(43);
    expect(SHARE_TOKEN.test(token)).toBe(true);
    expect(AFTER_SIGN_IN_COOKIE).toBe("tf_after_sign_in");
  });
  it("accepts only /s/<43 token characters>, plain or URL-encoded", () => {
    expect(afterSignInPath(`/s/${token}`)).toBe(`/s/${token}`);
    expect(afterSignInPath(encodeURIComponent(`/s/${token}`))).toBe(`/s/${token}`);
  });
  it("ignores everything else: no open redirect", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "/",
      "/w/northbeam",
      `/s/${token}x`,
      `/s/${token.slice(1)}`,
      `/s/${token}/`,
      `/s/${token}?next=https://evil.example`,
      `//evil.example/s/${token}`,
      `https://evil.example/s/${token}`,
      `/s/${token}\n/login`,
      `/s/${token.slice(0, 42)}!`,
      "/%2e%2e/s",
      "%",
    ]) {
      expect(afterSignInPath(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });
});

describe("the callback and the sign-in action use it", () => {
  it("reads the cookie before the query is cleared, honours only the checked path, and always drops it", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync(new URL("../src/app/auth/callback/route.ts", import.meta.url), "utf8");
    expect(route.indexOf("afterSignInPath(request.cookies.get(AFTER_SIGN_IN_COOKIE)")).toBeGreaterThan(0);
    expect(route.indexOf("afterSignInPath(")).toBeLessThan(route.indexOf("url.search = \"\""));
    expect(route).toContain('url.pathname = back ?? "/"');
    expect(route).toContain("response.cookies.delete(AFTER_SIGN_IN_COOKIE)");
    // No `next` query parameter: Supabase's redirect allow-list would need changing.
    expect(route).not.toMatch(/searchParams\.get\("next"\)/);
    const action = readFileSync(new URL("../src/app/s/[token]/actions.ts", import.meta.url), "utf8");
    expect(action).toMatch(/httpOnly:\s*true/);
    expect(action).toMatch(/sameSite:\s*"lax"/);
    expect(action).toMatch(/path:\s*"\/"/);
    expect(action).toMatch(/maxAge:\s*AFTER_SIGN_IN_MAX_AGE_SECONDS/);
    expect(action).toContain('process.env.NODE_ENV === "production"');
    expect(action).toContain("SHARE_TOKEN.test(token)");
  });
});

describe("the sidebar item", () => {
  const nav = (over: { canEdit?: boolean; pathname?: string } = {}) => workspaceNav({ slug: "s", pathname: over.pathname ?? "/w/s", canManage: true, canEdit: over.canEdit, counts: {} });
  it("Share links follows Access, for owners and editors only", () => {
    const keys = flatItems(nav({ canEdit: true })).map((i) => i.key);
    expect(keys.slice(-2)).toEqual(["access", "share"]);
    const share = flatItems(nav({ canEdit: true })).find((i) => i.key === "share")!;
    expect(share).toMatchObject({ label: "Share links", href: "/w/s/share", icon: "share", active: false });
    expect(flatItems(nav({ canEdit: false })).map((i) => i.key)).not.toContain("share");
    expect(flatItems(nav()).map((i) => i.key)).not.toContain("share");
  });
  it("is active on its page", () => {
    expect(flatItems(nav({ canEdit: true, pathname: "/w/s/share" })).filter((i) => i.active).map((i) => i.key)).toEqual(["share"]);
  });
});

describe("the small helpers", () => {
  it("dates are UTC and the same everywhere", () => {
    expect(shareDate("2026-10-05T23:59:59Z")).toBe("5 Oct 2026");
    expect(shareDate("2026-11-05T00:00:00Z")).toBe("5 Nov 2026");
  });
  it("status: turned off beats expired beats active", () => {
    expect(shareStatus({ revokedAt: null, expiresAt: null }, NOW)).toBe("active");
    expect(shareStatus({ revokedAt: null, expiresAt: "2026-10-06T12:00:01Z" }, NOW)).toBe("active");
    expect(shareStatus({ revokedAt: null, expiresAt: "2026-10-06T12:00:00Z" }, NOW)).toBe("expired");
    expect(shareStatus({ revokedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-09-01T00:00:00Z" }, NOW)).toBe("off");
  });
  it("opens, shows and who read plainly", () => {
    expect(openedText(0, null)).toBe("Not yet");
    expect(openedText(1, "2026-10-05T10:00:00Z")).toBe("Once, last 5 Oct");
    expect(openedText(3, "2026-10-05T10:00:00Z")).toBe("3 times, last 5 Oct");
    expect(showsPeople(false)).toBe("Team member labels");
    expect(showsPeople(true)).toBe("Names");
    expect(showsFinancials(false)).toBe("Revenue only");
    expect(showsFinancials(true)).toBe("Costs and margins");
    expect(whoText([])).toBe("Anyone with the link");
    expect(whoText(["a@x.example"])).toBe("1 person");
    expect(whoText(["a@x.example", "b@x.example"])).toBe("2 people");
  });
  it("links to other pages of the workspace are inert in a shared view; external and in-page ones are not", () => {
    for (const internal of ["", "/", "/w/northbeam/issues/3", "/p/abc"]) expect(isInternalHref(internal), internal).toBe(true);
    for (const other of ["#section", "https://example.com/x", "//cdn.example.com/x", "mailto:a@b.example", null]) expect(isInternalHref(other), String(other)).toBe(false);
  });
});
