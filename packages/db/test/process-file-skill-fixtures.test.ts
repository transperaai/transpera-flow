import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { checkProcessFile, findGaps, gapInputFromFile, type ProcessFile } from "../src";

// The process-file skill's output (issue #167, B14 part 2, .agents/skills/process-file/SKILL.md), written by hand the way the skill
// would write it, for the two interview packs in the repo: Tidewater (docs/extraction/examples/tidewater) and the Copperleaf QA
// interviews (docs/extraction/qa). They live in docs/import/examples/. Pure: no database. The upload of the same files over
// PostgREST is packages/mcp/test/postgrest-skill-fixtures.test.ts.

const IMPORT = new URL("../../../docs/import/", import.meta.url);
const read = (url: URL) => readFileSync(url, "utf8");
const schema = JSON.parse(read(new URL("transpera-process-2.schema.json", IMPORT)));
const validate = new Ajv2020({ strict: false }).compile(schema);

interface Pack {
  name: string;
  file: string;
  /** The transcript behind each source id. */
  transcripts: Record<string, string>;
}
const PACKS: Pack[] = [
  {
    name: "Tidewater: Monthly client report",
    file: "examples/tidewater-monthly-client-report.json",
    transcripts: {
      "interview-hana": "../extraction/examples/tidewater/interview-1.txt",
      "interview-owen": "../extraction/examples/tidewater/interview-2.txt",
    },
  },
  {
    name: "Copperleaf: Enquiry to signed client",
    file: "examples/copperleaf-enquiry-to-signed-client.json",
    transcripts: {
      "interview-grace": "../extraction/qa/interview-1.txt",
      "interview-tom": "../extraction/qa/interview-2.txt",
    },
  },
];

