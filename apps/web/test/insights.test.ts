import { describe, expect, it } from "vitest";
import { noCost, type DetectedIssue, type Rating } from "@transpera-flow/engine";
import { mapFeed, registerEntries } from "@/lib/issues/register";
import { MemoryIssueStore } from "@/lib/issues/store";
import { parsePromoteInput } from "@/lib/issues/validate";
import { acknowledgeInsight, dismissInsight } from "@/lib/insights/actions";
import { buildInsights, filterByRating, ratingCountsOf, rest, type Detection } from "@/lib/insights/insights";
import type { IssuesState } from "@/lib/issues/use-issues";

// Insights v2 (issue #110, A45).

// Ids as the database has them (uuids), and keys as the detectors write them.
const uuid = (n: string) => `00000000-0000-4000-8000-${n.charCodeAt(0).toString(16).padStart(12, "0")}`;
const P1 = uuid("p");
const det = (id: string, rating: Rating, perMonth: number | null, extra: Partial<Detection> = {}): Detection => ({
  key: `capacity:role:${id}`,
  type: "capacity",
  rating,
  escalation: { base: rating, raised: [] } as unknown as DetectedIssue["escalation"],
  cost: perMonth === null ? noCost("") : { ...noCost(""), perMonth },
  title: `Title ${id}`,
  evidence: `Busy ${id}. Second sentence.`,
  metrics: {},
  stepId: uuid(id),
  roleId: null,
  personId: null,
  fix: null,
  ...extra,
});
const keys = (ids: string[]) => ids.map((x) => `capacity:role:${x}`);

/** The issue state the hooks give, over the in-memory store; `fail` makes every save fail. */
function state(store: MemoryIssueStore, fail = false, revisions: Record<string, string> = {}): Pick<IssuesState, "promote" | "save" | "redismiss" | "revisionOf"> {
  const done = async (run: () => Promise<{ status: "ok"; issue: import("@transpera-flow/db").IssueRow } | { status: "error"; message: string }>) => {
    if (fail) return null;
    const r = await run();
    return r.status === "ok" ? r.issue : null;
  };
  return {
    promote: (input) => done(() => store.promote(input)),
    save: (input) => done(() => store.save(input)),
    redismiss: (id, revision) => done(() => store.redismiss(id, revision)),
    revisionOf: (processId) => (processId ? revisions[processId] : undefined),
  };
}
const rowsOf = (store: MemoryIssueStore) => [...(store as unknown as { rows: Map<string, import("@transpera-flow/db").IssueRow> }).rows.values()];

const ctx = { processId: P1, scenarios: [] };

describe("insight rows", () => {
  const found = [det("a", "good", 900), det("b", "risk", null), det("c", "bad", 200), det("d", "bad", 700), det("e", "risk", 100)];

  it("lists worst rating first, then dearest, with unpriced last in its rating", () => {
    expect(buildInsights(registerEntries([], found)).map((i) => i.key)).toEqual(keys(["e", "b", "d", "c", "a"]));
  });

  it("carries the number, what else we found, the touched steps and where it came from", () => {
    const [i] = buildInsights(registerEntries([], [det("a", "bad", 5)]));
    expect(i!.number).toBe("Busy a.");
    expect(i!.found).toBe("Second sentence.");
    expect(i!.why.length).toBeGreaterThan(10);
    expect(i!.stepIds).toEqual([uuid("a")]);
    expect(i!.source).toEqual({ kind: "rule", ruleId: "busy", name: "Too busy" });
  });

  it("has nothing more to say when the number is the whole evidence", () => {
    expect(rest("Only one sentence.")).toBe("");
    expect(rest("No full stop")).toBe("");
  });

  it("counts and filters by rating", () => {
    const list = buildInsights(registerEntries([], found));
    expect(ratingCountsOf(list)).toEqual([
      { rating: "risk", count: 2 },
      { rating: "bad", count: 2 },
      { rating: "good", count: 1 },
    ]);
    expect(filterByRating(list, "bad").map((i) => i.key)).toEqual(keys(["d", "c"]));
    expect(filterByRating(list, "")).toHaveLength(5);
  });
});

