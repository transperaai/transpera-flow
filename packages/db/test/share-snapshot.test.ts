import { detectIssues, parsePatchPath, simulate, type DetectedIssue, type FirstPrinciples, type SimulationResult } from "@transpera-flow/engine";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JOIN_STANDARD_WORDS, JOIN_WORDS } from "../src/money";
import { normaliseView } from "../src/share-text";
import { MONEY_NOT, MONEY_NOT_VARIANTS, MONEY_OTHER, MONEY_YES, OLD_SHARE_MONEY_SOURCE } from "./money-cases";
import {
  SHARE_SNAPSHOT_VERSION,
  larkspurBundle,
  northbeamBundle,
  northbeamIssues,
  redactShareSnapshot,
  shareReaderDb,
  shareSnapshotLeaks,
  sortWithoutMoney,
  toEngineModel,
  type Db,
  type IssueRow,
  type ProcessBundle,
  type ShareKind,
  type ShareSecrets,
  type ShareSnapshot,
  type ShareToggles,
  type SolutionRow,
} from "../src";
import { LEVER_KIND_IDS, SHARE_FREE_TEXT_KEYS, SHARE_NON_TEXT_KEYS, cleanHiddenLevers, validHiddenLevers } from "../src/share";

// Share links, the pure half (issue #32, B3): the Db a snapshot is read through, the redaction of every kind of snapshot under
// every toggle combination, its checker, and the proof that a redacted view's numbers are the unredacted run's.

// ---------------------------------------------------------------------------
// shareReaderDb
// ---------------------------------------------------------------------------

describe("shareReaderDb", () => {
  const fake = () => {
    const rpc = vi.fn(async (fn: string, args: unknown) => ({ data: { fn, args }, error: null }));
    const from = vi.fn(function (this: unknown, table: string) {
      return { table, self: this };
    });
    return { rpc, from, auth: { x: 1 } } as unknown as Db & { rpc: typeof rpc; from: typeof from };
  };

  it("sends team_capacity to share_team_capacity with the People toggle", async () => {
    for (const people of [false, true]) {
      const db = fake();
      const wrapped = shareReaderDb(db, { people, financials: false });
      const r = await wrapped.rpc("team_capacity", { ws: "w1" });
      expect(db.rpc).toHaveBeenCalledTimes(1);
      expect(db.rpc).toHaveBeenCalledWith("share_team_capacity", { ws: "w1", show_people: people }, undefined);
      expect(r.data).toEqual({ fn: "share_team_capacity", args: { ws: "w1", show_people: people } });
    }
  });

  it("answers can_see_people with the People toggle, without calling the database", async () => {
    for (const people of [false, true]) {
      const db = fake();
      const r = await shareReaderDb(db, { people, financials: true }).rpc("can_see_people", { ws: "w1" });
      expect(r).toEqual({ data: people, error: null });
      expect(db.rpc).not.toHaveBeenCalled();
    }
  });

  it("passes every other rpc and every other member through unchanged", async () => {
    const db = fake();
    const wrapped = shareReaderDb(db, { people: true, financials: true });
    await wrapped.rpc("can_edit_workspace", { ws: "w1" });
    expect(db.rpc).toHaveBeenCalledWith("can_edit_workspace", { ws: "w1" }, undefined);
    // `from` keeps working with the original client as `this`.
    const q = wrapped.from("people") as unknown as { table: string; self: unknown };
    expect(q.table).toBe("people");
    expect(q.self).toBe(db);
    expect((wrapped as unknown as { auth: unknown }).auth).toBe(db.auth);
  });
});

// ---------------------------------------------------------------------------
// Fixtures: Northbeam and Larkspur, with something to leak
// ---------------------------------------------------------------------------

const MONEY_TEXT = "costing about £4,100 a month, or 3,200 GBP, or $2.5k";
type Anyish = Record<string, unknown>;

interface World {
  name: string;
  bundle: ProcessBundle;
  secrets: ShareSecrets;
  personFull: string[];
  personFirst: string[];
  clientNames: string[];
  issue: IssueRow;
  solution: SolutionRow;
}

function world(name: string, base: ProcessBundle): World {
  // The editor's real bundle, with a rate, an email and a note on every person, and notes and provenance on every client.
  const bundle = structuredClone(base) as ProcessBundle;
  bundle.people = bundle.people.map((p, i) => ({ ...p, cost_rate: 40 + i, email: `${p.name.split(" ")[0]!.toLowerCase()}@${name}.example`, notes: `Prefers mornings, ${p.name}`, provenance: { cost_rate: { source: "entered", at: "2026-09-29T00:00:00Z", note: `from ${p.name}'s contract` } } }) as never);
  bundle.clients = (bundle.clients ?? []).map((c) => ({ ...c, notes: `Renewal talk with ${c.name}`, provenance: { name: { source: "entered", at: "2026-09-29T00:00:00Z", note: "interview" } } }) as never);
  bundle.workspace = { ...bundle.workspace, settings: { ...bundle.workspace.settings, overhead_monthly: 9000, target_margin: 0.25 } as never, provenance: { "settings.retainer": { source: "entered", at: "2026-09-29T00:00:00Z", note: "invoice" } } as never };
  bundle.services = bundle.services.map((s) => ({ ...s, margin: 0.3 }));
  bundle.roles = bundle.roles.map((r) => ({ ...r, default_cost_rate: r.default_cost_rate || 55 }));
  const people = bundle.people.map((p, i) => ({ id: p.id, name: p.name, label: `Team member ${i + 1}` }));
  const clients = (bundle.clients ?? []).map((c, i) => ({ id: c.id, name: c.name, label: `Client ${i + 1}` }));
  const person = bundle.people[0]!;
  const shared = bundle.people[1]!;
  const baseIssue = northbeamIssues()[0]!;
  const issue: IssueRow = {
    ...baseIssue,
    title: `Ask ${person.name} about ${clients[0]!.name}`,
    evidence: `${person.name.split(" ")[0]} mentioned ${MONEY_TEXT}. Write to ${person.name.split(" ")[0]!.toLowerCase()}@${name}.example. ${shared.name} agrees.`,
    target_measure: `Wait at ${clients[1]!.name}`,
    detected_key: null,
  };
  const solution: SolutionRow = {
    id: "00000000-0000-4000-8000-0000000000aa",
    workspace_id: bundle.workspace.id,
    process_id: bundle.process.id,
    base_revision_id: bundle.revision.id,
    name: `Fix for ${clients[0]!.name}`,
    notes: `${person.name} will own it; budget ${MONEY_TEXT}`,
    steps: { steps: [], edges: [], entry_step_id: null },
    changed_step_ids: [],
    lever_changes: [],
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    created_by: "00000000-0000-4000-8000-0000000000bb",
  };
  return {
    name,
    bundle,
    secrets: { people, clients },
    personFull: bundle.people.map((p) => p.name),
    personFirst: [...new Set(bundle.people.map((p) => p.name.split(" ")[0]!))].filter((f) => f.length >= 3),
    clientNames: clients.map((c) => c.name),
    issue,
    solution,
  };
}

const worlds = [world("northbeam", northbeamBundle()), world("larkspur", larkspurBundle())];

/** A first-principles document with a real person or client in every free-text field (the snapshot carries the document, with its own keys). */
function filledFp(w: World): FirstPrinciples {
  const [p0, p1, p2] = w.personFull;
  const c0 = w.clientNames[0];
  const step = w.bundle.steps[0]!.id;
  return {
    job: { who: `${p0}, our account lead`, progress: `${p1} gets the brief`, situation: `When ${c0} calls`, done: `${p2} signs off` },
    statements: [{ text: `${p0} approves`, kind: "truth", source: `Email from ${p1}`, test: `Ask ${c0}`, linked_parameter: `step.${step}.work_hours` }],
    requirements: [{ text: `${c0} wants a reply`, owner_person_id: null, owner_text: `${p2}, finance director`, why: `Because ${p0} said so`, verdict: "keep", step_id: step }],
    deletes: [{ step_id: step, breaks_if_removed: `${p1} loses the report`, agreed_by: null, added_back: false }],
    improvements: [{ step_id: step, stage: "simplify", text: `Let ${p2} skip it`, scenario_id: null }],
    why: { problem: `${c0} waits`, chain: [`Because ${p0} is away`, `And ${p1} is too`], root: `${p2} owns everything` },
    measures: [{ id: "m1", text: `${c0} renews`, kpi: null, comparator: "atLeast", target: 0.9, horizon: `by ${p0}'s review` }],
  };
}

