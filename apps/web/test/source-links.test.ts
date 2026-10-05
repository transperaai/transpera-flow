import { describe, expect, it } from "vitest";
import { derivedSourceLinks, linkColumns, northbeamIssues, northbeamSourceIds, northbeamSources, unlinkedSources, type LinkTargets, type SourceLinkRow, type SourceLinkTarget } from "@transpera-flow/db";
import {
  KIND_CHOICES,
  LINK_KIND_LABELS,
  NEEDS_A_LINK,
  NEEDS_A_TITLE,
  draftToSubmission,
  emptyDraft,
  hasErrors,
  linkJson,
  linkLabel,
  linkTitle,
  parseNewSource,
  parseTarget,
  targetOptions,
  targetValue,
  toTarget,
  validateDraft,
  type SourceDraft,
} from "@/lib/sources/links";
import { demoLinkTargets, demoPageSources, demoSourceLinks, DEMO_UNLINKED_SOURCE_ID } from "@/lib/sources/demo";
import { MemorySourceStore } from "@/lib/sources/store";
import { SOURCE_KIND_LABELS, cleanSourceField } from "@/lib/sources/validate";

// The Add / Link source dialog's rules and the pieces under the Sources page (issue #118, A53): what a link is called,
// what the pickers offer, what makes a draft valid (a title, and a link), what the Server Actions accept, and the
// in-memory store the demo uses.

const P1 = "c0000000-0000-4000-8000-000000000001";
const P2 = "c0000000-0000-4000-8000-000000000002";
const S1 = "e0000000-0000-4000-8000-000000000003";
const S2 = "e0000000-0000-4000-8000-000000000009";
const I1 = "40000000-0000-4000-8000-000000000001";
const SOL = "50000000-0000-4000-8000-000000000001";
const KEY = "spof:step:e0000000-0000-4000-8000-000000000003";

const targets: LinkTargets = {
  processes: [
    { id: P1, name: "Lead to live" },
    { id: P2, name: "Monthly report" },
  ],
  steps: [
    { id: S1, processId: P1, name: "Audit & proposal" },
    { id: S2, processId: P2, name: "Review" },
  ],
  insights: [{ key: KEY, title: "The strategist is the only person who can do Audit & proposal" }],
  issues: [
    { id: I1, number: 12, title: "Strategist bottleneck holds up proposals and report reviews" },
    { id: "40000000-0000-4000-8000-000000000002", number: null, title: "An issue without a number" },
  ],
  solutions: [{ id: SOL, name: "Second strategist" }],
};

const draft = (over: Partial<SourceDraft> = {}): SourceDraft => ({ title: "Interview: Leah Brooks", kind: "transcript", date: "2026-09-18", quote: "Access requests go back and forth.", linkKind: "step", linkValue: S1, ...over });

