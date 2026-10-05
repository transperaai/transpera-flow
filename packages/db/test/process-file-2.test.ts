import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { FP_COMPARATORS, FP_KINDS, FP_VERDICTS, ISSUE_TYPES, RATINGS, SUCCESS_KPIS } from "@transpera-flow/engine";
import { describe, expect, it } from "vitest";
import { checkProcessFile, checkProcessFileText, PROCESS_FILE_EXAMPLE } from "../src/process-file";
import * as v2 from "../src/process-file-2";
import { claudePrompt2, PROCESS_FILE_EXAMPLE_2, PROCESS_FILE_SCHEMA_2 } from "../src/process-file-2-schema";

// The transpera-process/2 checker (issue #167, B14): what it accepts, the plain-word message for each way a file can be wrong,
// and that /1 files are read exactly as before. Pure; no database.

const clone = (v: unknown) => JSON.parse(JSON.stringify(v));
const example = () => clone(PROCESS_FILE_EXAMPLE_2);
const published = (name: string) => readFileSync(new URL(`../../../docs/import/${name}`, import.meta.url), "utf8");

/** A small valid /2 process with one source, to break one way at a time. */
function base() {
  return clone({
    format: "transpera-process/2",
    name: "Small",
    sources: [{ id: "talk", title: "Talk with Sam", kind: "transcript", date: "2026-09-30", speakers: ["Sam"] }],
    steps: [
      { id: "a", name: "Begin", type: "start" },
      { id: "b", name: "Work", type: "step", role: "Doer", hands_on_hours: 1 },
      { id: "c", name: "Finish", type: "end" },
    ],
    links: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  });
}

const errorsOf = (f: unknown) => checkProcessFile(f).errors;
const warningsOf = (f: unknown) => checkProcessFile(f).warnings;
const cite = (extra: Record<string, unknown> = {}) => ({ source: "talk", speaker: "Sam", time: "00:01:00", quote: "It takes an hour.", value: 1, ...extra });

describe("the published schema and example", () => {
  it("the example validates against the schema file and passes the checker with nothing to say", () => {
    const validate = new Ajv2020({ strict: false }).compile(JSON.parse(published("transpera-process-2.schema.json")));
    const file = JSON.parse(published("transpera-process-2.example.json"));
    expect(validate(file), JSON.stringify(validate.errors)).toBe(true);
    const checked = checkProcessFile(file);
    expect(checked.errors).toEqual([]);
    expect(checked.warnings).toEqual([]);
    expect(checked.conflicts).toEqual([]);
  });

  it("the example has every section and the checker keeps each of them", () => {
    const f = checkProcessFile(example()).file!;
    expect(f.format).toBe("transpera-process/2");
    expect(f.sources).toHaveLength(3);
    expect(f.company).toMatchObject({ people: [{ name: "Maya Chen" }], roles: [{ name: "Account manager" }], services: [{ name: "Monthly retainer" }], demand: { lead_sources: [{ name: "Website form" }] } });
    expect(f.proposals).toHaveLength(1);
    expect(f.first_principles).toMatchObject({ job: { who: expect.any(String) }, requirements: [{ owner: "Maya Chen", step: "review" }], measures: [{ kpi: "winRate" }] });
    const proposal = f.steps.find((s) => s.id === "proposal")!;
    expect(proposal.evidence?.hands_on_hours?.[0]).toMatchObject({ source: "interview-maya", speaker: "Maya Chen", time: "00:06:40", value: 3 });
    expect(f.links.find((l) => l.to === "call")?.evidence?.[0]?.value).toBe(0.67);
    expect(f.links.find((l) => l.to === "signed")?.assumed).toMatch(/win rate/);
  });

  it("the schema rejects a /1 file and a file with the wrong format", () => {
    const validate = new Ajv2020({ strict: false }).compile(JSON.parse(published("transpera-process-2.schema.json")));
    expect(validate(clone(PROCESS_FILE_EXAMPLE))).toBe(false);
    expect(validate({ ...example(), format: "transpera-process/3" })).toBe(false);
    const noSourceId = example();
    delete noSourceId.sources[0].id;
    expect(validate(noSourceId)).toBe(false);
  });

  it("the docs copies are the ones generated from the source (pnpm --filter @transpera-flow/db gen:import-schema)", () => {
    expect(JSON.parse(published("transpera-process-2.schema.json"))).toEqual(PROCESS_FILE_SCHEMA_2);
    expect(JSON.parse(published("transpera-process-2.example.json"))).toEqual(PROCESS_FILE_EXAMPLE_2);
  });

  it("the prompt for Claude carries the schema, the example and the evidence rules", () => {
    const prompt = claudePrompt2();
    expect(prompt).toContain("transpera-process/2");
    expect(prompt).toContain(JSON.stringify(PROCESS_FILE_SCHEMA_2, null, 2));
    expect(prompt).toContain(JSON.stringify(PROCESS_FILE_EXAMPLE_2, null, 2));
    expect(prompt).toMatch(/word for word/);
    expect(prompt).toMatch(/assumed/);
    expect(prompt).toMatch(/Never invent/);
    expect(prompt).toMatch(/at most five/);
    expect(prompt).toMatch(/proposals/);
  });

  it("the lists written out here match the engine's", () => {
    expect([...v2.RATINGS]).toEqual([...RATINGS]);
    expect([...v2.ISSUE_TYPES]).toEqual([...ISSUE_TYPES]);
    expect([...v2.FP_KINDS]).toEqual([...FP_KINDS]);
    expect([...v2.FP_VERDICTS]).toEqual([...FP_VERDICTS]);
    expect([...v2.FP_COMPARATORS]).toEqual([...FP_COMPARATORS]);
    expect([...v2.SUCCESS_KPI_KEYS]).toEqual(Object.keys(SUCCESS_KPIS));
  });
});

