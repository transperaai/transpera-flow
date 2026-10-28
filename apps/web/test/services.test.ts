import { describe, expect, it } from "vitest";
import { northbeamServiceIds } from "@transpera-flow/db";
import { formatTags, isTagList, mixPercentages, parseNewService, parseServiceField, parseTags } from "@/lib/services";

// Input checks behind the services settings' Server Actions (issue #12).

const seo = northbeamServiceIds.seo;
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("parseServiceField", () => {
  it("accepts each field's valid values, trimming text", () => {
    expect(parseServiceField(seo, "name", "SEO retainer", "  SEO  ")).toEqual({ serviceId: seo, field: "name", base: "SEO retainer", value: "SEO" });
    expect(parseServiceField(seo, "pricing_model", "retainer", "one_off")?.value).toBe("one_off");
    expect(parseServiceField(seo, "price", 3500, 0)?.value).toBe(0);
    expect(parseServiceField(seo, "margin", 0.45, 1)?.value).toBe(1);
    expect(parseServiceField(seo, "tenure_months", 18, 0)?.value).toBe(0);
    expect(parseServiceField(seo, "churn_monthly_base", 0.03, 0.5)?.value).toBe(0.5);
    expect(parseServiceField(seo, "mix_share", 0.55, 0)?.value).toBe(0);
    expect(parseServiceField(seo, "entry_process_id", null, "c0000000-0000-4000-8000-000000000001")).not.toBeNull();
    expect(parseServiceField(seo, "entry_process_id", "c0000000-0000-4000-8000-000000000001", null)).not.toBeNull();
    expect(parseServiceField(seo, "active", true, false)?.value).toBe(false);
  });

  it("accepts a fee range (a low and a high, or none) and refuses a negative or absurd one", () => {
    expect(parseServiceField(seo, "price_low", null, 3000)?.value).toBe(3000);
    expect(parseServiceField(seo, "price_high", 6000, null)?.value).toBeNull();
    expect(parseServiceField(seo, "price_high", null, "6000")).toBeNull();
    expect(parseServiceField(seo, "price_low", null, -1)).toBeNull();
    expect(parseServiceField(seo, "price_high", null, 1e9)).toBeNull();
  });

  it.each([
    ["name", ""],
    ["name", "   "],
    ["name", "x".repeat(201)],
    ["name", null],
    ["pricing_model", "subscription"],
    ["pricing_model", null],
    ["price", -1],
    ["price", "3500"],
    ["price", Number.NaN],
    ["price", Number.POSITIVE_INFINITY],
    ["price", 1e9],
    ["margin", 1.01],
    ["margin", -0.01],
    ["tenure_months", -1],
    ["tenure_months", 601],
    ["churn_monthly_base", 1.5],
    ["mix_share", -0.1],
    ["mix_share", null],
    ["entry_process_id", "not-a-uuid"],
    ["active", "true"],
  ])("rejects %s = %s", (field, value) => {
    expect(parseServiceField(seo, field, null, value)).toBeNull();
  });

  it("rejects unknown and fixed columns, bad ids and non-scalar bases", () => {
    expect(parseServiceField(seo, "workspace_id", null, seo)).toBeNull();
    expect(parseServiceField(seo, "path_tags", [], "seo")).toBeNull();
    expect(parseServiceField(seo, "toString", null, "x")).toBeNull();
    expect(parseServiceField("seo", "price", 1, 2)).toBeNull();
    expect(parseServiceField(seo, "price", { a: 1 }, 2)).toBeNull();
  });
});

describe("path tags", () => {
  it("parses what people type into a clean list", () => {
    expect(parseTags("seo, ppc")).toEqual(["seo", "ppc"]);
    expect(parseTags(" seo ,, PPC , seo ")).toEqual(["seo", "PPC"]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags(" , ")).toEqual([]);
    expect(formatTags(parseTags("a,b"))).toBe("a, b");
  });

  it("accepts only clean lists for saving", () => {
    expect(isTagList([])).toBe(true);
    expect(isTagList(["seo", "ppc"])).toBe(true);
    expect(isTagList(["seo", "seo"])).toBe(false);
    expect(isTagList([" seo"])).toBe(false);
    expect(isTagList([""])).toBe(false);
    expect(isTagList(["a,b"])).toBe(false);
    expect(isTagList(["x".repeat(101)])).toBe(false);
    expect(isTagList(Array.from({ length: 21 }, (_, i) => `t${i}`))).toBe(false);
    expect(isTagList("seo")).toBe(false);
    expect(isTagList([1])).toBe(false);
  });
});

describe("parseNewService", () => {
  it("reads the add-service form", () => {
    expect(parseNewService(form({ name: " Content ", pricing_model: "one_off", price: "1200" }))).toEqual({
      name: "Content",
      pricing_model: "one_off",
      price: 1200,
    });
    // A blank price is 0, to be set afterwards.
    expect(parseNewService(form({ name: "Audit", pricing_model: "retainer", price: "" }))).toMatchObject({ price: 0 });
  });

  it("explains what's wrong", () => {
    expect(parseNewService(form({ name: " ", pricing_model: "retainer" }))).toEqual({ error: "Enter a name." });
    expect(parseNewService(form({ name: "X", pricing_model: "barter" }))).toEqual({ error: "Pick a pricing model." });
    expect(parseNewService(form({ name: "X", pricing_model: "hourly", price: "-5" }))).toEqual({ error: "Enter a price of 0 or more." });
    expect(parseNewService(form({ name: "X", pricing_model: "hourly", price: "abc" }))).toEqual({ error: "Enter a price of 0 or more." });
  });
});

describe("mixPercentages", () => {
  it("normalises mix shares over active services", () => {
    const mix = mixPercentages([
      { id: "a", mix_share: 0.55, active: true },
      { id: "b", mix_share: 0.45, active: true },
      { id: "c", mix_share: 5, active: false },
    ])!;
    expect(mix.get("a")).toBeCloseTo(0.55);
    expect(mix.get("b")).toBeCloseTo(0.45);
    expect(mix.has("c")).toBe(false);
  });

  it("is null when the shares add up to nothing", () => {
    expect(mixPercentages([{ id: "a", mix_share: 0, active: true }])).toBeNull();
    expect(mixPercentages([])).toBeNull();
  });
});