/** What `loadShareData` builds before redacting: the editor's bundle (as a People-on read), and everything around it, with names. */
function raw(kind: ShareKind, w: World, toggles: ShareToggles): ShareSnapshot {
  const base = { v: SHARE_SNAPSHOT_VERSION, toggles, workspaceName: `${w.name} (${w.clientNames[0]})` } as const;
  const solutions = { solutions: [w.solution], links: [] };
  const finding = {
    id: "00000000-0000-4000-8000-0000000000cc",
    workspace_id: w.bundle.workspace.id,
    process_id: null,
    step_id: null,
    origin: "manual",
    status: "accepted",
    rating: "bad",
    type: "manual",
    title: `${w.personFull[0]} is the bottleneck`,
    evidence: `Said so ${MONEY_TEXT}`,
    why: "Because.",
    facts: [{ kind: "quote", key: "q1", text: `"${w.personFull[0]} told ${w.clientNames[0]} to wait"` }],
    person_labels: { "Team member A": w.secrets.people[0]!.id },
    source_ids: ["00000000-0000-4000-8000-0000000000dd"],
    ai_key: null,
    analysis_id: null,
    run_id: null,
    edited: false,
    created_by: "00000000-0000-4000-8000-0000000000bb",
    created_at: "2026-10-01T00:00:00Z",
    updated_by: null,
    updated_at: "2026-10-01T00:00:00Z",
    decided_by: null,
    decided_at: null,
  };
  const common = { issues: [w.issue] };
  switch (kind) {
    case "overview":
      return { ...base, kind, live: w.bundle, parts: [], company: null, issues: common.issues, solutions, solutionBases: {}, findings: [finding as never], firstPrinciples: filledFp(w) };
    case "process":
      return { ...base, kind, bundle: w.bundle, hiddenLevers: ["process.rework", "people.leave"], processes: [{ id: w.bundle.process.id, name: w.bundle.process.name, parentId: null, kind: "pipeline" as const }], scenarios: [], issues: common.issues, liveRevisions: {}, solutions, findings: [finding as never], firstPrinciples: filledFp(w) };
    case "issue":
      return { ...base, kind, issueId: w.issue.id, bundle: w.bundle, issues: common.issues, processes: [], liveRevisions: {}, solutions };
    case "solution":
      return { ...base, kind, solutionId: w.solution.id, bundle: w.bundle, solutions, issues: common.issues, processes: [], compareBase: { revision: w.bundle.revision, steps: w.bundle.steps, edges: w.bundle.edges }, movedOn: null };
  }
}

const KINDS: ShareKind[] = ["overview", "process", "issue", "solution"];
const TOGGLES: ShareToggles[] = [
  { people: false, financials: false },
  { people: true, financials: false },
  { people: false, financials: true },
  { people: true, financials: true },
];
const label = (t: ShareToggles) => `People ${t.people ? "on" : "off"}, Financials ${t.financials ? "on" : "off"}`;

const MONEY_FORMS = [/£\s?\d/, /\$\s?\d/, /€\s?\d/, /\d\s?(GBP|USD|EUR|AUD|NZD|CAD)\b/];
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** Every provenance anywhere in the JSON that is not empty. */
function nonEmptyProvenance(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + nonEmptyProvenance(v), 0);
  if (!value || typeof value !== "object") return 0;
  let n = 0;
  for (const [k, v] of Object.entries(value as Anyish)) {
    if (k === "provenance" && v && typeof v === "object" && Object.keys(v).length) n++;
    n += nonEmptyProvenance(v);
  }
  return n;
}
/** Every value under a key anywhere in the JSON. */
function valuesOf(value: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) value.forEach((v) => valuesOf(v, key, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Anyish)) {
      if (k === key) out.push(v);
      valuesOf(v, key, out);
    }
  }
  return out;
}

describe("redactShareSnapshot: no hidden field in the raw payload, for every kind and toggle combination", () => {
  for (const w of worlds) {
    for (const kind of KINDS) {
      for (const toggles of TOGGLES) {
        it(`${w.name} ${kind}, ${label(toggles)}`, () => {
          const input = raw(kind, w, toggles);
          // The input really holds what must go: the test proves something.
          const before = JSON.stringify(input);
          expect(before).toMatch(EMAIL_RE);
          expect(before).toContain(w.personFull[0]);
          const snap = redactShareSnapshot(input, toggles, w.secrets);
          const text = JSON.stringify(snap);

          // Always: no email, no client name, no pay, no evidence notes.
          expect(text).not.toMatch(EMAIL_RE);
          for (const c of w.clientNames) expect(text, `client ${c}`).not.toContain(c);
          expect(text).not.toMatch(/"cost_rate":\s*[0-9-]/);
          expect(valuesOf(snap, "cost_rate").every((v) => v === null)).toBe(true);
          expect(nonEmptyProvenance(snap)).toBe(0);
          expect(text).not.toContain("00000000-0000-4000-8000-0000000000bb");
          // The header.
          expect(snap).toMatchObject({ v: 1, kind, toggles });

          // The bundle: viewer, payHidden, labels or names.
          const bundle = (kind === "overview" ? (snap as { live: ProcessBundle }).live : (snap as { bundle: ProcessBundle }).bundle);
          expect(bundle.payHidden).toBe(true);
          expect(bundle.viewer).toEqual({ seesEveryone: toggles.people, ownPersonId: null });
          expect(bundle.workspace.slug).toBe("");
          expect(bundle.people.map((p) => p.id)).toEqual(w.bundle.people.map((p) => p.id));
          expect((bundle.clients ?? []).every((c) => /^Client \d+$/.test(c.name) && c.notes === null)).toBe(true);

          if (toggles.people) {
            expect(bundle.people.map((p) => p.name)).toEqual(w.personFull);
            expect(text).toContain(w.personFull[0]);
          } else {
            for (const full of w.personFull) expect(text, `person ${full}`).not.toContain(full);
            for (const first of w.personFirst) expect(text, `first name ${first}`).not.toMatch(new RegExp(`(?<![A-Za-z0-9])${first}(?![A-Za-z0-9])`));
            expect(bundle.people.every((p, i) => p.name === `Team member ${i + 1}`)).toBe(true);
            // Free text got the labels back in where names were.
            expect(text).toContain("Team member 1");
          }

          if (toggles.financials) {
            // Role rates, margins and overhead are there (the toggle shows them), but never one person's pay.
            expect(bundle.roles.some((r) => r.default_cost_rate > 0)).toBe(true);
            expect(bundle.services.some((s) => s.margin > 0)).toBe(true);
            expect(bundle.workspace.settings).toMatchObject({ overhead_monthly: 9000, target_margin: 0.25 });
            expect(MONEY_FORMS.some((re) => re.test(text))).toBe(true);
          } else {
            expect(text).not.toMatch(/overhead_monthly|target_margin/);
            expect(valuesOf(snap, "default_cost_rate").every((v) => v === 0)).toBe(true);
            expect(valuesOf(snap, "margin").every((v) => v === 0)).toBe(true);
            for (const re of MONEY_FORMS) expect(text, String(re)).not.toMatch(re);
            expect(text).toContain("[amount hidden]");
          }

          // The checker agrees: nothing left to report.
          expect(shareSnapshotLeaks(snap, w.secrets, toggles)).toEqual([]);
          // And the input (a raw, unredacted copy) is what it reports.
          expect(shareSnapshotLeaks(input, w.secrets, toggles).length).toBeGreaterThan(0);
        });
      }
    }
  }

  it("a stored value that was already a label stays one (the database numbered it)", () => {
    const w = worlds[1]!;
    const snap = redactShareSnapshot(raw("process", { ...w, bundle: { ...w.bundle, people: w.bundle.people.map((p, i) => ({ ...p, name: `Team member ${i + 1}` })) } }, TOGGLES[0]!), TOGGLES[0]!, w.secrets);
    expect((snap as { bundle: ProcessBundle }).bundle.people.map((p) => p.name)).toEqual(w.bundle.people.map((_, i) => `Team member ${i + 1}`));
  });

  it("a first name two people share becomes \"a team member\" in text (Q11)", () => {
    const w = worlds[0]!;
    const secrets: ShareSecrets = { ...w.secrets, people: w.secrets.people.map((p, i) => (i < 2 ? { ...p, name: `Sam ${i === 0 ? "Rivera" : "Jones"}` } : p)) };
    const input = raw("issue", w, TOGGLES[0]!);
    const issues = [{ ...w.issue, title: "Sam is away, Sam Rivera and Sam Jones too" }];
    const snap = redactShareSnapshot({ ...input, issues } as ShareSnapshot, TOGGLES[0]!, secrets) as { issues: IssueRow[] };
    expect(snap.issues[0]!.title).toBe("a team member is away, Team member 1 and Team member 2 too");
    expect(shareSnapshotLeaks(snap, secrets, TOGGLES[0]!)).toEqual([]);
    expect(shareSnapshotLeaks({ ...snap, note: "Sam" }, secrets, TOGGLES[0]!)).toContain("person");
  });

  it("money forms: symbols, magnitudes and ISO codes, but not words or ids", () => {
    const w = worlds[0]!;
    const texts = ["£12.4k", "US$3,000", "A$ 40", "€1.2m", "$5bn", "4,100 GBP", "300 usd", "GBP 4,100", "EUR 40", "4,512€", "4,100 pounds", "40 euros", "NZ$ 1.234,50"];
    const input = raw("process", w, TOGGLES[0]!);
    const snap = redactShareSnapshot({ ...input, issues: texts.map((t) => ({ ...w.issue, title: `x ${t} y`, evidence: "Ids 20261220000000 and 12 hours" })) } as ShareSnapshot, TOGGLES[0]!, w.secrets) as { issues: IssueRow[] };
    for (const i of snap.issues) {
      expect(i.title).toBe("x [amount hidden] y");
      expect(i.evidence).toBe("Ids 20261220000000 and 12 hours");
    }
  });
});