describe("/1 files are read as before", () => {
  it("a /1 file comes back as /1 with none of /2's parts", () => {
    const checked = checkProcessFile(clone(PROCESS_FILE_EXAMPLE));
    expect(checked.errors).toEqual([]);
    expect(checked.warnings).toEqual([]);
    expect(checked.conflicts).toBeUndefined();
    expect(Object.keys(checked.file!).sort()).toEqual(["description", "format", "groups", "kind", "links", "name", "steps"]);
    expect(checked.file!.format).toBe("transpera-process/1");
  });

  it("/2 fields in a /1 file are ignored with a warning, as any unknown field is", () => {
    const f = clone(PROCESS_FILE_EXAMPLE);
    f.format = "transpera-process/1";
    f.sources = [{ id: "x", title: "X" }];
    f.steps[1].evidence = {};
    const checked = checkProcessFile(f);
    expect(checked.errors).toEqual([]);
    expect(checked.warnings).toEqual([
      "The file has a field 'sources' that Transpera doesn't use. It was ignored.",
      "Step 'Review enquiry' has a field 'evidence' that Transpera doesn't use. It was ignored.",
    ]);
    expect(checked.file!.sources).toBeUndefined();
  });

  it("a /2 file with only /1's fields is valid and has empty sections", () => {
    const f = clone(PROCESS_FILE_EXAMPLE);
    f.format = "transpera-process/2";
    const checked = checkProcessFile(f);
    expect(checked.errors).toEqual([]);
    expect(checked.warnings).toEqual([]);
    expect(checked.file).toMatchObject({ format: "transpera-process/2", sources: [], proposals: [] });
  });

  it("says plainly that a newer format isn't read", () => {
    expect(checkProcessFile({ ...base(), format: "transpera-process/3" }).errors[0]).toMatch(/reads 'transpera-process\/1' and 'transpera-process\/2'. Ask Claude to redo it in 'transpera-process\/2'/);
  });
});