describe("the Add / Link source dialog's rules", () => {
  it("is valid with a title and a link", () => {
    expect(validateDraft(draft(), targets)).toEqual({});
  });

  it("says what is missing, in plain words, for each field", () => {
    expect(validateDraft(draft({ title: "   " }), targets).title).toBe(NEEDS_A_TITLE);
    expect(NEEDS_A_TITLE).toBe("Give the source a title.");
    expect(validateDraft(draft({ title: "x".repeat(201) }), targets).title).toMatch(/200 characters/);
    expect(validateDraft(draft({ date: "12 Sep" }), targets).date).toMatch(/date/);
    expect(validateDraft(draft({ date: "" }), targets)).toEqual({});
    expect(validateDraft(draft({ quote: "q".repeat(5001) }), targets).quote).toMatch(/5,000 characters/);
  });

  it("requires a link: a source is never added without one, and the message is the prototype's", () => {
    const errors = validateDraft(draft({ linkValue: "" }), targets);
    expect(errors.link).toBe(NEEDS_A_LINK);
    expect(NEEDS_A_LINK).toBe("Pick what this source is evidence for.");
    expect(draftToSubmission(draft({ linkValue: "" }), targets)).toEqual({ ok: false, errors: { link: NEEDS_A_LINK } });
  });

  it("refuses a link to something that is not in the picker, or of another kind", () => {
    expect(validateDraft(draft({ linkValue: "not-a-step" }), targets).link).toBe(NEEDS_A_LINK);
    // A step's id picked while "A process" is chosen is not one of the process options.
    expect(validateDraft(draft({ linkKind: "process", linkValue: S1 }), targets).link).toBe(NEEDS_A_LINK);
    expect(validateDraft(draft({ linkKind: "process", linkValue: P1 }), targets)).toEqual({});
  });

  it("when linking a source that is already there, only the link is checked", () => {
    expect(validateDraft(draft({ title: "", date: "junk" }), targets, true)).toEqual({});
    expect(validateDraft(draft({ linkValue: "" }), targets, true)).toEqual({ link: NEEDS_A_LINK });
  });

  it("turns a valid draft into the source and its one link", () => {
    const made = draftToSubmission(draft({ title: "  Interview  ", quote: "  “Hello”  ", date: "" }), targets);
    expect(made).toEqual({
      ok: true,
      link: { kind: "step", processId: P1, stepId: S1 },
      input: { kind: "transcript", title: "Interview", speakers: [], recorded_at: null, body: "“Hello”", file_url: null },
    });
  });

  it("opens with the target a screen's + Link gave it", () => {
    const preset: SourceLinkTarget = { kind: "issue", issueId: I1 };
    expect(emptyDraft(preset, "2026-10-02")).toEqual({ title: "", kind: "transcript", date: "2026-10-02", quote: "", linkKind: "issue", linkValue: I1 });
    expect(validateDraft({ ...emptyDraft(preset), title: "Notes" }, targets)).toEqual({});
    expect(emptyDraft(null).linkValue).toBe("");
    expect(hasErrors(validateDraft(emptyDraft(null), targets))).toBe(true);
  });

  it("offers the types the database holds, in the prototype's order", () => {
    expect(KIND_CHOICES).toEqual(["transcript", "notes", "sop", "spreadsheet", "data", "screenshot", "other"]);
    expect(SOURCE_KIND_LABELS.sop).toBe("SOP");
    expect(SOURCE_KIND_LABELS.data).toBe("Data");
    expect(cleanSourceField("kind", "data")).toEqual({ value: "data" });
    for (const kind of ["sop", "spreadsheet", "other"]) expect(cleanSourceField("kind", kind)).toEqual({ value: kind });
    expect(cleanSourceField("kind", "video")).toBeNull();
    expect(draftToSubmission(draft({ kind: "data" }), targets)).toMatchObject({ ok: true, input: { kind: "data" } });
  });
});

describe("the pickers", () => {
  it("lists what each kind can be linked to", () => {
    expect(targetOptions("process", targets).map((o) => o.label)).toEqual(["Lead to live", "Monthly report"]);
    // With more than one process, a step says which one it is in.
    expect(targetOptions("step", targets).map((o) => o.label)).toEqual(["Audit & proposal (Lead to live)", "Review (Monthly report)"]);
    expect(targetOptions("issue", targets).map((o) => o.label)).toEqual(["#12 Strategist bottleneck holds up proposals and report reviews", "An issue without a number"]);
    expect(targetOptions("solution", targets).map((o) => o.label)).toEqual(["Second strategist"]);
    expect(targetOptions("insight", targets)[0]!.value).toBe(KEY);
    expect(targetOptions("step", { ...targets, processes: [targets.processes[0]!] })[0]!.label).toBe("Audit & proposal");
  });

  it("names the five kinds as the prototype does", () => {
    expect(LINK_KIND_LABELS).toEqual({ process: "A process", step: "A step", insight: "An insight", issue: "An issue", solution: "A solution" });
  });

  it("turns a choice into a target, and back", () => {
    for (const t of [
      { kind: "process", processId: P1 },
      { kind: "step", processId: P2, stepId: S2 },
      { kind: "insight", insightKey: KEY },
      { kind: "issue", issueId: I1 },
      { kind: "solution", solutionId: SOL },
    ] as SourceLinkTarget[]) {
      expect(toTarget(t.kind, targetValue(t), targets)).toEqual(t);
    }
    expect(toTarget("step", "", targets)).toBeNull();
  });
});

