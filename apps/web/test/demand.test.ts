import { describe, expect, it } from "vitest";
import { northbeamBundle, northbeamLeadSourceIds } from "@transpera-flow/db";
import {
  demandSummary,
  isGrowth,
  isMonth,
  isMultiplier,
  parseLeadSourceField,
  parseNewLeadSource,
  provenanceOf,
} from "@/lib/demand";

// Input checks and figures behind the demand settings (issue #13).

const website = northbeamLeadSourceIds.website;
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("parseLeadSourceField", () => {
  it("accepts each field's valid values, trimming text", () => {
    expect(parseLeadSourceField(website, "name", "Website", "  Site  ")).toEqual({
      sourceId: website,
      field: "name",
      base: "Website",
      value: "Site",
    });
    expect(parseLeadSourceField(website, "volume_week", 8, 0)?.value).toBe(0);
    expect(parseLeadSourceField(website, "volume_week", 8, 12.5)?.value).toBe(12.5);
    expect(parseLeadSourceField(website, "conversion_to_qualified", 0.25, 1)?.value).toBe(1);
    expect(parseLeadSourceField(website, "conversion_to_qualified", "0.25", 0)?.value).toBe(0);
  });

  it.each([
    ["name", ""],
    ["name", "x".repeat(201)],
    ["volume_week", -1],
    ["volume_week", 1e6],
    ["volume_week", "8"],
    ["volume_week", Number.NaN],
    ["conversion_to_qualified", 1.01],
    ["conversion_to_qualified", -0.1],
    ["conversion_to_qualified", null],
  ])("rejects %s = %j", (field, value) => {
    expect(parseLeadSourceField(website, field, 0, value)).toBeNull();
  });

  it("rejects unknown fields, bad ids and non-scalar bases", () => {
    expect(parseLeadSourceField(website, "workspace_id", "a", "b")).toBeNull();
    expect(parseLeadSourceField(website, "provenance", {}, {})).toBeNull();
    expect(parseLeadSourceField("nope", "name", "a", "b")).toBeNull();
    expect(parseLeadSourceField(website, "name", { a: 1 }, "b")).toBeNull();
  });
});

describe("parseNewLeadSource", () => {
  it("reads the name, leads a week and conversion as a percentage", () => {
    expect(parseNewLeadSource(form({ name: " Events ", volume_week: "6", conversion_pct: "50" }))).toEqual({
      name: "Events",
      volume_week: 6,
      conversion_to_qualified: 0.5,
    });
  });

  it("defaults a blank conversion to 100% and a blank volume to 0", () => {
    expect(parseNewLeadSource(form({ name: "Referrals", volume_week: "", conversion_pct: "" }))).toEqual({
      name: "Referrals",
      volume_week: 0,
      conversion_to_qualified: 1,
    });
  });

  it("explains what's wrong", () => {
    expect(parseNewLeadSource(form({ name: "", volume_week: "3" }))).toEqual({ error: "Enter a name." });
    expect(parseNewLeadSource(form({ name: "A", volume_week: "-3" }))).toMatchObject({ error: expect.stringMatching(/leads a week/) });
    expect(parseNewLeadSource(form({ name: "A", volume_week: "lots" }))).toMatchObject({ error: expect.stringMatching(/leads a week/) });
    expect(parseNewLeadSource(form({ name: "A", volume_week: "3", conversion_pct: "120" }))).toEqual({
      error: "Enter a conversion from 0 to 100%.",
    });
  });
});

describe("seasonality and growth checks", () => {
  it("accepts months 1–12 and multipliers 0–10", () => {
    expect([1, 12].every(isMonth)).toBe(true);
    expect([0, 13, 1.5, "3", null].some(isMonth)).toBe(false);
    expect([0, 1, 1.25, 10].every(isMultiplier)).toBe(true);
    expect([-0.1, 10.5, null, "1", Number.POSITIVE_INFINITY].some(isMultiplier)).toBe(false);
  });

  it("accepts growth from -50% to +100% a month", () => {
    expect([-0.5, 0, 0.02, 1].every(isGrowth)).toBe(true);
    expect([-0.51, 1.01, null, "0.1"].some(isGrowth)).toBe(false);
  });
});

describe("provenanceOf", () => {
  it("reads a value's source, treating a missing or unknown one as an estimate", () => {
    const prov = northbeamBundle().leadSources![0]!.provenance;
    expect(provenanceOf(prov, "volume_week")).toBe("estimated");
    expect(provenanceOf({ volume_week: { source: "entered" } }, "volume_week")).toBe("entered");
    // "measured" was calibration's (cut, D71): an old entry reads as an estimate.
    expect(provenanceOf({ multiplier: { source: "measured" } }, "multiplier")).toBe("estimated");
    expect(provenanceOf({}, "multiplier")).toBe("estimated");
    expect(provenanceOf(null, "growth_monthly")).toBe("estimated");
  });
});

describe("demandSummary", () => {
  it("adds up Northbeam's sources to 7 a week, split 55 : 45 by the services mix", () => {
    const b = northbeamBundle();
    const s = demandSummary(b.leadSources!, b.services, b.workspace.settings.leads_per_week);
    expect(s.fromSources).toBe(7);
    expect(s.perWeek).toBe(7);
    expect(s.byService.map((sv) => [sv.name, sv.perWeek])).toEqual([
      ["SEO retainer", 7 * 0.55],
      ["PPC management", 7 * 0.45],
    ]);
  });

  it("falls back to the interim figure with no sources, and gives no split with no services", () => {
    const s = demandSummary([], [], 12);
    expect(s).toEqual({ fromSources: null, perWeek: 12, byService: [] });
  });
});