describe("sources", () => {
  it("reads kind, date, speakers and body, defaulting the kind to transcript", () => {
    const f = base();
    f.sources = [{ id: "s1", title: "Notes", body: "hello", speakers: ["A"] }];
    expect(checkProcessFile(f).file!.sources).toEqual([{ id: "s1", title: "Notes", kind: "transcript", speakers: ["A"], body: "hello" }]);
  });

  it("names each way a source can be wrong", () => {
    const cases: [(f: ReturnType<typeof base>) => void, RegExp][] = [
      [(f) => (f.sources = "nope"), /"sources" should be a list/],
      [(f) => (f.sources = [1]), /Source 1 should be an object with an id and a title/],
      [(f) => delete f.sources[0].id, /Source 'Talk with Sam' has no id\. Give each source a short id/],
      [(f) => delete f.sources[0].title, /Source 'talk' has no title/],
      [(f) => (f.sources[0].kind = "video"), /the kind 'video', which Transpera doesn't know\. Use transcript, notes, data or screenshot/],
      [(f) => (f.sources[0].date = "30 Sep"), /the date should be a day like 2026-09-30/],
      [(f) => (f.sources[0].date = "2026-02-31"), /the date should be a day like 2026-09-30/],
      [(f) => (f.sources[0].speakers = "Sam"), /speakers should be a list of names/],
      [(f) => f.sources.push({ id: "talk", title: "Other" }), /Two sources have the id 'talk'/],
    ];
    for (const [change, message] of cases) {
      const f = base();
      change(f);
      expect(errorsOf(f).join("\n"), String(message)).toMatch(message);
    }
  });

  it("refuses more than 50", () => {
    const f = base();
    f.sources = Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, title: `S ${i}` }));
    expect(errorsOf(f)[0]).toBe("The file has 51 sources; the most Transpera takes in one upload is 50.");
  });
});