describe("what a chip says", () => {
  const row = (t: SourceLinkTarget): SourceLinkRow => ({ id: "l", workspace_id: "w", source_id: "s", ...linkColumns(t), created_at: "", created_by: null });
  it("names each kind from the pickers' lists", () => {
    expect(linkLabel(row({ kind: "process", processId: P1 }), targets)).toBe("Process: Lead to live");
    expect(linkLabel(row({ kind: "step", processId: P1, stepId: S1 }), targets)).toBe("Step: Audit & proposal");
    expect(linkLabel(row({ kind: "issue", issueId: I1 }), targets)).toBe("Issue #12");
    expect(linkLabel(row({ kind: "issue", issueId: "40000000-0000-4000-8000-000000000002" }), targets)).toBe("Issue: An issue without a number");
    expect(linkLabel(row({ kind: "solution", solutionId: SOL }), targets)).toBe("Solution: Second strategist");
    expect(linkLabel(row({ kind: "insight", insightKey: KEY }), targets)).toMatch(/^Insight: The strategist is the only person/);
    // Long names are shortened on the chip; the title keeps the whole thing.
    expect(linkLabel(row({ kind: "insight", insightKey: KEY }), targets).length).toBeLessThan(50);
    expect(linkTitle(row({ kind: "insight", insightKey: KEY }), targets)).toBe(`Insight: ${targets.insights[0]!.title}`);
    expect(linkTitle(row({ kind: "issue", issueId: I1 }), targets)).toBe(`Issue #12: ${targets.issues[0]!.title}`);
  });

  it("names a step that is only in an earlier version, and says so", () => {
    const old = "e0000000-0000-4000-8000-0000000000aa";
    const t = { ...targets, olderSteps: [{ id: old, name: "Old hand-over" }] };
    expect(linkLabel(row({ kind: "step", processId: P1, stepId: old }), t)).toBe("Step: Old hand-over (in an earlier version)");
    expect(linkLabel(row({ kind: "step", processId: P1, stepId: old }), targets)).toBe("Step: a step that was removed");
    // A step in the current version is named plainly even when an older name is known.
    expect(linkLabel(row({ kind: "step", processId: P1, stepId: S1 }), { ...t, olderSteps: [{ id: S1, name: "Older name" }] })).toBe("Step: Audit & proposal");
  });

  it("says so when the thing is gone, rather than breaking", () => {
    expect(linkLabel(row({ kind: "step", processId: P1, stepId: "e0000000-0000-4000-8000-0000000000ff" }), targets)).toBe("Step: a step that was removed");
    expect(linkLabel(row({ kind: "process", processId: "c0000000-0000-4000-8000-0000000000ff" }), targets)).toBe("Process: a process that was removed");
    expect(linkLabel(row({ kind: "issue", issueId: "40000000-0000-4000-8000-0000000000ff" }), targets)).toBe("Issue: one that was removed");
  });
});

describe("what a Server Action accepts", () => {
  it("takes a target of each kind, and refuses a half-filled or foreign one", () => {
    expect(parseTarget({ kind: "step", processId: P1, stepId: S1 })).toEqual({ ok: true, value: { kind: "step", processId: P1, stepId: S1 } });
    expect(parseTarget({ kind: "insight", insightKey: KEY }).ok).toBe(true);
    expect(parseTarget({ kind: "step", stepId: S1 }).ok).toBe(false);
    expect(parseTarget({ kind: "issue", issueId: "x" }).ok).toBe(false);
    expect(parseTarget({ kind: "insight", insightKey: "not a key" }).ok).toBe(false);
    expect(parseTarget({ kind: "document" }).ok).toBe(false);
    expect(parseTarget(null).ok).toBe(false);
    expect(parseTarget([]).ok).toBe(false);
  });

  it("refuses a new source with no links, on the server as in the dialog", () => {
    const input = { kind: "notes", title: "Ops call", speakers: [], recorded_at: null, body: null, file_url: null };
    expect(parseNewSource(input, [])).toEqual({ ok: false, error: NEEDS_A_LINK });
    expect(parseNewSource(input, undefined)).toEqual({ ok: false, error: NEEDS_A_LINK });
    expect(parseNewSource(input, "step")).toEqual({ ok: false, error: NEEDS_A_LINK });
    expect(parseNewSource(input, [{ kind: "step" }]).ok).toBe(false);
    expect(parseNewSource({ ...input, title: " " }, [{ kind: "process", processId: P1 }]).ok).toBe(false);
    const ok = parseNewSource(input, [{ kind: "process", processId: P1 }]);
    expect(ok.ok && ok.value.links).toEqual([{ kind: "process", processId: P1 }]);
  });

  it("treats the same link named twice, in any case, as one", () => {
    const input = { kind: "notes", title: "Ops call", speakers: [], recorded_at: null, body: null, file_url: null };
    const made = parseNewSource(input, [{ kind: "process", processId: P1 }, { kind: "process", processId: P1.toUpperCase() }, { kind: "step", processId: P1, stepId: S1 }]);
    expect(made.ok && made.value.links).toEqual([{ kind: "process", processId: P1 }, { kind: "step", processId: P1, stepId: S1 }]);
    expect(parseTarget({ kind: "issue", issueId: I1.toUpperCase() })).toEqual({ ok: true, value: { kind: "issue", issueId: I1 } });
  });

  it("sends the database the same columns the table checks", () => {
    expect(linkJson({ kind: "step", processId: P1, stepId: S1 })).toEqual({ kind: "step", process_id: P1, step_id: S1, insight_key: null, issue_id: null, solution_id: null });
  });
});