describe("names with unusual white space, surnames and case, quotes, and role-rate patches", () => {
  const w = worlds[1]!;
  const off = TOGGLES[0]!;
  const full = w.personFull[0]!;
  const [first, ...rest] = full.split(" ");
  const surname = rest[rest.length - 1]!;
  const redact = (note: string, toggles: ShareToggles = off) => {
    const input = raw("process", w, toggles);
    const snap = redactShareSnapshot({ ...input, issues: [{ ...w.issue, title: note, evidence: null }] } as ShareSnapshot, toggles, w.secrets) as { issues: IssueRow[] };
    return { title: snap.issues[0]!.title, snap, input: { ...input, issues: [{ ...w.issue, title: note, evidence: null }] } as ShareSnapshot };
  };

  it("a full name split by a no-break space, two spaces, a tab, a line break or a zero-width space is replaced whole and flagged when left", () => {
    for (const gap of ["\u00a0", "  ", "\t", "\n", " \u200b ", "\u2009"]) {
      const { title, snap, input } = redact(`Ask ${first}${gap}${rest.join(gap)} now`);
      expect(title, JSON.stringify(gap)).toBe("Ask Team member 1 now");
      expect(title).not.toContain(surname);
      expect(shareSnapshotLeaks(snap, w.secrets, off), JSON.stringify(gap)).toEqual([]);
      expect(shareSnapshotLeaks(input, w.secrets, off), JSON.stringify(gap)).toContain("person");
    }
  });

  it("any case: the full name, and the surname on its own, are replaced; a surname two people share becomes \"a team member\"", () => {
    expect(redact(`ask ${full.toUpperCase()} now`).title).toBe("ask Team member 1 now");
    expect(redact(`ask ${full.toLowerCase()} now`).title).toBe("ask Team member 1 now");
    const alone = redact(`${surname} is slow, ${surname.toUpperCase()} too`);
    expect(alone.title).toBe("Team member 1 is slow, Team member 1 too");
    expect(shareSnapshotLeaks(alone.snap, w.secrets, off)).toEqual([]);
    expect(shareSnapshotLeaks(alone.input, w.secrets, off)).toContain("person");
    const twins: ShareSecrets = { ...w.secrets, people: w.secrets.people.map((p, i) => (i < 2 ? { ...p, name: `Ana Twin${""}` } : p)) };
    const t = redactShareSnapshot({ ...raw("issue", w, off), issues: [{ ...w.issue, title: "Twin is away", evidence: null }] } as ShareSnapshot, off, twins) as { issues: IssueRow[] };
    expect(t.issues[0]!.title).toBe("a team member is away");
  });

  it("a client is replaced whole in any case and with any white space; a part of its name alone is left", () => {
    const client = w.clientNames[0]!;
    const words = client.split(" ");
    expect(redact(`at ${client.toLowerCase()}`).title).toBe("at Client 1");
    expect(redact(`at ${words.join("\u00a0")}`).title).toBe("at Client 1");
    expect(redact(`at ${words.join("\n")}`).title).toBe("at Client 1");
    expect(shareSnapshotLeaks(redact(`at ${words.join("  ")}`).input, w.secrets, off)).toContain("client");
  });

  it("People on: names are left alone, clients are still replaced", () => {
    const on = TOGGLES[1]!;
    expect(redact(`Ask ${full} about ${w.clientNames[0]}`, on).title).toBe(`Ask ${full} about Client 1`);
  });

  it("quotes from sources are dropped from accepted findings, in every toggle combination; other facts stay", () => {
    for (const toggles of TOGGLES) {
      const snap = redactShareSnapshot(raw("process", w, toggles), toggles, w.secrets) as unknown as { findings: { facts: { kind: string }[] }[] };
      expect(snap.findings[0]!.facts).toEqual([]);
      const mixed = { ...raw("process", w, toggles), findings: [{ ...(raw("process", w, toggles) as { findings: object[] }).findings[0]!, facts: [{ kind: "fact", key: "k", text: "12 hours a week" }, { kind: "quote", key: "q", text: "word for word" }] }] } as unknown as ShareSnapshot;
      const out = redactShareSnapshot(mixed, toggles, w.secrets) as unknown as { findings: { facts: { kind: string }[] }[] };
      expect(out.findings[0]!.facts.map((f) => f.kind)).toEqual(["fact"]);
      expect(shareSnapshotLeaks(mixed, w.secrets, toggles)).toContain("evidence");
      expect(shareSnapshotLeaks(out, w.secrets, toggles)).toEqual([]);
    }
  });

  it("evidence notes of any JSON type are flagged; only an empty object or null is clean", () => {
    const clean = redactShareSnapshot(raw("process", w, off), off, w.secrets) as unknown as Anyish;
    for (const bad of [["x"], "a note", 5, true, { a: 1 }]) expect(shareSnapshotLeaks({ ...clean, x: { provenance: bad } }, w.secrets, off), JSON.stringify(bad)).toContain("evidence");
    for (const fine of [{}, null]) expect(shareSnapshotLeaks({ ...clean, x: { provenance: fine } }, w.secrets, off)).toEqual([]);
  });

  it("with Financials off, a role-rate change in a scenario or a solution's lever changes is dropped; other changes stay; with it on, all stay", () => {
    const rate = { path: "roles.r1.cost_rate", op: "set", value: 95 };
    const hours = { path: "steps.s1.work_hours", op: "set", value: 2 };
    const make = (toggles: ShareToggles) => {
      const input = raw("process", w, toggles) as unknown as { scenarios: unknown[]; solutions: { solutions: SolutionRow[] } };
      return {
        ...input,
        scenarios: [{ id: "sc", workspace_id: "w", name: "What if", description: null, parent_scenario_id: null, patch: [rate, hours] }],
        solutions: { ...input.solutions, solutions: input.solutions.solutions.map((x) => ({ ...x, lever_changes: [rate, hours] })) },
      } as unknown as ShareSnapshot;
    };
    for (const toggles of [TOGGLES[0]!, TOGGLES[1]!]) {
      const input = make(toggles);
      const out = redactShareSnapshot(input, toggles, w.secrets) as unknown as { scenarios: { patch: unknown[] }[]; solutions: { solutions: { lever_changes: unknown[] }[] } };
      expect(out.scenarios[0]!.patch).toEqual([hours]);
      expect(out.solutions.solutions[0]!.lever_changes).toEqual([hours]);
      expect(shareSnapshotLeaks(input, w.secrets, toggles)).toContain("costs");
      expect(shareSnapshotLeaks(out, w.secrets, toggles)).toEqual([]);
    }
    for (const toggles of [TOGGLES[2]!, TOGGLES[3]!]) {
      const out = redactShareSnapshot(make(toggles), toggles, w.secrets) as unknown as { scenarios: { patch: unknown[] }[] };
      expect(out.scenarios[0]!.patch).toEqual([rate, hours]);
      expect(shareSnapshotLeaks(make(toggles), w.secrets, toggles)).not.toContain("costs");
    }
  });
});

