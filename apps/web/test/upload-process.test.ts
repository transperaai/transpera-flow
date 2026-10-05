import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, downloadHref, isRedirect, sourceLabel, uploadSizeProblem } from "@/lib/processes/upload";
import { noticeValue, parseNotice } from "@/lib/processes/upload-notice";

// The small rules behind the Upload process dialog (issue #166): what a file name becomes in the change log, and which
// files are refused before they are read.

describe("sourceLabel", () => {
  it("keeps the file name and drops folders", () => {
    expect(sourceLabel("enquiry.json")).toBe("enquiry.json");
    expect(sourceLabel("C:\\Users\\sam\\Desktop\\enquiry.json")).toBe("enquiry.json");
    expect(sourceLabel("/home/sam/enquiry.json")).toBe("enquiry.json");
  });

  it("drops control characters, and falls back when nothing is left", () => {
    expect(sourceLabel("en\u0000quiry\n.json")).toBe("enquiry.json");
    expect(sourceLabel("   ")).toBe("uploaded file");
    expect(sourceLabel("")).toBe("uploaded file");
  });

  it("logs a link as its origin and path, without the query string, fragment or credentials", () => {
    expect(sourceLabel("https://claude.ai/design/abc?token=SECRET&x=1#frag")).toBe("https://claude.ai/design/abc");
    expect(sourceLabel("https://user:pw@example.com/p?k=v")).toBe("https://example.com/p");
    expect(sourceLabel("https://example.com")).toBe("https://example.com/");
    expect(sourceLabel("https://exa mple.com/p?token=SECRET")).not.toContain("SECRET");
  });

  it("cuts a very long name", () => {
    expect(sourceLabel(`${"a".repeat(300)}.json`)).toHaveLength(200);
  });
});

describe("uploadSizeProblem", () => {
  it("accepts a process-sized file and refuses a huge one in plain words", () => {
    expect(uploadSizeProblem(20_000)).toBeNull();
    expect(uploadSizeProblem(MAX_UPLOAD_BYTES)).toBeNull();
    expect(uploadSizeProblem(MAX_UPLOAD_BYTES + 1)).toMatch(/probably the wrong file/);
    expect(uploadSizeProblem(2_500_000)).toContain("2,500 KB");
  });
});

describe("downloadHref", () => {
  it("is a JSON data link that decodes back to the text", () => {
    const text = '{"a": "é & ü"}\n';
    const href = downloadHref(text);
    expect(href.startsWith("data:application/json;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(href.split(",").slice(1).join(","))).toBe(text);
  });
});

describe("isRedirect", () => {
  it("is true only for the error redirect() throws", () => {
    expect(isRedirect(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/w/x;307;" }))).toBe(true);
    expect(isRedirect(new Error("network down"))).toBe(false);
    expect(isRedirect(Object.assign(new Error("x"), { digest: "something else" }))).toBe(false);
    expect(isRedirect(null)).toBe(false);
    expect(isRedirect("NEXT_REDIRECT")).toBe(false);
  });
});

describe("the note an upload leaves for the editor", () => {
  const id = "10000000-0000-4000-8000-000000000001";

  it("round-trips a few warnings, and leaves nothing when there are none", () => {
    expect(noticeValue(id, [])).toBeNull();
    expect(parseNotice(noticeValue(id, ["One step has no role."])!)).toEqual({ processId: id, warnings: ["One step has no role."] });
  });

  it("keeps the first five, cuts long ones, and says how many more", () => {
    const value = noticeValue(id, Array.from({ length: 9 }, (_, i) => `${i} ${"w".repeat(400)}`))!;
    expect(value.length).toBeLessThan(3_500);
    const { warnings } = parseNotice(value)!;
    expect(warnings).toHaveLength(6);
    expect(warnings[0]!.length).toBeLessThanOrEqual(220);
    expect(warnings[5]).toBe("…and 4 more. They show on the map and the checklist.");
  });

  it("ignores anything that isn't a notice", () => {
    for (const bad of ["", "nope", "[]", "null", '{"processId":1,"warnings":[]}', '{"processId":"x","warnings":[1]}']) expect(parseNotice(bad), bad).toBeNull();
  });
});