describe("the in-memory store (the demo)", () => {
  const at = () => "2026-10-02T09:00:00.000Z";
  const input = { kind: "notes" as const, title: "Ops call", speakers: [], recorded_at: null, body: "Words", file_url: null };

  it("adds a source with its link, and refuses one without", async () => {
    const store = new MemorySourceStore("w", [], at);
    expect(await store.create(input, [])).toEqual({ status: "error", message: NEEDS_A_LINK });
    const made = await store.create(input, [{ kind: "process", processId: P1 }]);
    expect(made.status).toBe("ok");
    if (made.status === "ok") {
      expect(made.links).toHaveLength(1);
      expect(made.links[0]).toMatchObject({ source_id: made.source.id, kind: "process", process_id: P1, step_id: null });
    }
  });

  it("links a source once per thing, unlinks, and drops the links with the source", async () => {
    const store = new MemorySourceStore("w", [], at);
    const made = await store.create(input, [{ kind: "process", processId: P1 }]);
    if (made.status !== "ok") throw new Error("not created");
    const step: SourceLinkTarget = { kind: "step", processId: P1, stepId: S1 };
    const linked = await store.link(made.source.id, step);
    expect(linked.status).toBe("ok");
    expect(await store.link(made.source.id, step)).toEqual({ status: "error", message: "That source is already linked to that." });
    expect(await store.link("nope", step)).toEqual({ status: "error", message: "That source isn't there any more." });
    if (linked.status === "ok") expect(await store.unlink(linked.link.id)).toEqual({ status: "ok" });
    expect((await store.link(made.source.id, step)).status).toBe("ok");
    expect(await store.remove(made.source.id)).toEqual({ status: "ok" });
    expect((await store.link(made.source.id, step)).status).toBe("error");
  });
});

describe("the demo's sample", () => {
  it("links the sources the figures cite, and leaves one for the warning", () => {
    const sources = demoPageSources();
    const links = demoSourceLinks();
    expect(unlinkedSources(sources, links).map((s) => s.id)).toEqual([DEMO_UNLINKED_SOURCE_ID]);
    expect(links.filter((l) => l.source_id === northbeamSourceIds.strategyInterview).map((l) => l.kind).sort()).toEqual(["issue", "step"]);
    expect(links.every((l) => l.id.length === 36)).toBe(true);
  });

  it("offers real things to link to: processes, steps, the issues and the insights acted on", () => {
    const t = demoLinkTargets();
    expect(t.processes.length).toBeGreaterThanOrEqual(1);
    expect(t.steps.length).toBeGreaterThan(5);
    expect(t.issues).toHaveLength(northbeamIssues().length);
    expect(t.insights.length).toBeGreaterThanOrEqual(1);
    for (const l of demoSourceLinks()) expect(linkLabel(l, t)).not.toMatch(/removed|unknown/);
  });

  it("derives the same links from the same citations as the migration's copy: once per source and step", () => {
    const [a] = northbeamSources();
    const step = { id: S1, workspace_id: a!.workspace_id, process_id: P1, provenance: { work_hours: { evidence: [{ source_id: a!.id }] }, wait_hours: { evidence: [{ source_id: a!.id }] } } };
    expect(derivedSourceLinks([step], [], [a!])).toHaveLength(1);
    // A citation spelled in capitals still names the source, and is stored lower case.
    const shouted = { ...step, provenance: { work_hours: { evidence: [{ source_id: a!.id.toUpperCase() }] } } };
    expect(derivedSourceLinks([shouted], [], [a!]).map((l) => l.source_id)).toEqual([a!.id]);
  });
});