describe("text is matched on its normalised view (the second review's examples)", () => {
  const w = worlds[0]!;
  const off = TOGGLES[0]!;
  const ann = { id: "00000000-0000-4000-8000-0000000000e1", name: "Ann O'Neil", label: "Team member 99" };
  const secrets: ShareSecrets = { ...w.secrets, people: [...w.secrets.people, ann] };
  const [first, surname] = w.personFull[0]!.split(" ") as [string, string];
  const redact = (note: string, s: ShareSecrets = secrets, toggles: ShareToggles = off) => {
    const base = raw("process", w, toggles);
    const input = { ...base, issues: [{ ...w.issue, title: note, evidence: null }] } as ShareSnapshot;
    const snap = redactShareSnapshot(input, toggles, s) as { issues: IssueRow[] };
    return { out: snap.issues[0]!.title, snap: snap as unknown as ShareSnapshot, input };
  };
  /** The words of every name that must not survive next to a label, with invisible characters taken out. */
  const parts = ["Priya", "Shah", "Ann", "O'Neil", "Neil"];
  const invisible = (s: string) => s.replace(/[\p{Cf}­]/gu, "").normalize("NFKC").replace(/[’‘ʼ]/g, "'").toLowerCase();

  const rows: [string, string][] = [
    ["a curly apostrophe", "Ann O’Neil said"],
    ["a soft hyphen in the first name", `Pri­ya ${surname} said`],
    ["a soft hyphen in the surname", `${first} Sh­ah said`],
    ["a zero-width space between the words", `${first}​${surname}`],
    ["a no-break space and a normal one", `${first}  ${surname}`],
    ["two no-break spaces", `${first}  ${surname}`],
    ["a literal backslash-n before the name", `x\\n${first} ${surname}`],
    ["a literal backslash-n between the words", `${first}\\n${surname}`],
    ["a literal backslash-t", `${first}\\t${surname}`],
    ["a possessive", `${surname}’s desk`],
    ["a full-width letter (NFKC)", `Ａnn O'Neil`],
  ];
  for (const [what, text] of rows) {
    it(`${what}: no part of a name is left next to a label, and the raw text is flagged`, () => {
      const { out, snap, input } = redact(text);
      const seen = invisible(out);
      for (const p of parts) expect(seen, `${p} in ${JSON.stringify(out)}`).not.toContain(p.toLowerCase());
      expect(shareSnapshotLeaks(snap, secrets, off), JSON.stringify(out)).toEqual([]);
      expect(shareSnapshotLeaks(input, secrets, off), text).toContain("person");
    });
  }

  it("a name stored with a curly apostrophe is found when the text has a straight one, and the other way round", () => {
    const curly: ShareSecrets = { ...w.secrets, people: [...w.secrets.people, { ...ann, name: "Ann O’Neil" }] };
    const { out, snap } = redact("Ann O'Neil said", curly);
    expect(out).toBe("Team member 99 said");
    expect(shareSnapshotLeaks(snap, curly, off)).toEqual([]);
    expect(redact("Ann O’Neil said").out).toBe("Team member 99 said");
  });

  it("JSON keys are never touched or looked at, whatever they hold", () => {
    const base = raw("process", w, off);
    const input = { ...base, liveRevisions: { [`${first} ${surname}`]: "r1", [surname.toLowerCase()]: "r2" } } as unknown as ShareSnapshot;
    const out = redactShareSnapshot(input, off, secrets) as unknown as { liveRevisions: Record<string, string> };
    expect(Object.keys(out.liveRevisions)).toEqual([`${first} ${surname}`, surname.toLowerCase()]);
    expect(shareSnapshotLeaks(out, secrets, off)).toEqual([]);
  });

  const review: [string, string][] = [
    ["a hyphen", "linkedin.com/in/priya-shah"],
    ["a dot and an @", "@priya.shah on Slack"],
    ["an underscore", "priya_shah"],
    ["a plus", "priya+shah"],
    ["upper case with a hyphen", "PRIYA-SHAH"],
    ["a bracket", "priya (Shah)"],
    ["an address with no top-level domain", "priya.shah@northbeam"],
    ["%20 between the words", "/Priya%20Shah%20contract.pdf"],
    ["%20 in lower case", "/priya%20shah.pdf"],
    ["a combining grapheme joiner U+034F", "Priya Sh͏ah"],
    ["a variation selector U+FE00", "Priya Sh︀ah"],
    ["a Hangul filler U+3164 between the words", "priyaㅤshah"],
    ["a Hangul filler U+3164 inside a word", "priㅤya shah"],
    ["a word joiner U+2060", "Priya⁠Shah"],
    ["a combining mark", "Priya Sháh"],
  ];
  for (const [what, text] of review) {
    it(`the third review: ${what} (${JSON.stringify(text)}) leaves no name token, and the raw text is flagged`, () => {
      const { out, snap, input } = redact(text);
      const seen = out.normalize("NFKC").replace(/[\p{Default_Ignorable_Code_Point}\p{M}]/gu, "").toLowerCase();
      for (const p of ["priya", "shah"]) expect(seen, `${p} in ${JSON.stringify(out)}`).not.toContain(p);
      expect(out).toContain("Team member 1");
      expect(shareSnapshotLeaks(snap, secrets, off), JSON.stringify(out)).toEqual([]);
      expect(shareSnapshotLeaks(input, secrets, off), text).toContain("person");
    });
  }

  it("the check refuses a name token wherever it sits, next to a label or not, however it was written", () => {
    const base = raw("process", w, off);
    const snap = (title: string) => redactShareSnapshot({ ...base, issues: [{ ...w.issue, title, evidence: null }] } as ShareSnapshot, off, secrets);
    const clean = snap("fine");
    const withTitle = (title: string) => ({ ...clean, issues: [{ ...(clean as unknown as { issues: IssueRow[] }).issues[0]!, title }] });
    for (const bad of [
      `Team member 1 ${surname}`, `${first} Team member 1`, `${surname.toUpperCase()} Team member 12`, `Team member 3 ${first.toLowerCase()}`,
      "priya-Team member 1", "@priya.", "priya_", "priya+", "priya (Team member 1)", "%20priya", "priya%20shah", "priya͏", "priya︀", "priyaㅤ",
    ]) {
      expect(shareSnapshotLeaks(withTitle(bad), secrets, off), bad).toContain("person");
    }
    expect(shareSnapshotLeaks(withTitle("Team member 1 and Team member 2"), secrets, off)).toEqual([]);
    // Labels are never names, even for a person called Team or Member.
    const odd: ShareSecrets = { ...secrets, people: [...secrets.people, { id: "00000000-0000-4000-8000-0000000000e2", name: "Team Member", label: "Team member 98" }] };
    expect(shareSnapshotLeaks(withTitle("Team member 1 and Client 2"), odd, off)).toEqual([]);
  });
});

describe("scenario selectors, money forms and a step's own cost", () => {
  const w = worlds[1]!;

  it("a scenario's patch paths with @busiest and @heaviest are not emails: unchanged in every toggle combination, and the engine still reads them", () => {
    const patch = [
      { path: "roles.@busiest.headcount", op: "set", value: 3 },
      { path: "steps.@heaviest.work_hours", op: "set", value: 2 },
    ];
    for (const toggles of TOGGLES) {
      const input = { ...raw("process", w, toggles), scenarios: [{ id: "sc", workspace_id: "w", name: "What if", description: null, parent_scenario_id: null, patch }] } as unknown as ShareSnapshot;
      const out = redactShareSnapshot(input, toggles, w.secrets) as unknown as { scenarios: { patch: { path: string }[] }[] };
      expect(out.scenarios[0]!.patch.map((p) => p.path), label(toggles)).toEqual(patch.map((p) => p.path));
      for (const p of out.scenarios[0]!.patch) expect(parsePatchPath(p.path), p.path).not.toBeNull();
      expect(shareSnapshotLeaks(out, w.secrets, toggles), label(toggles)).toEqual([]);
      // The redacted snapshot with only the scenario put back as it was: still no email found in the paths.
      const patched = { ...out, scenarios: (input as unknown as { scenarios: unknown[] }).scenarios };
      expect(shareSnapshotLeaks(patched, w.secrets, toggles), label(toggles)).toEqual([]);
    }
  });

  it("real emails are still replaced, wherever they sit", () => {
    const base = raw("process", w, TOGGLES[0]!);
    const out = redactShareSnapshot({ ...base, issues: [{ ...w.issue, title: "write to sam.k@acme.example or a_b@x.example now", evidence: null }] } as ShareSnapshot, TOGGLES[0]!, w.secrets) as unknown as { issues: IssueRow[] };
    expect(out.issues[0]!.title).toBe("write to [email hidden] or [email hidden] now");
  });

  it("money in any of these forms is replaced whole, and flagged when left", () => {
    const off = TOGGLES[0]!;
    for (const [text, expected] of [
      ["GBP  4,100 a month", "[amount hidden] a month"],
      ["GBP 4,100", "[amount hidden]"],
      ["4 512 €", "[amount hidden]"],
      ["4 512 €", "[amount hidden]"],
      ["£ 4,100", "[amount hidden]"],
      ["£  4,100", "[amount hidden]"],
      ["£4.1k", "[amount hidden]"],
      ["4,100 pounds", "[amount hidden]"],
      ["1.2m GBP", "[amount hidden]"],
      ["1.5 k GBP", "[amount hidden]"],
      ["4,100 quid", "[amount hidden]"],
      ["4,100 sterling", "[amount hidden]"],
      ["Rs 4,100", "[amount hidden]"],
      ["¥4100", "[amount hidden]"],
      ["x5£", "x[amount hidden]"],
      ["ABCD$5", "ABCD[amount hidden]"],
      ["CAD 3D renders", "CAD 3D renders"],
      ["%C2%A34,100", "[amount hidden]"],
    ] as const) {
      const base = raw("process", w, off);
      const input = { ...base, issues: [{ ...w.issue, title: text, evidence: null }] } as ShareSnapshot;
      const out = redactShareSnapshot(input, off, w.secrets) as unknown as { issues: IssueRow[] };
      expect(out.issues[0]!.title, text).toBe(expected);
      if (expected === text) expect(shareSnapshotLeaks({ v: SHARE_SNAPSHOT_VERSION, kind: "overview", toggles: off, note: text }, w.secrets, off), text).not.toContain("money");
      else expect(shareSnapshotLeaks(input, w.secrets, off), text).toContain("money");
      expect(shareSnapshotLeaks(out, w.secrets, off), text).toEqual([]);
    }
  });

  it("a step's cost_override is nulled with Financials off, flagged when left, and kept with it on", () => {
    for (const toggles of TOGGLES) {
      const input = raw("process", w, toggles) as unknown as { bundle: ProcessBundle };
      const stepped = { ...input, bundle: { ...input.bundle, steps: input.bundle.steps.map((s, i) => (i === 0 ? { ...s, cost_override: 120 } : s)) } } as unknown as ShareSnapshot;
      const out = redactShareSnapshot(stepped, toggles, w.secrets) as unknown as { bundle: ProcessBundle };
      const v = (out.bundle.steps[0] as unknown as { cost_override: number | null }).cost_override;
      expect(v, label(toggles)).toBe(toggles.financials ? 120 : null);
      expect(shareSnapshotLeaks(stepped, w.secrets, toggles).includes("costs"), label(toggles)).toBe(!toggles.financials);
      expect(shareSnapshotLeaks(out, w.secrets, toggles)).toEqual([]);
    }
  });
});