describe("evidence on a step's numbers", () => {
  it("keeps quote, source, speaker, time and value, and resolves a source named by its title", () => {
    const f = base();
    f.steps[1].evidence = { hands_on_hours: [cite({ source: "Talk with Sam" })] };
    expect(checkProcessFile(f).file!.steps[1]!.evidence).toEqual({ hands_on_hours: [{ source: "talk", speaker: "Sam", time: "00:01:00", quote: "It takes an hour.", value: 1 }] });
  });

  it("keeps an assumed reason by field", () => {
    const f = base();
    f.steps[1].assumed = { wait_hours: "Nobody said." };
    expect(checkProcessFile(f).file!.steps[1]!.assumed).toEqual({ wait_hours: "Nobody said." });
  });

  it("says what is wrong with a quote, plainly", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [cite({ source: "talks" }), /Step 'Work', hands-on time cites the source 'talks', which isn't in the file's sources\. Did you mean 'talk'\?/],
      [cite({ source: undefined }), /a quote needs a "source" \(the id of one of the file's sources\)/],
      [cite({ quote: "" }), /a quote needs the words said, word for word/],
      [cite({ quote: "x".repeat(2001) }), /the quote is 2001 characters long; the most is 2000\. Quote just the sentence/],
      [cite({ value: -1 }), /the number stated is -1, but it has to be between 0 and/],
      [cite({ speaker: 7 }), /speaker should be text/],
      [cite({ colour: "red" }), /has a field 'colour' that Transpera doesn't use/],
    ];
    for (const [c, message] of cases) {
      const f = base();
      f.steps[1].evidence = { hands_on_hours: [c] };
      const out = checkProcessFile(f);
      expect([...out.errors, ...out.warnings].join("\n"), String(message)).toMatch(message);
    }
  });

  it("says when the file has no sources at all", () => {
    const f = base();
    delete f.sources;
    f.steps[1].evidence = { hands_on_hours: [cite()] };
    expect(errorsOf(f)[0]).toMatch(/but the file has no "sources" list\. Add the source/);
  });

  it("warns, but goes ahead, for a speaker the source doesn't list", () => {
    const f = base();
    f.steps[1].evidence = { hands_on_hours: [cite({ speaker: "Pat" })] };
    const out = checkProcessFile(f);
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual(["Step 'Work', hands-on time: 'Pat' isn't listed as a speaker of 'Talk with Sam' (Sam)."]);
  });

  it("warns when the quote isn't in the source's text word for word, and not when it is (punctuation and line breaks aside)", () => {
    const f = base();
    f.sources[0].body = "Sam: It takes\nan hour, roughly.";
    f.steps[1].evidence = { hands_on_hours: [cite({ quote: "It takes an hour" })] };
    expect(warningsOf(f)).toEqual([]);
    f.steps[1].evidence = { hands_on_hours: [cite({ quote: "It takes two hours" })] };
    expect(warningsOf(f)).toEqual(["Step 'Work', hands-on time: the quote isn't in the text of 'Talk with Sam' word for word. Check it against the source."]);
  });

  it("warns for evidence with no number to use, and for evidence on a value that takes none", () => {
    const f = base();
    delete f.steps[1].hands_on_hours;
    f.steps[1].evidence = { hands_on_hours: [cite({ value: undefined })], mood: [cite()] };
    expect(warningsOf(f)).toEqual([
      "Step 'Work': there are quotes for hands-on time but no number, here or in the quotes. Give the number (or each quote's \"value\") so it can be used.",
      "Step 'Work' has evidence for 'mood', which Transpera doesn't take evidence for (it takes hands_on_hours, wait_hours, rework_rate, waiting_now, sla_hours). It was ignored.",
    ]);
  });

  it("is happy with a number that only the quote states", () => {
    const f = base();
    delete f.steps[1].hands_on_hours;
    f.steps[1].evidence = { hands_on_hours: [cite()] };
    expect(checkProcessFile(f).warnings).toEqual([]);
  });

  it("limits a rework_rate quote's value to 0..1", () => {
    const f = base();
    f.steps[1].evidence = { rework_rate: [cite({ value: 10 })] };
    expect(errorsOf(f).join()).toMatch(/rework rate.*the number stated is 10, but it has to be between 0 and 1/);
  });

  it("reports sources that disagree as a conflict, not an error, with who said what", () => {
    const f = base();
    f.sources.push({ id: "sop", title: "Sales SOP", kind: "notes", speakers: [] });
    f.steps[1].evidence = { hands_on_hours: [cite({ value: 1 }), cite({ source: "sop", speaker: undefined, value: 4, quote: "Allow four hours." })] };
    const out = checkProcessFile(f);
    expect(out.errors).toEqual([]);
    expect(out.conflicts).toEqual(["Step 'Work': the sources disagree on hands-on time (Talk with Sam (Sam): 1; Sales SOP: 4). Both are kept and flagged on the draft for you to settle."]);
  });

  it("agreeing sources are no conflict", () => {
    const f = base();
    f.steps[1].evidence = { hands_on_hours: [cite(), cite({ time: "00:09:00" })] };
    expect(checkProcessFile(f).conflicts).toEqual([]);
  });

  it("reports a link's different odds as a conflict", () => {
    const f = base();
    f.links[1].evidence = [cite({ value: 1 }), cite({ value: 0.8 })];
    expect(checkProcessFile(f).conflicts?.[0]).toMatch(/The link from 'Work' to 'Finish': the sources give different odds \(Talk with Sam \(Sam\): 100%; Talk with Sam \(Sam\): 80%\)/);
  });

  it("odds given only as a quoted value are the link's probability, so the preview, the gap check and the import agree", () => {
    const f = base();
    f.links[1].evidence = [cite({ value: 0.6 })];
    expect(checkProcessFile(f).file!.links[1]!.probability).toBe(0.6);
    // Quotes that disagree: the middle value is used and the disagreement is a conflict to settle.
    const g = base();
    g.links[1].evidence = [cite({ value: 0.2 }), cite({ value: 0.9 }), cite({ value: 0.4 })];
    const out = checkProcessFile(g);
    expect(out.file!.links[1]!.probability).toBe(0.4);
    expect(out.conflicts?.[0]).toMatch(/the sources give different odds.*The middle one is used; check them\./);
    // A stated probability always wins over the quotes.
    const h = base();
    h.links[1].probability = 0.5;
    h.links[1].evidence = [cite({ value: 0.9 })];
    expect(checkProcessFile(h).file!.links[1]!.probability).toBe(0.5);
  });

  it("wants evidence as an object and assumed reasons as text", () => {
    const f = base();
    f.steps[1].evidence = [cite()];
    f.steps[1].assumed = { wait_hours: "" };
    expect(errorsOf(f)).toEqual([
      `Step 'Work': "evidence" should be an object with a list of quotes for each value, like {"hands_on_hours": [{"source": ..., "quote": ...}]}.`,
      `Step 'Work', wait: "assumed" should be a sentence saying why the value is an assumption.`,
    ]);
  });
});

describe("what /2 adds to a step", () => {
  it("keeps ranges, rework_to, tool, SLA and items waiting now", () => {
    const f = base();
    f.steps[1] = { ...f.steps[1], hands_on_range: { min: 0.5, max: 2 }, wait_hours: 4, wait_range: { min: 1, max: 8 }, rework_rate: 0.2, rework_to: "b", tool: "HubSpot", sla_hours: 24, waiting_now: 3 };
    f.steps.splice(2, 0, { id: "r", name: "Rework here", type: "step", role: "Doer", hands_on_hours: 1 });
    f.links = [
      { from: "a", to: "b" },
      { from: "b", to: "r" },
      { from: "r", to: "c" },
    ];
    f.steps[1].rework_to = "r";
    const step = checkProcessFile(f).file!.steps[1]!;
    expect(step).toMatchObject({ hands_on_range: { min: 0.5, max: 2 }, wait_range: { min: 1, max: 8 }, rework_to: "r", tool: "HubSpot", sla_hours: 24, waiting_now: 3 });
  });

  it("names each way they can be wrong", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ hands_on_range: { min: 3, max: 1 } }, /hands_on_range is 3 to 1, but it has to run from the lowest to the highest/],
      [{ hands_on_range: { min: 2, max: 3 } }, /hands_on_range is 2 to 3, but the typical value 1 is outside it/],
      [{ hands_on_range: [1, 2] }, /hands_on_range should be \{"min": number, "max": number\}/],
      [{ rework_to: "zzz" }, /Step 'Work' sends rework back to 'zzz', which isn't a step\./],
      [{ rework_to: 4 }, /rework_to should be the id of the step rework goes back to/],
      [{ waiting_now: 1.5 }, /waiting_now should be a whole number of items/],
      [{ sla_hours: -1 }, /sla_hours is -1, but it has to be between 0 and 10000/],
      [{ tool: 5 }, /tool should be text/],
    ];
    for (const [change, message] of cases) {
      const f = base();
      Object.assign(f.steps[1], change);
      expect(errorsOf(f).join("\n"), String(message)).toMatch(message);
    }
  });

  it("suggests the step a mistyped rework_to meant", () => {
    const f = base();
    f.steps[1].rework_to = "bb";
    expect(errorsOf(f)[0]).toBe("Step 'Work' sends rework back to 'bb', which isn't a step. Did you mean 'b'?");
  });

  it("warns that rework with no rate sends nothing back", () => {
    const f = base();
    f.steps.splice(2, 0, { id: "r", name: "Earlier", type: "step", role: "Doer", hands_on_hours: 1 });
    f.links = [
      { from: "a", to: "r" },
      { from: "r", to: "b" },
      { from: "b", to: "c" },
    ];
    f.steps[1].rework_to = "r";
    expect(warningsOf(f)).toContain("Step 'Work' sends rework back to 'Earlier' but has no rework_rate, so nothing is sent back yet.");
  });
});