const raw = (p: Pack) => JSON.parse(read(new URL(p.file, IMPORT)));
const checked = (p: Pack) => {
  const c = checkProcessFile(raw(p));
  return { ...c, file: c.file as ProcessFile };
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every quote in the file, wherever it sits: step evidence, link evidence, company, proposals, first principles. */
function citations(v: unknown): Obj[] {
  if (Array.isArray(v)) return v.flatMap(citations);
  if (!isObj(v)) return [];
  return (typeof v.quote === "string" && typeof v.source === "string" ? [v] : []).concat(Object.values(v).flatMap(citations));
}

/** The way the checker compares a quote with a source: case, punctuation and spacing ignored. */
const squash = (s: string) => s.toLowerCase().replace(/[\s‘’“”"'`.,;:!?()[\]-]+/g, " ").trim();

/** `[00:03:12] Hana Iqbal: text` lines by their time. */
function lines(path: string): Map<string, { speaker: string; text: string }> {
  const out = new Map<string, { speaker: string; text: string }>();
  for (const line of read(new URL(path, IMPORT)).split("\n")) {
    const m = /^\[(\d\d:\d\d:\d\d)\] ([^:]+): (.*)$/.exec(line);
    if (m) out.set(m[1]!, { speaker: m[2]!, text: m[3]! });
  }
  return out;
}

describe.each(PACKS)("$name", (pack) => {
  it("validates against the published schema and the checker has nothing to correct", () => {
    const file = raw(pack);
    expect(validate(file), JSON.stringify(validate.errors)).toBe(true);
    const c = checkProcessFile(file);
    expect(c.errors).toEqual([]);
    expect(c.warnings).toEqual([]);
    expect(c.file!.format).toBe("transpera-process/2");
  });

  it("every quote is word for word on the line at its time, said by the speaker named", () => {
    const f = raw(pack);
    const sources = new Map(Object.entries(pack.transcripts).map(([id, path]) => [id, lines(path)]));
    const cites = citations(f);
    expect(cites.length).toBeGreaterThan(20);
    for (const c of cites) {
      const transcript = sources.get(c.source as string);
      expect(transcript, `source ${String(c.source)} has a transcript`).toBeDefined();
      const line = transcript!.get(c.time as string);
      expect(line, `a line at ${String(c.time)} in ${String(c.source)}`).toBeDefined();
      expect(c.speaker, `speaker of "${String(c.quote)}"`).toBe(line!.speaker);
      expect(squash(line!.text), `"${String(c.quote)}" at ${String(c.time)}`).toContain(squash(c.quote as string));
    }
  });

  it("every source is real: listed speakers include everyone quoted, and every source is cited", () => {
    const f = raw(pack);
    const cited = new Set(citations(f).map((c) => c.source));
    for (const s of f.sources as { id: string; speakers: string[] }[]) {
      expect(cited.has(s.id), `${s.id} is cited`).toBe(true);
      for (const c of citations(f).filter((x) => x.source === s.id)) expect(s.speakers).toContain(c.speaker);
    }
  });

  it("every number carries a quote or an assumed reason, and nothing is left at a default", () => {
    const f = raw(pack);
    for (const s of f.steps as Obj[]) {
      const evidence = (s.evidence ?? {}) as Obj;
      const assumed = (s.assumed ?? {}) as Obj;
      const backed = (field: string) => (Array.isArray(evidence[field]) && (evidence[field] as unknown[]).length > 0) || typeof assumed[field] === "string";
      for (const field of ["hands_on_hours", "wait_hours", "rework_rate", "waiting_now", "sla_hours"]) {
        const given = s[field] !== undefined || (field === "hands_on_hours" && s.hands_on_range) || (field === "wait_hours" && s.wait_range) || (Array.isArray(evidence[field]) && (evidence[field] as Obj[]).some((c) => c.value !== undefined));
        if (given) expect(backed(field), `${String(s.name)}: ${field} has no quote or assumed reason`).toBe(true);
      }
    }
    for (const l of f.links as Obj[]) {
      if (l.probability !== undefined || (Array.isArray(l.evidence) && l.evidence.length)) {
        expect(Array.isArray(l.evidence) || typeof l.assumed === "string", `link ${String(l.from)} to ${String(l.to)}`).toBe(true);
      }
    }
    for (const section of ["people", "clients"] as const) {
      for (const item of (f.company?.[section] ?? []) as Obj[]) expect(item.evidence ?? item.assumed, `${section}: ${String(item.name)}`).toBeDefined();
    }
    for (const p of f.proposals as Obj[]) expect((p.evidence as unknown[]).length, String(p.title)).toBeGreaterThan(0);
  });

  it("a conflict is kept as two quotes with their own numbers, never averaged into one", () => {
    const c = checked(pack);
    for (const s of c.file.steps) {
      for (const [field, cites] of Object.entries(s.evidence ?? {})) {
        const values = new Set(cites.flatMap((q) => (q.value !== undefined ? [q.value] : [])));
        if (values.size > 1) {
          const own = field === "hands_on_hours" ? s.hands_on_hours : field === "wait_hours" ? s.wait_hours : field === "rework_rate" ? s.rework_rate : undefined;
          expect(own, `${s.name} ${field}: the number is left out where sources disagree`).toBeUndefined();
        }
      }
    }
  });
});

describe("Tidewater: Monthly client report", () => {
  const pack = PACKS[0]!;

  it("is a servicing process with a technical check only Owen mentions, and rework back to the commentary", () => {
    const f = checked(pack).file;
    expect(f.kind).toBe("servicing");
    expect(f.steps.map((s) => s.name)).toEqual(["Month end", "Pull ranking data", "Technical check", "Write commentary", "Director review", "Send report", "Follow-up call", "Report delivered"]);
    expect(f.steps.find((s) => s.id === "review")).toMatchObject({ rework_to: "commentary", person: "Callum Reid" });
    expect(f.links.find((l) => l.from === "send" && l.to === "follow-up")?.probability).toBe(0.1);
    // No loop in the links: send-backs are rework, not an edge.
    expect(f.links.every((l) => l.to !== "commentary" || l.from === "technical-check")).toBe(true);
  });

  it("keeps Hana's range as a range and flags the two disagreements", () => {
    const c = checked(pack);
    expect(c.file.steps.find((s) => s.id === "commentary")).toMatchObject({ hands_on_hours: 2.5, hands_on_range: { min: 2, max: 3 }, waiting_now: 4 });
    expect(c.conflicts).toHaveLength(2);
    expect(c.conflicts!.join("\n")).toMatch(/Pull ranking data.*hands-on time.*: 1;.*: 3\)/);
    expect(c.conflicts!.join("\n")).toMatch(/Director review.*rework rate.*0\.2;.*0\.5\)/);
  });

  it("leaves out what nobody said and reports it as missing for simulation", () => {
    const c = checked(pack);
    const review = c.file.steps.find((s) => s.id === "review")!;
    expect(review.hands_on_hours).toBeUndefined();
    const gaps = findGaps(gapInputFromFile(c.file, { hasRole: () => true, volume: "known" }));
    expect(gaps.map((g) => g.text)).toEqual(["Director review has no hands-on time"]);
    const noVolume = findGaps(gapInputFromFile(c.file, { hasRole: () => true, volume: "missing" }));
    expect(noVolume.map((g) => g.kind)).toEqual(["hands_on", "volume"]);
  });

  it("puts company facts in company, issues in proposals, and only what was said in first principles", () => {
    const f = checked(pack).file;
    expect(f.company!.people.map((p) => [p.name, p.fte, p.start_date])).toEqual([
      ["Priti Rao", 0.6, undefined],
      ["Jonah Pike", undefined, "2026-10-12"],
      ["Owen Hart", undefined, undefined],
    ]);
    expect(f.company!.people[2]!.leave).toEqual([{ start_date: "2026-12-21", end_date: "2026-12-31", note: "Booked and paid for" }]);
    expect(f.company!.clients[1]!.assignments).toEqual({ "Account manager": "Hana Iqbal", "SEO specialist": "Owen Hart" });
    expect(f.company!.clients.map((c) => [c.name, c.mrr])).toEqual([
      ["Marlow Physio", 2900],
      ["Quayside Vets", undefined],
    ]);
    expect(f.company!.demand!.lead_sources).toMatchObject([{ name: "Referrals", volume_per_week: 3 }]);
    expect(f.proposals!.map((p) => p.type)).toEqual(["issue", "issue", "issue"]);
    expect(f.first_principles!.measures![0]).toMatchObject({ kpi: "cycleHours", comparator: "atMost", target: 40 });
    expect(f.first_principles!.job).toBeUndefined();
  });
});

describe("Copperleaf: Enquiry to signed client", () => {
  const pack = PACKS[1]!;

  it("has one start, three ends and no loop: rework is a rate, not an edge", () => {
    const f = checked(pack).file;
    expect(f.steps.filter((s) => s.type === "start")).toHaveLength(1);
    expect(f.steps.filter((s) => s.type === "end").map((s) => s.name)).toEqual(["Not a fit", "Lost", "Client onboarded"]);
    expect(f.steps.find((s) => s.id === "proposal")!.rework_to).toBeUndefined();
    expect(f.steps.map((s) => s.name)).toContain("Pricing sign-off");
  });

  it("converts days at the 7.5 hour day and keeps the units as said", () => {
    const f = checked(pack).file;
    const wait = f.steps.find((s) => s.id === "book-call")!;
    expect(wait).toMatchObject({ wait_hours: 18.75, wait_range: { min: 15, max: 22.5 } });
    expect(wait.evidence!.wait_hours![0]!.quote).toBe("It's usually two or three days out before we can get them in.");
    const proposal = f.steps.find((s) => s.id === "proposal")!;
    expect(proposal.evidence!.hands_on_hours!.map((c) => c.value)).toEqual([2.5, 1.5 * 7.5]);
    expect(proposal.assumed!.hands_on_hours).toMatch(/7\.5 hour day/);
    const wait2 = f.steps.find((s) => s.id === "client-wait")!;
    // A stated ceiling ("within two weeks") is the wait, with the range that has a stated minimum.
    expect(wait2).toMatchObject({ wait_hours: 75, wait_range: { min: 7.5, max: 75 } });
    expect(proposal.sla_hours).toBe(37.5);
    expect(proposal.evidence!.sla_hours![0]!.value).toBe(5 * 7.5);
  });

  it("flags every disagreement between Grace and Tom and settles none of them", () => {
    const c = checked(pack);
    const text = c.conflicts!.join("\n");
    expect(c.conflicts).toHaveLength(6);
    expect(text).toMatch(/Send contract.*wait.*: 15;.*: 7\.5\)/);
    expect(text).toMatch(/Write proposal.*hands-on time.*2\.5.*11\.25/);
    expect(text).toMatch(/Write proposal.*rework rate.*0\.25.*0\.5/);
    expect(text).toMatch(/Onboarding call.*hands-on time/);
    expect(text).toMatch(/'Client decides' to 'Send contract'.*50%.*33%/);
    expect(text).toMatch(/'Client decides' to 'Lost'.*50%.*67%/);
    // The odds out of the decision still add up to 1 whichever middle is taken.
    const win = c.file.links.find((l) => l.to === "contract")!.probability!;
    const lost = c.file.links.find((l) => l.to === "lost")!.probability!;
    expect(win + lost).toBeCloseTo(1, 10);
  });

  it("records what the materials imply as assumed, and leaves out what they do not say", () => {
    const f = checked(pack).file;
    const step = (id: string) => f.steps.find((s) => s.id === id)!;
    // Implied ("a coffee-length thing", "briefed the day before"): a placeholder with its reason.
    expect(step("first-look")).toMatchObject({ hands_on_hours: 0.25 });
    expect(step("first-look").assumed!.hands_on_hours).toMatch(/coffee-length/);
    expect(step("deck")).toMatchObject({ hands_on_hours: 2 });
    expect(step("deck").assumed!.hands_on_hours).toMatch(/Assumed: two hours \(Austin said to assume\)/);
    expect(step("first-look").assumed!.hands_on_hours).toMatch(/\(Austin said to assume\)/);
    expect(step("audit").assumed!.hands_on_hours).toMatch(/\(Austin said to assume\)/);
    // Nothing says how long a contract takes to prepare, only how long a yes takes to become a sent contract.
    expect(step("contract").hands_on_hours).toBeUndefined();
    expect(step("contract")).toMatchObject({ waiting_now: 3 });
    expect(step("contract").evidence!.wait_hours!.map((c) => c.value)).toEqual([15, 7.5]);
    // The audit skip share ("maybe a fifth") was withdrawn: no decision, no odds.
    expect(f.steps.some((s) => s.type === "decision" && s.id !== "decides")).toBe(false);
    // The audit's four hours came from the interviewer's suggestion, and says so.
    expect(step("audit").assumed!.hands_on_hours).toMatch(/interviewer proposed four hours/);
  });

  it("reports the useful-minimum gaps by step", () => {
    const f = checked(pack).file;
    const gaps = findGaps(gapInputFromFile(f, { hasRole: (r) => r !== "Designer", volume: "known" }));
    expect(gaps.map((g) => g.text)).toEqual(["Pitch deck has no role", "Send contract has no hands-on time"]);
  });

  it("suggests only what was said and settled, and leaves the rest as open questions", () => {
    const f = checked(pack).file;
    expect(f.company!.people.map((p) => p.name)).toEqual(["Ellie Marsh", "Kofi Mensah", "Ruby Chen", "Maddie Kerr"]);
    // The later correction wins (Tom: "Ruby starts on the ninth, not the second").
    expect(f.company!.people.find((p) => p.name === "Ruby Chen")!.start_date).toBe("2026-11-09");
    expect(f.company!.people.find((p) => p.name === "Kofi Mensah")!.leave).toEqual([{ start_date: "2026-12-07", end_date: "2026-12-24", note: "Family abroad; booked" }]);
    const client = (name: string) => f.company!.clients.find((c) => c.name === name)!;
    expect(client("Brambleway Farm Shop").active).toBe(false);
    expect(client("Harlow and Pike Opticians").assignments).toEqual({ "Account director": "Tom Whitfield" });
    const lead = (name: string) => f.company!.demand!.lead_sources.find((l) => l.name === name)!;
    expect(f.company!.demand!.lead_sources.map((l) => l.name)).toEqual(["Website enquiries", "LinkedIn"]);
    expect(lead("Website enquiries").volume_per_week).toBe(9);
    expect(lead("LinkedIn").volume_per_week).toBeUndefined();
    expect(lead("LinkedIn").evidence!.map((c) => c.value)).toEqual([2, 1]);
    expect(f.company!.roles.map((r) => r.name)).toEqual(["Designer"]);
    expect(f.company!.demand!.seasonality).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5]);
    expect(f.company!.clients.map((c) => c.name)).toEqual(["Ashgrove Garden Centre", "Harlow and Pike Opticians", "Brambleway Farm Shop"]);
    expect(f.proposals!.map((p) => p.title)).toEqual([
      "Proposals wait about a week on Grace's desk",
      "Proposals need a second version because the budget comes up late",
      "The pitch deck is briefed the day before it is due",
      "Chasing clients to sign takes a lot of Tom's time",
    ]);
    // First principles hold only the two rules a speaker stated.
    expect(f.first_principles!.requirements).toHaveLength(2);
    expect(f.first_principles!.job).toBeUndefined();
    expect(f.first_principles!.measures).toEqual([]);
  });
});