describe("shareSnapshotLeaks on a hand-made leaky copy", () => {
  const w = worlds[1]!;
  const off = TOGGLES[0]!;
  const clean = redactShareSnapshot(raw("process", w, off), off, w.secrets) as unknown as Anyish;
  const leaky = (patch: Anyish) => ({ ...clean, ...patch });

  it("names each kind of problem and never the value", () => {
    expect(shareSnapshotLeaks(clean, w.secrets, off)).toEqual([]);
    const cases: [Anyish, string][] = [
      [{ x: { cost_rate: 40 } }, "pay"],
      [{ x: [{ provenance: { source: "interview" } }] }, "evidence"],
      [{ x: `mail ${w.personFirst[0]!.toLowerCase()}@${w.name}.example` }, "email"],
      [{ note: `at ${w.clientNames[0]}` }, "client"],
      [{ note: `ask ${w.personFull[0]}` }, "person"],
      [{ note: `ask ${w.personFirst[0]}` }, "person"],
      [{ x: { default_cost_rate: 50 } }, "costs"],
      [{ x: { margin: 0.2 } }, "costs"],
      [{ x: { overhead_monthly: 1 } }, "costs"],
      [{ x: { target_margin: 0.1 } }, "costs"],
      [{ x: "about £4,100" }, "money"],
      [{ toggles: { people: true, financials: false } }, "mismatch"],
      [{ v: 2 }, "mismatch"],
    ];
    for (const [patch, kind] of cases) expect(shareSnapshotLeaks(leaky(patch), w.secrets, off), JSON.stringify(patch)).toContain(kind);
  });

  it("with the toggles on, names, rates and money are not problems; pay, emails, clients and evidence still are", () => {
    const on = TOGGLES[3]!;
    const snap = (patch: Anyish) => ({ ...clean, toggles: on, ...patch });
    expect(shareSnapshotLeaks(snap({ x: `ask ${w.personFull[0]}`, y: "£4,100", z: { default_cost_rate: 50, margin: 0.2, overhead_monthly: 1 } }), w.secrets, on)).toEqual([]);
    expect(shareSnapshotLeaks(snap({ x: { cost_rate: 1 } }), w.secrets, on)).toEqual(["pay"]);
    expect(shareSnapshotLeaks(snap({ x: "a@b.example" }), w.secrets, on)).toEqual(["email"]);
    expect(shareSnapshotLeaks(snap({ note: w.clientNames[0] }), w.secrets, on)).toEqual(["client"]);
    expect(shareSnapshotLeaks(snap({ x: { provenance: { a: 1 } } }), w.secrets, on)).toEqual(["evidence"]);
  });
});

// ---------------------------------------------------------------------------
// The numbers match
// ---------------------------------------------------------------------------

describe("a redacted view's numbers are the unredacted run's", () => {
  const opts = { startDate: "2026-10-05" };
  type Run = SimulationResult;

  /** Replace each person's real name with the label the redacted run used (names also appear in the engine's own text). */
  const relabel = <T,>(value: T, from: Run, to: Run): T => {
    let text = JSON.stringify(value);
    for (const [id, p] of Object.entries(from.resolvedPeople)) {
      const target = to.resolvedPeople[id]?.name;
      if (!target) continue;
      text = text.split(p.name).join(target);
    }
    return JSON.parse(text) as T;
  };

  for (const w of worlds) {
    for (const toggles of TOGGLES) {
      it(`${w.name}, ${label(toggles)}: bottleneck, revenue figures, clients, ratings and issue keys are equal`, () => {
        const snap = redactShareSnapshot(raw("process", w, toggles), toggles, w.secrets) as { bundle: ProcessBundle };
        // The editor's run: a bundle with every real value. The share's: redacted, pay hidden.
        const editorModel = toEngineModel(w.bundle, opts);
        const shareModel = toEngineModel(snap.bundle, opts);
        expect(editorModel.payHidden).toBeUndefined();
        expect(shareModel.payHidden).toBe(true);
        for (const p of Object.values(shareModel.people ?? {})) expect(p.cost).toBeUndefined();

        const a = simulate(editorModel, 30, 1);
        const b = simulate(shareModel, 30, 1);
        expect(a.bnRole).toBeTruthy();
        expect(a.kpi.billed.mean).toBeGreaterThan(0);
        expect(b.bnRole).toEqual(a.bnRole);
        for (const k of ["mrrAdded", "billed", "ltvAdded", "lostRevenue"] as const) expect(b.kpi[k], k).toEqual(a.kpi[k]);
        expect(b.kpi.clientsAtRisk).toEqual(a.kpi.clientsAtRisk);
        expect(b.kpi.clientsChurned).toEqual(a.kpi.clientsChurned);
        // Pay: the editor has an overtime cost (when anyone works overtime), the share never does.
        expect(b.kpi.overtimeCost).toBeNull();

        const keyed = (list: DetectedIssue[]) => new Map(list.map((i) => [i.key, i]));
        const mine = keyed(detectIssues(shareModel, b));
        const theirs = keyed(relabel(detectIssues(editorModel, a), a, b));
        expect([...mine.keys()].sort()).toEqual([...theirs.keys()].sort());
        // The order: a link without Financials sorts by rating, then key, with no cost in it (the editor's own order puts the
        // dearest first, which needs the rates and pay a link hides). Sorted that way, the visitor reads the editor's list in the editor's order.
        if (!toggles.financials) {
          const visitorOrder = sortWithoutMoney(detectIssues(shareModel, b)).map((i) => i.key);
          expect(visitorOrder).toEqual(sortWithoutMoney(detectIssues(editorModel, a)).map((i) => i.key));
          expect(visitorOrder.length).toBeGreaterThan(3);
        }
        for (const [key, m] of mine) {
          const e = theirs.get(key)!;
          expect(m.rating, key).toEqual(e.rating);
          if (m.cost.payHidden) expect(m.cost, key).toMatchObject({ perMonth: null, hoursPerMonth: null, payHidden: true });
        }
      });
    }
  }
});

describe("people whose names are also field names (the third review): the engine's numbers don't move", () => {
  const opts = { startDate: "2026-10-05" };
  const extra = ["Tom Price", "Jo Weeks", "Ann Kind", "Sarah Day", "Lee Retainer", "Max Horizon", "Pat Type", "Una Status"].map((name, i) => ({
    id: `00000000-0000-4000-8000-00000000ff${i}0`.slice(0, 36),
    name,
    label: `Team member ${90 + i}`,
  }));
  const keyPaths = (v: unknown, at = ""): string[] =>
    Array.isArray(v) ? v.flatMap((x) => keyPaths(x, at + "[]")) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [`${at}.${k}`, ...keyPaths(x, `${at}.${k}`)]) : [];
  const enums = (v: unknown, at = ""): string[] =>
    Array.isArray(v) ? v.flatMap((x) => enums(x, at)) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => enums(x, `${at}.${k}`)) : typeof v === "string" && /^[a-z_]{3,24}$/.test(v) ? [`${at}=${v}`] : [];

  for (const w of worlds) {
    for (const toggles of TOGGLES) {
      it(`${w.name}, ${label(toggles)}: keys, enums and every number equal the unredacted run, with Price, Weeks, Kind, Day, Retainer, Horizon, Type and Status on the team`, () => {
        const secrets: ShareSecrets = { ...w.secrets, people: [...w.secrets.people, ...extra] };
        const plain = redactShareSnapshot(raw("process", w, toggles), toggles, w.secrets) as unknown as { bundle: ProcessBundle };
        const snap = redactShareSnapshot(raw("process", w, toggles), toggles, secrets) as unknown as { bundle: ProcessBundle };
        // No key and no identifier-like value changed because of the extra names.
        expect(keyPaths(snap)).toEqual(keyPaths(plain));
        expect(enums(snap)).toEqual(enums(plain));
        expect(shareSnapshotLeaks(snap, secrets, toggles)).toEqual([]);
        const a = simulate(toEngineModel(w.bundle, opts), 30, 1);
        const b = simulate(toEngineModel(snap.bundle, opts), 30, 1);
        expect(b.bnRole).toEqual(a.bnRole);
        for (const k of ["mrrAdded", "billed", "ltvAdded", "lostRevenue"] as const) expect(b.kpi[k], k).toEqual(a.kpi[k]);
        expect(b.kpi.clientsAtRisk).toEqual(a.kpi.clientsAtRisk);
        const keys = (m: ReturnType<typeof toEngineModel>, r: SimulationResult) => detectIssues(m, r).map((i) => i.key).sort();
        expect(keys(toEngineModel(snap.bundle, opts), b)).toEqual(keys(toEngineModel(w.bundle, opts), a));
      });
    }
  }
});

