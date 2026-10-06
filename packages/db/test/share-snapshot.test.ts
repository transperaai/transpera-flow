import { detectIssues, parsePatchPath, simulate, type DetectedIssue, type SimulationResult } from "@transpera-flow/engine";
import { describe, expect, it, vi } from "vitest";
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
      return { ...base, kind, live: w.bundle, parts: [], company: null, issues: common.issues, solutions, solutionBases: {}, findings: [finding as never], firstPrinciples: null };
    case "process":
      return { ...base, kind, bundle: w.bundle, processes: [{ id: w.bundle.process.id, name: w.bundle.process.name, parentId: null, kind: "pipeline" as const }], scenarios: [], issues: common.issues, liveRevisions: {}, solutions, findings: [finding as never], firstPrinciples: null };
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
    const snap = redactShareSnapshot({ ...input, issues: texts.map((t) => ({ ...w.issue, title: `x ${t} y`, evidence: "Ids 20261218000000 and 12 hours" })) } as ShareSnapshot, TOGGLES[0]!, w.secrets) as { issues: IssueRow[] };
    for (const i of snap.issues) {
      expect(i.title).toBe("x [amount hidden] y");
      expect(i.evidence).toBe("Ids 20261218000000 and 12 hours");
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

  it("a name as a JSON key is replaced and flagged too", () => {
    const base = raw("process", w, off);
    const input = { ...base, liveRevisions: { [`${first} ${surname}`]: "r1" } } as unknown as ShareSnapshot;
    const out = redactShareSnapshot(input, off, secrets) as unknown as { liveRevisions: Record<string, string> };
    expect(Object.keys(out.liveRevisions)).toEqual(["Team member 1"]);
    expect(shareSnapshotLeaks(input, secrets, off)).toContain("person");
  });

  it("the check refuses a name word next to a label, however the name was written", () => {
    const base = raw("process", w, off);
    const snap = (title: string) => redactShareSnapshot({ ...base, issues: [{ ...w.issue, title, evidence: null }] } as ShareSnapshot, off, secrets);
    const clean = snap("fine");
    const withTitle = (title: string) => ({ ...clean, issues: [{ ...(clean as unknown as { issues: IssueRow[] }).issues[0]!, title }] });
    for (const bad of [`Team member 1 ${surname}`, `${first} Team member 1`, `${surname.toUpperCase()} Team member 12`, `Team member 3 ${first.toLowerCase()}`]) {
      expect(shareSnapshotLeaks(withTitle(bad), secrets, off), bad).toContain("person");
    }
    expect(shareSnapshotLeaks(withTitle("Team member 1 and Team member 2"), secrets, off)).toEqual([]);
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
    ] as const) {
      const base = raw("process", w, off);
      const input = { ...base, issues: [{ ...w.issue, title: text, evidence: null }] } as ShareSnapshot;
      const out = redactShareSnapshot(input, off, w.secrets) as unknown as { issues: IssueRow[] };
      expect(out.issues[0]!.title, text).toBe(expected);
      expect(shareSnapshotLeaks(input, w.secrets, off), text).toContain("money");
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
      [{ x: `at ${w.clientNames[0]}` }, "client"],
      [{ x: `ask ${w.personFull[0]}` }, "person"],
      [{ x: `ask ${w.personFirst[0]}` }, "person"],
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
    expect(shareSnapshotLeaks(snap({ x: w.clientNames[0] }), w.secrets, on)).toEqual(["client"]);
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
