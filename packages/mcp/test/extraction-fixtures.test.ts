import { describe, expect, it } from "vitest";
import { lintRun, readRun, type Run } from "./extraction-fixtures";

// The Tidewater dry run's recorded tool calls, checked against the interview
// transcripts with no database (issue #27): quotes verbatim, numbers cited or
// reasoned, suggestions in the right shape. db-extraction.test.ts
// replays the same files against a real database.

const clone = (run: Run): Run => JSON.parse(JSON.stringify(run));

describe("Tidewater dry run fixtures", () => {
  for (const name of ["run-1.json", "run-2.json"]) {
    it(`${name} is sound`, () => {
      expect(lintRun(readRun(name))).toEqual([]);
    });
  }

  it("catches a quote that is not verbatim", () => {
    const run = clone(readRun("run-1.json"));
    const step = (run.calls.find((c) => c.tool === "import_process")!.arguments.process_json as { steps: { evidence?: { quote: string }[] }[] }).steps[1]!;
    step.evidence![0]!.quote = "about an hour per client";
    expect(lintRun(run).join("\n")).toMatch(/not in the transcript verbatim/);
  });

  it("catches an unknown speaker, a wrong timestamp and a missing reason", () => {
    const run = clone(readRun("run-1.json"));
    const steps = (run.calls.find((c) => c.tool === "import_process")!.arguments.process_json as { steps: Record<string, unknown>[] }).steps;
    (steps[1]!.evidence as { speaker: string; timestamp: string }[])[0]!.speaker = "Hannah Iqbal";
    (steps[2]!.evidence as { timestamp: string }[])[0]!.timestamp = "09:59:59";
    delete steps[4]!.assumptions;
    const text = lintRun(run).join("\n");
    expect(text).toMatch(/not one of the source's speakers/);
    expect(text).toMatch(/timestamp "09:59:59" is not in the transcript/);
    expect(text).toMatch(/would fall to the server default/);
  });

  it("catches a link_later source that is never linked after the import", () => {
    const run = clone(readRun("run-1.json"));
    run.calls = run.calls.filter((c) => c.tool !== "link_source");
    expect(lintRun(run).join("\n")).toMatch(/added with link_later but never linked with link_source/);
  });

  it("catches a source added with neither links nor link_later", () => {
    const run = clone(readRun("run-1.json"));
    delete run.calls.find((c) => c.tool === "add_source")!.arguments.link_later;
    expect(lintRun(run).join("\n")).toMatch(/pass link_later: true \(the import links it\) or links/);
  });

  it("catches a range that does not cite its midpoint, and a suggestion without evidence", () => {
    const run = clone(readRun("run-1.json"));
    const steps = (run.calls.find((c) => c.tool === "import_process")!.arguments.process_json as { steps: Record<string, unknown>[] }).steps;
    (steps[2]!.evidence as { value: number }[])[0]!.value = 2;
    delete run.calls.find((c) => c.tool === "upsert_person")!.arguments.evidence;
    const text = lintRun(run).join("\n");
    expect(text).toMatch(/must cite its midpoint/);
    expect(text).toMatch(/needs evidence/);
  });
  it("catches a first-principles quote that is not verbatim, an item with neither quote nor reasoning, and a truth with no quote", () => {
    const run = clone(readRun("run-1.json"));
    const fp = run.calls.find((c) => c.tool === "update_first_principles")!.arguments as {
      statements: { source: string; kind: string }[];
      requirements: { why: string }[];
      improvements: { text: string }[];
    };
    fp.statements[0]!.source = "Hana says it is in the retainer terms.";
    fp.requirements[0]!.why = fp.requirements[0]!.why.replace("He reviews every report", "He reviews all reports");
    fp.improvements[0]!.text = "A template for the commentary.";
    const text = lintRun(run).join("\n");
    expect(text).toMatch(/a truth cites the quote that is its source/);
    expect(text).toMatch(/not in the transcript verbatim: "He reviews all reports before it goes out"/);
    expect(text).toMatch(/neither a quote nor "Assumed:" reasoning/);
  });

  it("lints the steps inside a group and a child process like any other, and refuses numbers on the group itself", () => {
    const run = clone(readRun("run-1.json"));
    const pj = run.calls.find((c) => c.tool === "import_process")!.arguments.process_json as { steps: Record<string, unknown>[] };
    const [pull, write] = [pj.steps[1]!, pj.steps[2]!];
    // Pull ranking data becomes a group of itself (a cited inner step), Write commentary a sub-process step.
    pj.steps[1] = { name: "Ranking pack", work_hours: 1, steps: [{ ...pull, name: "Pull ranking data", evidence: [{ ...(pull.evidence as object[])[0]!, quote: "about an hour per client" }] }, { name: "Check rankings", work_hours: 1 }] };
    pj.steps[2] = { name: "Commentary", process: { name: "Commentary process", steps: [{ name: "Draft", work_hours: 2 }, { ...write, name: "Polish" }] } };
    const text = lintRun(run).join("\n");
    expect(text).toMatch(/step 'Ranking pack': a group or sub-process step has no work_hours of its own/);
    expect(text).toMatch(/not in the transcript verbatim: "about an hour per client"/);
    expect(text).toMatch(/step 'Check rankings': work_hours is given with neither a citation nor reasoning/);
    expect(text).toMatch(/step 'Draft': work_hours is given with neither a citation nor reasoning/);
  });

  it("refuses numbers on a group written in the flat form (kind group, inner steps naming a parent)", () => {
    const run = clone(readRun("run-1.json"));
    const pj = run.calls.find((c) => c.tool === "import_process")!.arguments.process_json as { steps: Record<string, unknown>[] };
    pj.steps[1] = { ...pj.steps[1]!, name: "Ranking pack", kind: "group" };
    expect(lintRun(run).join("\n")).toMatch(/step 'Ranking pack': a group or sub-process step has no role, work_hours, wait_hours, rework_rate, evidence, assumptions of its own/);
  });

  it("refuses an invented quote inside an Assumed: item, a citation of an unknown source, and a target with no comparator", () => {
    const run = clone(readRun("run-1.json"));
    const fp = run.calls.find((c) => c.tool === "update_first_principles")!.arguments as {
      statements: { source: string }[];
      requirements: { why: string }[];
      measures: { comparator?: string }[];
    };
    fp.statements[2]!.source = 'Assumed: Hana said "it costs nothing to redo".';
    fp.requirements[0]!.why = fp.requirements[0]!.why.replace("Tidewater Digital interview: Hana Iqbal, account manager (2026-10-05)", "Another interview");
    delete fp.measures[0]!.comparator;
    const text = lintRun(run).join("\n");
    expect(text).toMatch(/a quote outside the citation format/);
    expect(text).toMatch(/no source is titled "Another interview"/);
    expect(text).toMatch(/a target needs an explicit comparator/);
  });
});