describe("default deny: a string under a key nobody classified is free text", () => {
  const NOT_TEXT = new Set(SHARE_NON_TEXT_KEYS);

  it("an unknown key holding a person's and a client's name is scrubbed, refused raw and clean once redacted, in every toggle combination", () => {
    const w = worlds[0]!;
    const [person, , ] = w.personFull;
    for (const key of ["handoff_note", "x", "auto_verdict_note", "brand_new_field"]) {
      for (const toggles of TOGGLES) {
        const input = { ...raw("process", w, toggles), extra: { [key]: `Ask ${person} at ${w.clientNames[0]}` } } as unknown as ShareSnapshot;
        const out = redactShareSnapshot(input, toggles, w.secrets) as unknown as { extra: Record<string, string> };
        expect(out.extra[key], `${key} ${label(toggles)}`).toContain("Client 1");
        if (!toggles.people) expect(out.extra[key], `${key} ${label(toggles)}`).not.toContain(person!.split(" ")[1]!);
        expect(shareSnapshotLeaks(out, w.secrets, toggles)).toEqual([]);
        expect(shareSnapshotLeaks(input, w.secrets, toggles)).toContain("client");
      }
    }
    // The same text under a key that is no text is left alone (an id or an enum the engine reads).
    const input = { ...raw("process", w, TOGGLES[0]!), extra: { path: `steps.${w.clientNames[0]}.price`, kind: "task" } } as unknown as ShareSnapshot;
    const out = redactShareSnapshot(input, TOGGLES[0]!, w.secrets) as unknown as { extra: Record<string, string> };
    expect(out.extra.kind).toBe("task");
  });

  it("the two lists don't overlap", () => {
    expect(SHARE_FREE_TEXT_KEYS.filter((k) => NOT_TEXT.has(k))).toEqual([]);
    // Text that people type is never on the no-text list.
    for (const k of ["name", "title", "notes", "description", "evidence", "label", "email", "condition_tag", "path_tags", "who", "root", "source"]) expect(NOT_TEXT.has(k), k).toBe(false);
  });

  for (const w of worlds) {
      it(`${w.name}: no person's or client's name survives in any string, in any toggle combination`, () => {
      const parts = [...new Set(w.secrets.people.flatMap((p) => p.name.toLowerCase().split(/\s+/)).filter((x) => x.length >= 3))];
      for (const toggles of TOGGLES) {
        for (const kind of KINDS) {
          const out = JSON.stringify(redactShareSnapshot(raw(kind, w, toggles), toggles, w.secrets)).toLowerCase();
          for (const c of w.clientNames) expect(out, `${kind} ${label(toggles)} client ${c}`).not.toContain(c.toLowerCase());
          if (!toggles.people) for (const p of parts) expect(out.replace(/"[a-z_]+":/g, ""), `${kind} ${label(toggles)} ${p}`).not.toMatch(new RegExp(`(?<![a-z])${p}(?![a-z])`));
        }
      }
    });
  }
});

describe("the fourth round: ids, whole client names, accents, scripts and brackets", () => {
  const w = worlds[0]!;
  const off = TOGGLES[0]!;
  const bare = (extra: object, toggles: ShareToggles = off) => ({ v: SHARE_SNAPSHOT_VERSION, kind: "overview", toggles, workspaceName: "w", ...extra }) as unknown as ShareSnapshot;
  const redactTitle = (title: string, secrets: ShareSecrets = w.secrets, toggles: ShareToggles = off) =>
    (redactShareSnapshot({ ...raw("process", w, toggles), issues: [{ ...w.issue, title, evidence: null }] } as ShareSnapshot, toggles, secrets) as unknown as { issues: IssueRow[] }).issues[0]!.title;

  it("random uuids are never money, an email or a name: 10,000 of them pass both the scrub and the check", () => {
    const ids: string[] = Array.from({ length: 10_000 }, () => randomUUID());
    ids.push("0184c93c-120f-4cad-9a3c-5d3e1b2c199c", "00000000-0000-4000-8000-1b2c199cad1a", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "4cad4cad4cad4cad4cad4cad");
    for (const toggles of TOGGLES) {
      const input = bare({ ids, paths: ids.slice(0, 50).map((i) => `steps.${i}.work_hours`), model_hash: ids[ids.length - 2] }, toggles);
      expect(shareSnapshotLeaks(input, w.secrets, toggles), label(toggles)).toEqual([]);
      const out = redactShareSnapshot(input, toggles, w.secrets) as unknown as { ids: string[]; paths: string[]; model_hash: string };
      expect(out.ids, label(toggles)).toEqual(ids);
      expect(out.paths).toEqual((input as unknown as { paths: string[] }).paths);
      expect(out.model_hash).toBe(ids[ids.length - 2]);
    }
  });

  it("a currency code is a standalone token: glued to a digit inside something longer it is no money", () => {
    for (const text of ["order 123cad456", "ref 5cadx", "code 12CAD7", "v4cad", "a1cad"]) expect(shareSnapshotLeaks(bare({ note: text }), w.secrets, off), text).not.toContain("money");
    for (const text of ["costs 5 CAD", "12 cad.", "(40 USD)"]) expect(shareSnapshotLeaks(bare({ note: text }), w.secrets, off), text).toContain("money");
  });

  const everyday = [
    "Group review on Friday", "Care plan", "Hire a freelancer for holiday cover", "Estate agents", "Lane closure", "Planning call", "Legal check",
    "Tea break", "Coffee with the team", "Trust score", "Theory of change", "Financial review", "Quarterly review", "Budget meeting", "Weekly stand-up",
    "Book the venue", "Garden party", "School run", "Dental appointment", "Driving test", "Kids club", "Yoga class", "Rail strike", "Outdoor event",
    "Heritage walk", "Kettle descaling",
  ];
  for (const world of worlds) {
    it(`${world.name}: a word of a client's name is no client: ${everyday.length} ordinary phrases are unchanged, and each client's whole name is still replaced`, () => {
      for (const toggles of TOGGLES) {
        const w2 = world;
        const title = (t: string) => (redactShareSnapshot({ ...raw("process", w2, toggles), issues: [{ ...w2.issue, title: t, evidence: null }] } as ShareSnapshot, toggles, w2.secrets) as unknown as { issues: IssueRow[] }).issues[0]!.title;
        for (const phrase of everyday) {
          const out = title(phrase);
          // With People off a person's name part may change a phrase; a client never does.
          if (toggles.people) expect(out, `${label(toggles)}: ${phrase}`).toBe(phrase);
          else expect(out, `${label(toggles)}: ${phrase}`).not.toMatch(/Client \d/);
        }
        w2.clientNames.forEach((c, i) => {
          expect(title(`at ${c}`), c).toBe(`at Client ${i + 1}`);
          expect(title(`at ${c.toUpperCase()}.`), c).toBe(`at Client ${i + 1}.`);
          expect(title(`at ${c.replace(/ /g, "-")}`), c).toBe(`at Client ${i + 1}`);
          expect(title(`at ${c.replace(/[^\p{L}]/gu, "")}`), c).toBe(`at Client ${i + 1}`);
        });
      }
    });
  }

  it("accents are folded both ways, and Turkish, Greek and the letters that don't decompose agree", () => {
    const extra = [
      ["José Núñez", "Jose Nunez said", "Team member 90 said"],
      ["Zoë Łukasiewicz", "Zoe Lukasiewicz", "Team member 91"],
      ["Søren Ødegård", "Soren Odegard", "Team member 92"],
      ["Ramon Munoz", "Ramón Muñoz", "Team member 93"],
      ["Αλέξης Παπά", "ΑΛΈΞΗΣ ΠΑΠΆ", "Team member 94"],
      ["İbrahim Yılmaz", "Ibrahim Yilmaz said", "Team member 95 said"],
      ["Ana Strauß", "ANA STRAUSS", "Team member 96"],
    ] as const;
    const secrets: ShareSecrets = { ...w.secrets, people: [...w.secrets.people, ...extra.map(([name], i) => ({ id: `00000000-0000-4000-8000-0000000000f${i}`, name, label: `Team member ${90 + i}` }))] };
    extra.forEach(([name, text, expected]) => {
      expect(redactTitle(text, secrets), `${name} / ${text}`).toBe(expected);
      expect(redactTitle(name, secrets), name).toBe(expected.replace(/ said$/, ""));
      expect(shareSnapshotLeaks({ ...bare({}), note: text }, secrets, off), text).toContain("person");
    });
  });

  it("a name in Han, Kana or Hangul, or any non-Latin script, counts from 2 characters, also inside an unspaced run", () => {
    const people = [
      { id: "00000000-0000-4000-8000-0000000000e1", name: "李伟", label: "Team member 80" },
      { id: "00000000-0000-4000-8000-0000000000e2", name: "田中 太郎", label: "Team member 81" },
      { id: "00000000-0000-4000-8000-0000000000e3", name: "Ωμέγα Νίκος", label: "Team member 82" },
    ];
    const secrets: ShareSecrets = { ...w.secrets, people: [...w.secrets.people, ...people] };
    expect(redactTitle("李伟 said", secrets)).toBe("Team member 80 said");
    expect(redactTitle("李伟说过", secrets)).toBe("Team member 80说过");
    expect(redactTitle("请联系田中太郎", secrets)).toMatch(/Team member 81/);
    expect(redactTitle("Νίκος", secrets)).toBe("Team member 82");
    for (const text of ["李伟 said", "李伟说过", "Νίκος"]) expect(shareSnapshotLeaks({ ...bare({}), note: text }, secrets, off), text).toContain("person");
    // A two-letter Latin name is still no name.
    const li: ShareSecrets = { ...w.secrets, people: [...w.secrets.people, { id: "00000000-0000-4000-8000-0000000000e4", name: "Li", label: "Team member 83" }] };
    expect(redactTitle("Li is here", li)).toBe("Li is here");
  });

  it("brackets stay balanced: priya (Shah) is one name, (Priya Shah) keeps its brackets", () => {
    const [first, surname] = w.personFull[0]!.split(" ") as [string, string];
    expect(redactTitle(`${first.toLowerCase()} (${surname})`)).toBe("Team member 1");
    expect(redactTitle(`${first.toLowerCase()} [${surname}] said`)).toBe("Team member 1 said");
    expect(redactTitle(`(${first} ${surname})`)).toBe("(Team member 1)");
    expect(redactTitle(`ask ${first} (${surname}), then`)).toBe("ask Team member 1, then");
  });
});

