import { describe, expect, it } from "vitest";
import {
  bundleForProcess,
  northbeamBundle,
  northbeamServicingProcessIds,
  toEngineModel,
  unpublishedLive,
} from "@transpera-flow/db";
import { detectIssues, simulate } from "@transpera-flow/engine";
import { MemoryDraftBackend, DraftSession } from "@/lib/drafts/session";
import { promoteInput } from "@/lib/issues/register";
import { parsePromoteInput } from "@/lib/issues/validate";
import { clientRetention, recurrenceFromValue, recurrenceKind, recurrenceOptions, recurrenceText, RECURRENCE_PRESETS, TIER_RECURRENCE_START } from "@/lib/servicing";

// Client servicing in the app (issue #19) and opening never-published processes (issue #76).

const START = "2026-10-05";

describe("recurrences in settings", () => {
  it("names the presets and round-trips them through the select's values", () => {
    expect(RECURRENCE_PRESETS.map(recurrenceText)).toEqual([
      "weekly",
      "fortnightly",
      "twice a month",
      "monthly",
      "every two months",
      "quarterly",
      "ad hoc, about 1 a month",
      "ad hoc, about 2 a month",
      "ad hoc, about 4 a month",
    ]);
    for (const o of recurrenceOptions(null)) expect(JSON.stringify(recurrenceFromValue(o.value))).toBe(o.value);
    expect(recurrenceFromValue("{\"every\":\"day\",\"times\":1}")).toBeNull();
    expect(recurrenceFromValue("not json")).toBeNull();
  });

  it("words a recurrence that follows the tier, and round-trips it", () => {
    const tier = { perMonth: 1, driver: "techHours" as const, per: 2 };
    expect(recurrenceText(tier)).toBe("1 a month per 2 tech hours, from the tier");
    expect(recurrenceText(TIER_RECURRENCE_START)).toBe("1 a month per 1000 words, from the tier");
    expect(recurrenceKind(tier)).toBe("tier");
    expect(recurrenceFromValue(JSON.stringify(tier))).toEqual(tier);
    expect(recurrenceOptions(tier)[0]).toEqual({ value: JSON.stringify(tier), label: "1 a month per 2 tech hours, from the tier" });
  });

  it("offers a stored value that isn't a preset", () => {
    const odd = { every: "week" as const, times: 3 };
    const options = recurrenceOptions(odd);
    expect(options[0]).toEqual({ value: JSON.stringify(odd), label: "3 times a week" });
    expect(options).toHaveLength(RECURRENCE_PRESETS.length + 1);
  });
});

describe("client retention", () => {
  it("reads each client's simulated retention from the run", () => {
    // The named roster (client groups, which replace it in the seeded Northbeam, are tested in client-groups.test.ts).
    const b = { ...northbeamBundle(), clientGroups: [] };
    const r = simulate(toEngineModel(b, { startDate: START }), 10, 1);
    const swift = b.clients!.find((c) => c.name === "Swift Courier Co")!;
    const retention = clientRetention(r.clients![swift.id]!);
    expect(retention.start).toBe(47);
    expect(retention.trajectory).toHaveLength(14);
    expect(retention.churnMonthly).toBeGreaterThan(0.04);
    expect(retention.onTime + retention.late + retention.missed).toBeGreaterThan(5);
  });
});

describe("churn-risk issues in the register", () => {
  it("tracking one links its client", () => {
    const b = { ...northbeamBundle(), clientGroups: [] };
    const model = toEngineModel(b, { startDate: START });
    const issue = detectIssues(model, simulate(model, 10, 1)).find((i) => i.key.startsWith("churn_risk:client:"))!;
    expect(issue.clientId).toBeTruthy();
    const input = promoteInput(issue, b.process.id, []);
    expect(input.client_id).toBe(issue.clientId);
    const parsed = parsePromoteInput(input);
    expect(parsed.ok && parsed.value.client_id).toBe(issue.clientId);
    expect(parsePromoteInput({ ...input, client_id: "nope" }).ok).toBe(false);
  });

  it("a client group's churn risk is one issue for the group and links no client (issue #120)", () => {
    const b = northbeamBundle();
    const unhappy = { ...b, clientGroups: b.clientGroups!.map((g) => ({ ...g, starting_health: 20 })) };
    const model = toEngineModel(unhappy, { startDate: START });
    const issues = detectIssues(model, simulate(model, 10, 1)).filter((i) => i.key.startsWith("churn_risk:group:"));
    expect(issues.map((i) => i.key).sort()).toEqual(b.clientGroups!.map((g) => `churn_risk:group:${g.service_id}`).sort());
    const input = promoteInput(issues[0]!, b.process.id, []);
    expect(input.client_id).toBeUndefined();
    expect(parsePromoteInput(input).ok).toBe(true);
  });
});

describe("a never-published process (issue #76)", () => {
  it("opens in its draft against an empty live revision, and publishing makes the draft live", async () => {
    const draft = bundleForProcess(northbeamBundle(), northbeamServicingProcessIds.checkin!)!;
    const live = unpublishedLive(draft);
    const backend = new MemoryDraftBackend(live);
    const opened = await backend.open();
    expect(opened.status).toBe("ok");
    const session = new DraftSession(live, { bundle: { ...draft, revision: { ...draft.revision, id: opened.status === "ok" ? opened.revision.id : "" } }, number: 1 }, backend);
    // Everything in the draft is new against live.
    expect(session.getState().live.steps).toEqual([]);
    for (const s of draft.steps) await backend.store(session.currentRevision()).insert([s], []);
    await backend.store(session.currentRevision()).insert([], draft.edges);
    const published = await session.publish();
    expect(published?.status).toBe("published");
    expect(session.getState().live.revision.number).toBe(1);
    expect(backend.liveRows().steps.map((s) => s.id).sort()).toEqual(draft.steps.map((s) => s.id).sort());
  });
});