describe("acknowledge and dismiss", () => {
  it("acknowledging tracks the insight, which then shows as its issue", async () => {
    const store = new MemoryIssueStore("w1");
    const d = det("a", "bad", 300);
    const [before] = buildInsights(registerEntries([], [d]));
    const row = await acknowledgeInsight(state(store), before!, ctx);
    expect(row?.detected_key).toBe("capacity:role:a");
    expect(row?.process_id).toBe(P1);
    expect(row?.status).toBe("open");
    const after = buildInsights(registerEntries([row!], [d]));
    expect(after).toHaveLength(1);
    expect(after[0]!.issue?.id).toBe(row!.id);
  });

  it("dismissing writes one row, already dismissed, and the insight leaves the list for good", async () => {
    const store = new MemoryIssueStore("w1");
    const d = det("a", "bad", 300);
    const [i] = buildInsights(registerEntries([], [d]));
    expect(await dismissInsight(state(store), i!, ctx)).toBe(true);
    const rows = rowsOf(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("dismissed");
    expect(rows[0]!.resolved_at).not.toBeNull();
    expect(buildInsights(registerEntries(rows, [d]))).toEqual([]);
  });

  it("a failed dismiss leaves no issue behind, open or otherwise", async () => {
    const store = new MemoryIssueStore("w1");
    const [i] = buildInsights(registerEntries([], [det("a", "bad", 300)]));
    expect(await dismissInsight(state(store, true), i!, ctx)).toBe(false);
    expect(rowsOf(store)).toEqual([]);
  });

  it("the stored status of a tracked detection is open or dismissed, nothing else", () => {
    const input = { detected_key: "capacity:role:a", type: "capacity", severity: "warning", title: "T", evidence: null, evidence_metrics: {}, process_id: null, step_id: null, role_id: null, person_id: null, owner_person_id: null, scenario_id: null };
    const status = (s?: unknown) => {
      const r = parsePromoteInput({ ...input, ...(s === undefined ? {} : { status: s }) });
      return r.ok ? r.value.status : "invalid";
    };
    expect(status()).toBe("open");
    expect(status("open")).toBe("open");
    expect(status("dismissed")).toBe("dismissed");
    expect(status("resolved")).toBe("invalid");
    expect(status("testing")).toBe("invalid");
  });
});

describe("D24: unacknowledged insights never reach the map", () => {
  // `mapFeed` is what both the process page and the Overview feed the map from.
  const found = [det("a", "risk", 100), det("b", "bad", 50)];

  it("adds no badge and no colour for what a run only found", () => {
    const feed = mapFeed(registerEntries([], found));
    expect(feed.badges).toEqual({});
    expect(feed.ratings).toEqual({});
  });

  it("badges the step only once the insight is acknowledged", async () => {
    const store = new MemoryIssueStore("w1");
    const [i] = buildInsights(registerEntries([], found));
    const row = await acknowledgeInsight(state(store), i!, ctx);
    const feed = mapFeed(registerEntries([row!], found));
    expect(Object.keys(feed.badges)).toEqual([uuid("a")]);
    expect(feed.badges[uuid("a")]!.count).toBe(1);
    expect(feed.ratings[uuid("a")]!.rating).toBe("risk");
  });

  it("a dismissed insight adds no badge and no colour", async () => {
    const store = new MemoryIssueStore("w1");
    const [i] = buildInsights(registerEntries([], found));
    await dismissInsight(state(store), i!, ctx);
    const feed = mapFeed(registerEntries(rowsOf(store), found));
    expect(feed.badges).toEqual({});
    expect(feed.ratings).toEqual({});
  });
});