describe("the fifth round: tags, ids, names and money", () => {
  const w = worlds[0]!;
  const off = TOGGLES[0]!;
  const bare = (extra: object, toggles: ShareToggles = off) => ({ v: SHARE_SNAPSHOT_VERSION, kind: "overview", toggles, workspaceName: "w", ...extra }) as unknown as ShareSnapshot;
  const redactTitle = (title: string, secrets: ShareSecrets = w.secrets, toggles: ShareToggles = off) =>
    (redactShareSnapshot({ ...raw("process", w, toggles), issues: [{ ...w.issue, title, evidence: null }] } as ShareSnapshot, toggles, secrets) as unknown as { issues: IssueRow[] }).issues[0]!.title;

  for (const world of worlds) {
    it(`${world.name}: a name inside a condition tag or a path tag is hidden on an edge and on a service the same way, so the tags still match and the numbers stay equal`, () => {
      const first = world.personFull[0]!.split(" ")[0]!.toLowerCase();
      const tagged: ProcessBundle = {
        ...world.bundle,
        edges: world.bundle.edges.map((e) => (e.condition_tag ? { ...e, condition_tag: `${first}-${e.condition_tag}` } : e)),
        services: world.bundle.services.map((sv) => ({ ...sv, path_tags: (sv.path_tags ?? []).map((t: string) => `${first}-${t}`) })),
      };
      expect(tagged.edges.some((e) => e.condition_tag), "the fixture has tagged edges").toBe(true);
      expect(tagged.services.some((sv) => (sv.path_tags ?? []).length), "the fixture has tagged services").toBe(true);
      const opts = { startDate: "2026-10-05" };
      const a = simulate(toEngineModel(tagged, opts), 30, 1);
      for (const toggles of TOGGLES) {
        const snap = redactShareSnapshot(raw("process", { ...world, bundle: tagged }, toggles), toggles, world.secrets) as unknown as { bundle: ProcessBundle };
        if (!toggles.people) {
          const tags = [...snap.bundle.edges.flatMap((e) => (e.condition_tag ? [e.condition_tag] : [])), ...snap.bundle.services.flatMap((sv) => sv.path_tags ?? [])];
          expect(tags.length).toBeGreaterThan(0);
          for (const t of tags) {
            expect(t.toLowerCase(), label(toggles)).not.toContain(first);
            expect(t, label(toggles)).toContain("Team member");
          }
        }
        const b = simulate(toEngineModel(snap.bundle, opts), 30, 1);
        for (const k of ["mrrAdded", "billed", "ltvAdded", "lostRevenue"] as const) expect(b.kpi[k], `${k} ${label(toggles)}`).toEqual(a.kpi[k]);
        expect(b.bnRole).toEqual(a.bnRole);
        expect(shareSnapshotLeaks(snap, world.secrets, toggles), label(toggles)).toEqual([]);
      }
    });
  }

  it("ids: one rule in the app and the database; a uuid inside longer text is still an id; an email with a hex local part is still an email", () => {
    const id = "0184c93c-120f-4cad-9a3c-5d3e1b2c199c";
    for (const text of [`x${id}x`, `ref:${id}.`, `${id}${id}`]) {
      expect(redactTitle(text), text).toBe(text);
      expect(shareSnapshotLeaks(bare({ note: text }), w.secrets, off), text).toEqual([]);
    }
    expect(redactTitle(`${id}${w.personFull[0]!.split(" ")[1]!.toLowerCase()}`)).toContain("Team member");
    for (const email of ["a1b2c3d4e5f6a7b8@client.example", "ask a1b2c3d4e5f6a7b8c9d0@client.example now", "x@a1b2c3d4e5f6a7b8.example"]) {
      expect(redactTitle(email), email).toContain("[email hidden]");
      expect(shareSnapshotLeaks(bare({ note: email }), w.secrets, off), email).toContain("email");
    }
  });

  it("clients: 'and' and '&' are the same, stop words may sit between the words; CJK clients are found inside unspaced text", () => {
    const clients: ShareSecrets["clients"] = [
      { id: "00000000-0000-4000-8000-0000000000c1", name: "Quince & Sloe Bakery", label: "Client 90" },
      { id: "00000000-0000-4000-8000-0000000000c2", name: "Aldous and Pike Solicitors", label: "Client 91" },
      { id: "00000000-0000-4000-8000-0000000000c3", name: "株式会社山田", label: "Client 92" },
      { id: "00000000-0000-4000-8000-0000000000c4", name: "The Maple Group Ltd", label: "Client 93" },
    ];
    const secrets: ShareSecrets = { ...w.secrets, clients: [...w.secrets.clients, ...clients] };
    const on = TOGGLES[1]!;
    for (const [text, expected] of [
      ["Quince and Sloe Bakery", "Client 90"], ["quince & sloe bakery", "Client 90"], ["Quince+Sloe Bakery", "Client 90"], ["at Quince and Sloe Bakery.", "at Client 90."],
      ["Aldous & Pike Solicitors", "Client 91"], ["Aldous and Pike Solicitors", "Client 91"], ["Aldous Pike Solicitors", "Client 91"],
      ["株式会社山田に連絡", "Client 92に連絡"], ["The Maple Group Ltd", "The Client 93 Ltd"], ["Maple Group", "Client 93"],
    ] as const) {
      expect(redactTitle(text, secrets, on), text).toBe(expected);
      expect(shareSnapshotLeaks(bare({ note: text }, on), secrets, on), text).toContain("client");
    }
    // A single word of a client's name is still no client.
    expect(redactTitle("a quince in the sloe", secrets, on)).toBe("a quince in the sloe");
  });

  it("people: an unspaced CJK name is found by its surname or given name alone; German umlauts are Mueller too", () => {
    const people = [
      { id: "00000000-0000-4000-8000-0000000000e1", name: "田中太郎", label: "Team member 80" },
      { id: "00000000-0000-4000-8000-0000000000e2", name: "김민준", label: "Team member 81" },
      { id: "00000000-0000-4000-8000-0000000000e3", name: "Hans Müller", label: "Team member 82" },
      { id: "00000000-0000-4000-8000-0000000000e4", name: "Anna Schroeder", label: "Team member 83" },
    ];
    const secrets: ShareSecrets = { ...w.secrets, people: [...w.secrets.people, ...people] };
    for (const [text, expect_] of [
      ["田中さん", "Team member 80さん"], ["太郎に", "Team member 80に"], ["田中太郎", "Team member 80"],
      ["민준 said", "Team member 81 said"], ["김민준", "Team member 81"],
      ["Hans Mueller", "Team member 82"], ["MUELLER", "Team member 82"], ["Hans Muller", "Team member 82"], ["Müller", "Team member 82"],
      ["Anna Schröder", "Team member 83"], 
    ] as const) {
      expect(redactTitle(text, secrets), text).toBe(expect_);
      expect(shareSnapshotLeaks(bare({ note: text }), secrets, off), text).toContain("person");
    }
  });

  it("money joined with a hyphen or a slash, and scientific notation, is money", () => {
    for (const text of ["4100-GBP", "GBP-4100", "GBP/4100", "4100/GBP", "1e6 GBP", "1.5e3 USD", "usd-1e6"]) {
      const out = redactTitle(text);
      expect(out, text).toBe("[amount hidden]");
      expect(shareSnapshotLeaks(bare({ note: text }), w.secrets, off), text).toContain("money");
    }
    // By design no money: the code is glued to letters or digits inside something longer.
    for (const text of ["ref4100GBP", "CAD3D", "4100GBPx"]) expect(shareSnapshotLeaks(bare({ note: text }), w.secrets, off), text).not.toContain("money");
  });

  it("B3 follow-up: a date, a version or a standard's number joined to a code by a hyphen or a slash is no money, and is left as written", () => {
    for (const { text, joinedBy } of MONEY_NOT) {
      expect(redactTitle(text), `${text} (${joinedBy})`).toBe(text);
      expect(shareSnapshotLeaks(bare({ note: text }), w.secrets, off), text).not.toContain("money");
    }
    for (const { text, like } of MONEY_NOT_VARIANTS) {
      expect(redactTitle(text), `${text} (like ${like})`).toBe(text);
      expect(shareSnapshotLeaks(bare({ note: text }), w.secrets, off), text).not.toContain("money");
    }
  });

  it("B3 follow-up: every case through main's old rule and the new one: what the old refused, the new refuses, except the listed exemptions; the new refuses nothing the old didn't", () => {
    const oldFlags = (text: string) => new RegExp(OLD_SHARE_MONEY_SOURCE, "giu").test(normaliseView(text).n);
    const newFlags = (text: string) => shareSnapshotLeaks(bare({ note: text }), w.secrets, off).includes("money");
    const exempt = new Set([...MONEY_NOT.map((c) => c.text), ...MONEY_NOT_VARIANTS.map((c) => c.text)]);
    const all = [...exempt, ...MONEY_YES, ...MONEY_OTHER];
    const lost = all.filter((t) => oldFlags(t) && !newFlags(t) && !exempt.has(t));
    const gained = all.filter((t) => newFlags(t) && !oldFlags(t));
    expect(lost).toEqual([]);
    expect(gained).toEqual([]);
    // Each exemption really was refused before (it is a change, not a no-op), and each money text was too.
    for (const t of exempt) expect(oldFlags(t), t).toBe(true);
    for (const t of MONEY_YES) expect(oldFlags(t), t).toBe(true);
  });

  it("B3 follow-up: every money form is still hidden and still flagged", () => {
    for (const text of MONEY_YES) {
      expect(redactTitle(text), text).toContain("[amount hidden]");
      expect(shareSnapshotLeaks(bare({ note: text }), w.secrets, off), text).toContain("money");
      // With Financials on, nothing is hidden.
      expect(redactTitle(text, w.secrets, { ...off, financials: true }), text).toBe(text);
    }
  });

  it("B3 follow-up: color and plan are free text (the database checks neither): a name typed into one is hidden and flagged; a hex colour and a plan word are left", () => {
    const name = w.personFull[0]!;
    for (const extra of [{ roles: [{ color: name }] }, { workspace: { plan: name } }]) {
      expect(shareSnapshotLeaks(bare(extra), w.secrets, off), JSON.stringify(extra)).toContain("person");
      expect(JSON.stringify(redactShareSnapshot(bare(extra), off, w.secrets))).not.toContain(name);
    }
    const plain = bare({ roles: [{ color: "#2a78d6" }], workspace: { plan: "agency" } });
    expect(shareSnapshotLeaks(plain, w.secrets, off)).toEqual([]);
    expect(redactShareSnapshot(plain, off, w.secrets)).toMatchObject({ roles: [{ color: "#2a78d6" }], workspace: { plan: "agency" } });
  });

  it("B3 follow-up: the words that make a number an identifier are the database's (the same list in the migration's money rule)", () => {
    const sql = readFileSync(join(__dirname, "..", "supabase/migrations/20261228000000_share_money_rule.sql"), "utf8");
    const body = sql.slice(sql.search(/^create or replace function private\.share_snapshot_problem\(/m));
    const lists = [...body.matchAll(/\(\?<!\(\^\|\[\^a-z\]\)\(([a-z|]+)\)\[\[:space:\]\]\+\)/g)].map((m) => m[1]!);
    // The standard words guard both plain-number forms; the other words only the 1- or 2-digit one.
    expect(lists).toEqual([JOIN_STANDARD_WORDS.join("|"), JOIN_STANDARD_WORDS.join("|"), JOIN_WORDS.join("|")]);
  });
});

describe("payHidden on a bundle", () => {
  it("a viewer who sees everyone, with payHidden, gets a model with no person cost and payHidden", () => {
    const w = worlds[1]!;
    const sees = { ...w.bundle, viewer: { seesEveryone: true, ownPersonId: null } };
    const plain = toEngineModel(sees, { startDate: "2026-10-05" });
    expect(plain.payHidden).toBeUndefined();
    expect(Object.values(plain.people ?? {}).some((p) => p.cost != null)).toBe(true);
    const hidden = toEngineModel({ ...sees, payHidden: true }, { startDate: "2026-10-05" });
    expect(hidden.payHidden).toBe(true);
    for (const p of Object.values(hidden.people ?? {})) expect(p.cost).toBeUndefined();
    // Names still come through for a viewer who sees everyone.
    expect(Object.values(hidden.people ?? {}).map((p) => p.name)).toEqual(Object.values(plain.people ?? {}).map((p) => p.name));
  });
});

describe("hiddenLevers on a process snapshot (B4)", () => {
  const people = (names: string[]) => names.map((name, i) => ({ id: `00000000-0000-4000-8000-00000000fe${i}0`.slice(0, 36), name, label: `Team member ${80 + i}` }));

  it("is on the no-text list, and holds only known kind ids in catalogue order", () => {
    expect(SHARE_NON_TEXT_KEYS).toContain("hiddenLevers");
    expect(SHARE_FREE_TEXT_KEYS).not.toContain("hiddenLevers");
    expect(cleanHiddenLevers(["process.wait", "nope", 3, "demand.enquiries", "process.wait"])).toEqual(["demand.enquiries", "process.wait"]);
    expect(LEVER_KIND_IDS).toHaveLength(21);
    expect(new Set(LEVER_KIND_IDS).size).toBe(21);
  });

  it("a person called Wait, Leave or Hours doesn't change it with People off, and the leak check passes, in every toggle combination", () => {
    for (const w of worlds) {
      for (const toggles of TOGGLES) {
        const secrets: ShareSecrets = { ...w.secrets, people: [...w.secrets.people, ...people(["Wait Leave", "Ann Hours", "Process Time", "Sam People"])] };
        const input = raw("process", w, toggles) as unknown as { hiddenLevers: string[] };
        expect(input.hiddenLevers).toEqual(["process.rework", "people.leave"]);
        const out = redactShareSnapshot(input as unknown as ShareSnapshot, toggles, secrets) as unknown as { hiddenLevers: string[] };
        expect(out.hiddenLevers, `${w.name} ${label(toggles)}`).toEqual(["process.rework", "people.leave"]);
        expect(shareSnapshotLeaks(out, secrets, toggles)).toEqual([]);
      }
    }
  });

  it("a hiddenLevers nested anywhere but the top is a mismatch (it would skip the name checks)", () => {
    const w = worlds[0]!;
    const t = TOGGLES[0]!;
    const out = redactShareSnapshot(raw("process", w, t), t, w.secrets) as unknown as Record<string, unknown>;
    for (const nested of [{ x: { hiddenLevers: "a name" } }, { deep: [{ hiddenLevers: ["process.wait"] }] }]) {
      expect(shareSnapshotLeaks({ ...out, ...nested }, w.secrets, t), JSON.stringify(nested)).toContain("mismatch");
    }
  });

  it("the checker refuses a hiddenLevers that isn't an array of at most 30 distinct known ids (mismatch)", () => {
    const w = worlds[0]!;
    const t = TOGGLES[0]!;
    const out = redactShareSnapshot(raw("process", w, t), t, w.secrets) as unknown as Record<string, unknown>;
    for (const bad of ["process.wait", { a: 1 }, [1], ["Priya"], ["process.wait", "process.wait"], LEVER_KIND_IDS.concat(LEVER_KIND_IDS).slice(0, 31)]) {
      expect(shareSnapshotLeaks({ ...out, hiddenLevers: bad }, w.secrets, t), JSON.stringify(bad)).toContain("mismatch");
    }
    expect(shareSnapshotLeaks({ ...out, hiddenLevers: [] }, w.secrets, t)).toEqual([]);
    const { hiddenLevers: _x, ...bare } = out;
    expect(shareSnapshotLeaks(bare, w.secrets, t)).toEqual([]);
    expect(validHiddenLevers(undefined)).toBe(true);
  });
});

describe("per-person times never reach a share link (C6)", () => {
  const factorRow = (w: (typeof worlds)[number]) => ({ person_id: w.bundle.people[0]!.id, workspace_id: w.bundle.workspace.id, step_id: null, factor: 0.8, source: "entered" });

  for (const kind of KINDS) {
    for (const toggles of TOGGLES) {
      it(`${worlds[0]!.name} ${kind}, ${label(toggles)}: a raw snapshot built from an editor's bundle that carries factors comes out with an empty list, and no capacityFactor`, () => {
        const w = worlds[0]!;
        const withFactors = {
          ...w,
          bundle: { ...w.bundle, personCapacityFactors: [factorRow(w)], workspace: { ...w.bundle.workspace, settings: { ...w.bundle.workspace.settings, capacity_factor_enabled: true } } },
        };
        const input = raw(kind, withFactors, toggles);
        expect(JSON.stringify(input)).toContain('"factor":0.8');
        // The leak check sees it in the raw snapshot...
        expect(shareSnapshotLeaks(input, w.secrets, toggles)).toContain("speeds");
        const snap = redactShareSnapshot(input, toggles, w.secrets);
        const text = JSON.stringify(snap);
        // ...and the redaction empties it, wherever the bundle sits.
        expect(text).not.toContain('"factor":0.8');
        expect(text).not.toContain("capacityFactor");
        for (const list of valuesOf(snap, "personCapacityFactors")) expect(list).toEqual([]);
        expect(shareSnapshotLeaks(snap, w.secrets, toggles)).not.toContain("speeds");
      });
    }
  }

  it("shareSnapshotLeaks reports a non-empty personCapacityFactors, or any capacityFactor key, anywhere; an empty list is clean", () => {
    const w = worlds[0]!;
    const toggles = TOGGLES[0]!;
    const clean = redactShareSnapshot(raw("overview", w, toggles), toggles, w.secrets);
    expect(shareSnapshotLeaks(clean, w.secrets, toggles)).toEqual([]);
    const nested = (extra: object) => ({ ...clean, live: { ...(clean as unknown as { live: object }).live, ...extra } });
    expect(shareSnapshotLeaks(nested({ personCapacityFactors: [] }), w.secrets, toggles)).toEqual([]);
    expect(shareSnapshotLeaks(nested({ personCapacityFactors: [factorRow(w)] }), w.secrets, toggles)).toEqual(["speeds"]);
    expect(shareSnapshotLeaks(nested({ person_capacity_factors: [factorRow(w)] }), w.secrets, toggles)).toEqual(["speeds"]);
    expect(shareSnapshotLeaks(nested({ model: { people: { p: { capacityFactor: { default: 0.9 } } } } }), w.secrets, toggles)).toEqual(["speeds"]);
  });

  it("a snapshot's bundle simulates at everyone's normal time (it holds no factor, and payHidden keeps toEngineModel from reading any)", () => {
    const w = worlds[0]!;
    const b = { ...w.bundle, payHidden: true as const, personCapacityFactors: [factorRow(w)], workspace: { ...w.bundle.workspace, settings: { ...w.bundle.workspace.settings, capacity_factor_enabled: true } } };
    expect(Object.values(toEngineModel(b, { startDate: "2026-10-05" }).people ?? {}).some((p) => p.capacityFactor)).toBe(false);
  });
});