describe("company", () => {
  const company = () => ({
    people: [{ name: "Sam Rivera", roles: ["Doer"], fte: 0.8, hours_per_week: 30, cost_rate: 40, email: "sam@example.com", start_date: "2024-01-01", evidence: [cite()] }],
    roles: [{ name: "Doer", assumed: "Named in the SOP." }],
    clients: [{ name: "Acme", services: ["Retainer"], mrr: 1500, start_date: "2025-03-01", health: 70, notes: "Likes calls.", evidence: [cite()] }],
    services: [{ name: "Retainer", pricing_model: "retainer", price: 1500, margin: 0.4, tenure_months: 14, monthly_churn: 0.02, mix_share: 3, evidence: [cite()] }],
    demand: { lead_sources: [{ name: "Website", volume_per_week: 8, conversion_to_qualified: 0.5, evidence: [cite()] }], growth_monthly: 0.02, seasonality: [1, 1, 1, 1, 1, 1, 0.8, 0.8, 1, 1, 1, 1], assumed: "Guess." },
  });

  it("keeps people, roles, clients, services and demand, each with its evidence", () => {
    const f = base();
    f.company = company();
    const out = checkProcessFile(f);
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.file!.company!.people[0]).toMatchObject({ name: "Sam Rivera", roles: ["Doer"], fte: 0.8, hours_per_week: 30, cost_rate: 40, evidence: [{ source: "talk" }] });
    expect(out.file!.company!.roles[0]).toEqual({ name: "Doer", evidence: [], assumed: "Named in the SOP." });
    expect(out.file!.company!.services[0]).toMatchObject({ pricing_model: "retainer", monthly_churn: 0.02 });
    expect(out.file!.company!.demand).toMatchObject({ growth_monthly: 0.02, assumed: "Guess.", lead_sources: [{ name: "Website", volume_per_week: 8 }] });
  });

  it("warns for a company item with neither evidence nor an assumed reason", () => {
    const f = base();
    f.company = { roles: [{ name: "Doer" }], people: [{ name: "Sam" }] };
    expect(warningsOf(f)).toEqual([
      "company.people 'Sam' has neither evidence nor an assumed reason, so whoever reviews it won't see where it came from.",
      "company.roles 'Doer' has neither evidence nor an assumed reason, so whoever reviews it won't see where it came from.",
    ]);
  });

  it("names each way it can be wrong", () => {
    const cases: [(c: ReturnType<typeof company>) => void, RegExp][] = [
      [(c) => ((c as unknown as { people: unknown }).people = {}), /company\.people should be a list/],
      [(c) => delete (c.people[0] as { name?: string }).name, /company\.people item 1 has no name/],
      [(c) => ((c.people[0] as { fte: unknown }).fte = 5), /company\.people 'Sam Rivera': fte is 5, but it has to be between 0\.01 and 1\.5 \(1 is full time\)/],
      [(c) => ((c.clients[0] as { health: unknown }).health = 101), /company\.clients 'Acme': health is 101/],
      [(c) => ((c.clients[0] as { start_date: unknown }).start_date = "March"), /start_date should be a day like 2026-09-30/],
      [(c) => ((c.services[0] as { pricing_model: unknown }).pricing_model = "free"), /pricing_model should be retainer, one_off or hourly/],
      [(c) => ((c.services[0] as { margin: unknown }).margin = 40), /margin is 40, but it has to be between 0 and 1/],
      [(c) => ((c.demand as { seasonality: unknown }).seasonality = [1, 2]), /seasonality should be twelve multipliers/],
      [(c) => ((c.demand.lead_sources[0] as { conversion_to_qualified: unknown }).conversion_to_qualified = 2), /conversion_to_qualified is 2/],
      [(c) => ((c as unknown as { demand: unknown }).demand = []), /company\.demand should be an object/],
    ];
    for (const [change, message] of cases) {
      const f = base();
      const c = company();
      change(c);
      f.company = c;
      expect(errorsOf(f).join("\n"), String(message)).toMatch(message);
    }
  });

  it("says when evidence in the company section cites an unknown source", () => {
    const f = base();
    const c = company();
    c.people[0]!.evidence = [cite({ source: "nobody" })];
    f.company = c;
    expect(errorsOf(f)[0]).toMatch(/company\.people 'Sam Rivera' cites the source 'nobody', which isn't in the file's sources/);
  });

  it("refuses a company section that would make more than 300 suggestions", () => {
    const f = base();
    f.company = { roles: Array.from({ length: 100 }, (_, i) => ({ name: `R${i}`, assumed: "x" })), people: Array.from({ length: 100 }, (_, i) => ({ name: `P${i}`, assumed: "x" })), clients: Array.from({ length: 100 }, (_, i) => ({ name: `C${i}`, assumed: "x" })), services: [{ name: "S", assumed: "x" }] };
    expect(errorsOf(f)).toContain("The company section would make 301 suggestions; the most in one file is 300.");
  });

  it("ignores unknown fields with a warning", () => {
    const f = base();
    f.company = { vibes: [], people: [{ name: "Sam", shoe_size: 9, assumed: "x" }] };
    expect(warningsOf(f)).toEqual([
      "The company section has a field 'vibes' that Transpera doesn't use. It was ignored.",
      "company.people 'Sam' has a field 'shoe_size' that Transpera doesn't use. It was ignored.",
    ]);
  });
});

