import { describe, expect, it } from "vitest";
import { northbeamBundle, type StepRow } from "@transpera-flow/db";
import { RATING_LABELS } from "@transpera-flow/engine";
import { buildMapImage, exportFileName, wrapText } from "@/lib/export/map-image";

// The map image (issue #39, B10): a standalone SVG with a title and a legend, drawn from what the canvas is fed.

const bundle = northbeamBundle();
const base = { title: "Northbeam: sales", steps: bundle.steps, edges: bundle.edges, date: "2026-10-05" };

describe("map image", () => {
  it("draws every step, every line and a legend with the four ratings, nothing to fix and the badge", () => {
    const { svg, width, height } = buildMapImage(base);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    for (const s of bundle.steps.filter((x) => !x.parent_step_id && x.kind !== "group")) expect(svg).toContain(`data-step="${s.id}"`);
    expect((svg.match(/<path d="M[^"]*C/g) ?? []).length).toBeGreaterThan(0);
    for (const r of Object.values(RATING_LABELS)) expect(svg).toContain(`data-legend="${r}"`);
    expect(svg).toContain('data-legend="Nothing to fix"');
    expect(svg).toContain('data-legend="Confirmed issues"');
    expect(svg).toContain("Northbeam: sales");
    expect(svg).toContain("Exported 2026-10-05");
    expect(width).toBeGreaterThanOrEqual(560);
    expect(height).toBeGreaterThan(200);
  });

  it("colours rated steps and counts their confirmed issues", () => {
    const first = bundle.steps.find((s) => s.kind === "task")!;
    const { svg } = buildMapImage({ ...base, rating: (id) => (id === first.id ? "risk" : null), issues: { [first.id]: 3 } });
    expect(svg).toContain(`data-step="${first.id}" data-rating="risk"`);
    expect(svg).toMatch(/>3<\/text>/);
    expect((svg.match(/data-rating=/g) ?? []).length).toBe(1);
  });

  it("gives a closed group the worst rating and the issue count of what is inside it, an open one none of its own", () => {
    const group: StepRow = { ...bundle.steps[0]!, id: "g1", name: "G", kind: "group", x: 0, y: 0, parent_step_id: null };
    const kid = (id: string): StepRow => ({ ...bundle.steps[1]!, id, kind: "task", parent_step_id: "g1", x: 24, y: 60 });
    const steps = [group, kid("a"), kid("b")];
    const input = { ...base, steps, edges: [], rating: (id: string) => (id === "a" ? ("bad" as const) : id === "b" ? ("risk" as const) : null), issues: { a: 1, b: 2 } };
    const closed = buildMapImage(input).svg;
    expect(closed).toContain('data-step="g1" data-rating="risk"');
    expect(closed).toMatch(/>3<\/text>/);
    const open = buildMapImage({ ...input, expanded: new Set(["g1"]) }).svg;
    expect(open).not.toContain('data-step="g1"');
    expect(open).toContain('data-step="a" data-rating="bad"');
  });

  it("is never narrower than its legend and footer", () => {
    const { width } = buildMapImage({ ...base, steps: [], edges: [] });
    expect(width).toBeGreaterThan(650);
  });

  it("is deterministic", () => {
    expect(buildMapImage(base).svg).toBe(buildMapImage(base).svg);
  });

  it("escapes every piece of text, so a hostile step name is only text", () => {
    const evil = '</text><script>alert(1)</script><g onload="x">&';
    const steps: StepRow[] = bundle.steps.map((s, i) => (i === 1 ? { ...s, name: evil } : s));
    const { svg } = buildMapImage({ ...base, steps, title: evil, subtitle: evil, who: () => evil });
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain('onload="x"');
    expect(svg).toContain("&lt;");
    expect(svg).not.toMatch(/[\u0000-\u0008]/);
  });

  it("draws a closed group as one card with a count, and an open one as a box around its steps", () => {
    const group = (id: string, extra: Partial<StepRow> = {}): StepRow => ({ ...bundle.steps[0]!, id, name: `Group ${id}`, kind: "group", x: 0, y: 0, parent_step_id: null, work_hours: 0, wait_hours: 0, ...extra });
    const child = (id: string, parent: string, x: number): StepRow => ({ ...bundle.steps[1]!, id, name: `Child ${id}`, kind: "task", parent_step_id: parent, x, y: 60 });
    const steps = [group("g1"), child("c1", "g1", 24), child("c2", "g1", 260)];
    const closed = buildMapImage({ ...base, steps, edges: [] });
    expect(closed.svg).toContain("2 steps inside");
    expect(closed.svg).not.toContain('data-step="c1"');
    const open = buildMapImage({ ...base, steps, edges: [], expanded: new Set(["g1"]) });
    expect(open.svg).toContain('data-group="g1"');
    expect(open.svg).toContain('data-step="c1"');
    expect(open.svg).toContain('data-step="c2"');
    expect(open.width).toBeGreaterThan(closed.width - 1);
    expect(buildMapImage({ ...base, steps, edges: [], expanded: "all" }).svg).toContain('data-group="g1"');
  });

  it("sends a line into a closed group to the group's card, and drops lines inside one card", () => {
    const g: StepRow = { ...bundle.steps[0]!, id: "g1", name: "G", kind: "group", x: 400, y: 0, parent_step_id: null };
    const inner = (id: string): StepRow => ({ ...bundle.steps[1]!, id, kind: "task", parent_step_id: "g1", x: 10, y: 10 });
    const outside: StepRow = { ...bundle.steps[1]!, id: "o1", kind: "task", parent_step_id: null, x: 0, y: 0 };
    const e = (id: string, from: string, to: string) => ({ ...bundle.edges[0]!, id, from_step_id: from, to_step_id: to, probability: 1, label: null, condition_tag: null });
    const { svg } = buildMapImage({ ...base, steps: [outside, g, inner("a"), inner("b")], edges: [e("1", "o1", "a"), e("2", "a", "b")] });
    expect((svg.match(/marker-end/g) ?? []).length).toBe(1);
  });

  it("labels handoff lines on the company map and shares of work on a process", () => {
    const [a, b] = bundle.steps.filter((s) => s.kind === "task");
    const edge = { ...bundle.edges[0]!, from_step_id: a!.id, to_step_id: b!.id, label: "Signed deal", probability: 0.4, condition_tag: null };
    expect(buildMapImage({ ...base, steps: [a!, b!], edges: [edge], handoffs: true }).svg).toContain("Signed deal");
    expect(buildMapImage({ ...base, steps: [a!, b!], edges: [edge] }).svg).toContain("40%");
  });

  it("copes with an empty map", () => {
    const { svg } = buildMapImage({ ...base, steps: [], edges: [] });
    expect(svg).toContain("</svg>");
  });

  it("wraps long names and names files safely", () => {
    expect(wrapText("Review the quarterly retention numbers with the client", 20, 2)).toEqual(["Review the quarterly", "retention numbers…"]);
    expect(wrapText("Supercalifragilisticexpialidocious", 10, 5)).toHaveLength(4);
    expect(exportFileName("Northbeam: company map / v2", "png", "2026-10-05")).toBe("northbeam-company-map-v2-2026-10-05.png");
    expect(exportFileName("../../etc/passwd", "svg", "2026-10-05")).toBe("etc-passwd-2026-10-05.svg");
    expect(exportFileName("???", "csv", "2026-10-05")).toBe("map-2026-10-05.csv");
  });
});