describe("proposals", () => {
  it("keeps a proposed issue with its steps, rating and evidence", () => {
    const f = base();
    f.proposals = [{ type: "issue", title: "Work is slow", detail: "Said so.", rating: "bad", issue_type: "delay", steps: ["b"], target_measure: "Wait", target_now: "4 h", target_goal: "1 h", evidence: [cite()] }];
    const out = checkProcessFile(f);
    expect(out.errors).toEqual([]);
    expect(out.file!.proposals![0]).toMatchObject({ type: "issue", rating: "bad", issue_type: "delay", steps: ["b"], target_goal: "1 h", evidence: [{ source: "talk" }] });
  });

  it("keeps a solution idea with the issue it is for and its steps", () => {
    const f = base();
    f.proposals = [{ type: "solution_idea", title: "Automate it", for_issue: 12, proposed_steps: [{ name: "Bot", kind: "task", role: "Doer" }, { name: "Check" }], expect: "Faster.", assumed: "A guess." }];
    const out = checkProcessFile(f);
    expect(out.errors).toEqual([]);
    expect(out.file!.proposals![0]).toMatchObject({ type: "solution_idea", for_issue: "12", proposed_steps: [{ name: "Bot", kind: "task", role: "Doer" }, { name: "Check" }], expect: "Faster." });
  });

  it("names each way a proposal can be wrong", () => {
    const issue = { type: "issue", title: "Slow", assumed: "x" };
    const idea = { type: "solution_idea", title: "Fast", for_issue: "#3", proposed_steps: [{ name: "Bot" }], assumed: "x" };
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ type: "idea", title: "x" }, /has the type 'idea'\. Use "issue" \(a problem worth tracking\) or "solution_idea"/],
      [{ ...issue, title: "" }, /Proposal 1 has no title/],
      [{ ...issue, rating: "dire" }, /rating should be great, good, bad or risk/],
      [{ ...issue, issue_type: "mood" }, /issue_type should be one of bottleneck/],
      [{ ...issue, steps: ["zzz"] }, /Proposal 'Slow' lists 'zzz' in steps, which isn't a step\./],
      [{ ...idea, for_issue: undefined }, /it needs "for_issue": the number \(like 12\) or title of an issue you already track/],
      [{ ...idea, proposed_steps: [] }, /it needs "proposed_steps": the steps it would put in place, in order/],
      [{ ...idea, proposed_steps: [{ kind: "task" }] }, /proposed step 1 needs a name/],
    ];
    for (const [p, message] of cases) {
      const f = base();
      f.proposals = [p];
      expect(errorsOf(f).join("\n"), String(message)).toMatch(message);
    }
  });

  it("warns about fields that belong to the other type", () => {
    const f = base();
    f.proposals = [{ type: "issue", title: "Slow", for_issue: "3", assumed: "x" }];
    expect(warningsOf(f)).toEqual(["Proposal 'Slow' is an issue, so its 'for_issue' was ignored."]);
  });
});

describe("first principles", () => {
  const fp = () => ({
    job: { who: "A founder", done: "Signed", evidence: [cite()] },
    truths: [{ text: "Leads go cold after a week", kind: "truth", evidence: [cite()] }, { text: "Clients prefer calls", kind: "assumption", test: "Ask five clients", assumed: "A hunch." }],
    requirements: [{ text: "Reply the same day", owner: "Sam", why: "Trust", verdict: "keep", step: "b", evidence: [cite()] }],
    measures: [{ text: "Win rate", kpi: "winRate", comparator: "atLeast", target: 30, horizon: "6 months", assumed: "A goal." }],
    why: { problem: "Slow", chain: ["Busy", "No time"], root: "No process", evidence: [cite()] },
  });

  it("keeps every part", () => {
    const f = base();
    f.first_principles = fp();
    const out = checkProcessFile(f);
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.file!.first_principles).toMatchObject({
      job: { who: "A founder", done: "Signed" },
      truths: [{ kind: "truth" }, { kind: "assumption", test: "Ask five clients", assumed: "A hunch." }],
      requirements: [{ owner: "Sam", step: "b", verdict: "keep" }],
      measures: [{ kpi: "winRate", target: 30 }],
      why: { chain: ["Busy", "No time"], root: "No process" },
    });
  });

  it("names each way it can be wrong", () => {
    const cases: [(f: ReturnType<typeof fp>) => void, RegExp][] = [
      [(f) => ((f.requirements[0] as { step: unknown }).step = "zzz"), /names 'zzz' as its step, which isn't a step\./],
      [(f) => ((f.requirements[0] as { verdict: unknown }).verdict = "maybe"), /verdict should be keep, change, drop or challenge/],
      [(f) => ((f.truths[0] as { kind: unknown }).kind = "myth"), /kind should be truth or assumption/],
      [(f) => ((f.measures[0] as { kpi: unknown }).kpi = "happiness"), /kpi should be one of won, winsPerWeek/],
      [(f) => ((f.measures[0] as { comparator: unknown }).comparator = "equals"), /comparator should be atLeast or atMost/],
      [(f) => delete (f.truths[0] as { text?: string }).text, /first_principles\.truths item 1 has no text/],
      [(f) => ((f as unknown as { job: unknown }).job = "x"), /first_principles\.job should be an object/],
      [(f) => ((f as unknown as { truths: unknown }).truths = {}), /first_principles\.truths should be a list/],
    ];
    for (const [change, message] of cases) {
      const f = base();
      const p = fp();
      change(p);
      f.first_principles = p;
      expect(errorsOf(f).join("\n"), String(message)).toMatch(message);
    }
  });

  it("warns for items with neither evidence nor an assumed reason, so nothing is filled in without a say-so", () => {
    const f = base();
    f.first_principles = { truths: [{ text: "Leads go cold" }], job: { who: "A founder" } };
    expect(warningsOf(f)).toEqual([
      "first_principles.job has neither evidence nor an assumed reason, so whoever reviews it won't see where it came from.",
      "first_principles.truths item 1 'Leads go cold' has neither evidence nor an assumed reason, so whoever reviews it won't see where it came from.",
    ]);
  });
});

describe("text and structure", () => {
  it("a /2 file from text is checked the same way", () => {
    const out = checkProcessFileText(JSON.stringify(example()));
    expect(out.errors).toEqual([]);
    expect(out.file!.sources).toHaveLength(3);
  });

  it("sectionCounts counts what each section will make", () => {
    const file = checkProcessFile(example()).file!;
    expect(v2.sectionCounts(file)).toEqual({ sources: 3, company: 4, proposals: 1, firstPrinciples: 3 });
  });
});
