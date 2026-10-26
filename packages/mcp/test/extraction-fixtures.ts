// The Tidewater dry run for the extraction skill (issue #27,
// .agents/skills/extract-process/SKILL.md): two invented interview
// transcripts, and the ordered tool calls a run of the skill makes on each
// (run-1.json, run-2.json). The tests replay them (db-extraction.test.ts)
// and lint them against the transcripts (extraction-fixtures.test.ts).

import { readFileSync } from "node:fs";
import { EVIDENCE_COLUMNS } from "@transpera-flow/db";
import { TOOL_NAMES } from "../src/tools";

const DIR = new URL("../../../docs/extraction/examples/tidewater/", import.meta.url);

export interface RecordedCall {
  tool: string;
  arguments: Record<string, unknown>;
  /** Keep the new source's id under this name; later arguments refer to it as `$<name>`. */
  save?: string;
}

export interface Run {
  calls: RecordedCall[];
}

export const readFixture = (name: string): string => readFileSync(new URL(name, DIR), "utf8");
export const readRun = (name: string): Run => JSON.parse(readFixture(name)) as Run;

/** `$file:<name>` becomes that fixture's text; `$<key>` becomes a saved id (left as it is when none is given). */
export function substitute<T>(value: T, saved: Record<string, string> = {}): T {
  if (typeof value === "string") {
    if (value.startsWith("$file:")) return readFixture(value.slice("$file:".length)) as T;
    if (value.startsWith("$") && value.slice(1) in saved) return saved[value.slice(1)] as T;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, saved)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, saved)])) as T;
  return value;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

const SUGGESTION_TOOLS = ["set_company", "upsert_service", "upsert_person", "upsert_client", "set_demand", "propose_issue", "propose_solution_idea"];
/** Tools the skill never calls: a person publishes, discards and logs issues. */
const NEVER = ["publish_process", "discard_draft", "log_issue"];
const DEFAULTS = /^(Server default|Given without a cited source)/;

interface Transcript {
  speakers: string[];
  body: string;
  title?: string;
}

/** What a group or a step holding a child process may not carry: its steps hold the numbers. */
const OWN_FIELDS = ["role", "person", "work_hours", "work_dist", "work_params", "wait_hours", "wait_dist", "wait_params", "rework_rate", "rework_to", "sla_hours", "current_wip", "evidence", "assumptions"];
/** A quote cited inside first-principles text: "<quote>" [<source title> | <speaker> | <hh:mm:ss>]. */
const FP_CITATION = /"([^"]+)" \[([^\]|]+) \| ([^\]|]+) \| (\d{2}:\d{2}:\d{2})\]/g;

/** Every string inside a value, however deeply nested. */
function allStrings(v: unknown): string[] {
  return typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(allStrings) : isObj(v) ? Object.values(v).flatMap(allStrings) : [];
}
const SUGGESTED_BY_FP = ["job", "statements", "requirements", "deletes", "improvements", "why", "measures"];

/** Every step of a process_json, groups and child processes included. */
function allSteps(steps: Obj[]): Obj[] {
  return steps.flatMap((s) => [s, ...allSteps(arr(s.steps)), ...(isObj(s.process) ? allSteps(arr(s.process.steps)) : [])]);
}

/**
 * Everything that must hold for a recorded run, as a list of problems (empty
 * when it is sound): tool names exist; every citation quotes its transcript
 * verbatim, from a listed speaker, at a timestamp that is on that line; every
 * number is cited or reasoned; a symmetric range cites its midpoint; every
 * suggestion carries evidence in the suggestion shape.
 */
export function lintRun(run: Run): string[] {
  const problems: string[] = [];
  const sources = new Map<string, Transcript>();
  let imports = 0;
  let adds = 0;
  const lateSources = new Map<string, number>();

  const transcriptOf = (ref: unknown, where: string): Transcript | null => {
    const t = typeof ref === "string" ? sources.get(ref.replace(/^\$/, "")) : undefined;
    if (!t) problems.push(`${where}: the source ${JSON.stringify(ref)} was not added earlier in the run`);
    return t ?? null;
  };

  const checkQuote = (t: Transcript, c: Obj, where: string) => {
    const quote = String(c.quote ?? "");
    if (!quote.trim()) return problems.push(`${where}: empty quote`);
    if (!t.body.includes(quote)) return problems.push(`${where}: the quote is not in the transcript verbatim: ${JSON.stringify(quote)}`);
    const speaker = c.speaker;
    if (speaker !== undefined && (typeof speaker !== "string" || !t.speakers.includes(speaker))) problems.push(`${where}: speaker ${JSON.stringify(speaker)} is not one of the source's speakers`);
    if (typeof c.timestamp !== "string" || !t.body.includes(`[${c.timestamp}]`)) return problems.push(`${where}: timestamp ${JSON.stringify(c.timestamp)} is not in the transcript`);
    const line = t.body.split("\n").find((l) => l.startsWith(`[${c.timestamp}]`)) ?? "";
    if (!line.includes(quote)) problems.push(`${where}: the quote is not on the line at [${c.timestamp}]`);
    if (typeof speaker === "string" && !line.startsWith(`[${c.timestamp}] ${speaker}:`)) problems.push(`${where}: the line at [${c.timestamp}] is not spoken by ${speaker}`);
  };

  const lintSteps = (steps: Obj[], top: Obj[], isNew: boolean, t: Transcript | null) => {
    for (const s of steps) {
      const name = String(s.name);
      const where = `step '${name}'`;
      const kind = (s.kind as string | undefined) ?? "task";
      // A group, or a step holding a child process, does no work itself: the steps inside carry every number.
      if (Array.isArray(s.steps) || s.process !== undefined || s.child_process !== undefined || kind === "group" || kind === "subprocess") {
        if (Array.isArray(s.steps) && (s.process !== undefined || s.child_process !== undefined)) problems.push(`${where}: holds both steps and a child process`);
        const own = OWN_FIELDS.filter((f) => s[f] !== undefined);
        if (own.length) problems.push(`${where}: a group or sub-process step has no ${own.join(", ")} of its own (put them on the steps inside)`);
        if (Array.isArray(s.steps)) lintSteps(arr(s.steps), top, isNew, t);
        if (isObj(s.process)) lintSteps(arr(s.process.steps), arr(s.process.assumptions), isNew, t);
        continue;
      }
      const cites = arr(s.evidence);
      const reasoned = new Set([...arr(s.assumptions), ...top.filter((a) => a.step === s.name)].map((a) => a.field));
      for (const a of [...arr(s.assumptions), ...top]) if (!String(a.reasoning ?? "").trim() || DEFAULTS.test(String(a.reasoning))) problems.push(`${where}: an assumption has no reasoning of its own`);
      for (const c of cites) {
        if (!(EVIDENCE_COLUMNS as readonly string[]).includes(String(c.field))) problems.push(`${where}: citation field ${JSON.stringify(c.field)} cannot cite evidence`);
        if (t) checkQuote(t, c, `${where} citation`);
        if (c.value === undefined || c.value === null) problems.push(`${where}: a citation without a value cannot conflict`);
      }
      const cited = (f: string) => cites.some((c) => c.field === f);
      const params = (p: "work" | "wait") => (isObj(s[`${p}_params`]) ? (s[`${p}_params`] as Obj) : null);
      const given = (f: string) => {
        const phase = f === "work_hours" ? "work" : f === "wait_hours" ? "wait" : null;
        return s[f] !== undefined || (phase !== null && s[`${phase}_dist`] === "triangular" && params(phase) !== null);
      };
      for (const f of EVIDENCE_COLUMNS) {
        if (given(f) && !cited(f) && !reasoned.has(f)) problems.push(`${where}: ${f} is given with neither a citation nor reasoning`);
        if ((f === "current_wip" || f === "sla_hours") && given(f) && !cited(f)) problems.push(`${where}: ${f} is stated only when a source states it`);
      }
      if (isNew) {
        const need = kind === "task" ? ["work_hours", "wait_hours", "rework_rate"] : kind === "wait" ? ["wait_hours"] : [];
        for (const f of need) if (!cited(f) && !(given(f) && reasoned.has(f))) problems.push(`${where}: ${f} would fall to the server default (give the value and its reasoning)`);
      }
      for (const phase of ["work", "wait"] as const) {
        const p = params(phase);
        const c = cites.find((x) => x.field === `${phase}_hours`);
        if (s[`${phase}_dist`] === "triangular" && p && c && c.value !== undefined) {
          const mid = ((p.min as number) + (p.max as number)) / 2;
          if (p.mode !== mid || c.value !== mid) problems.push(`${where}: a triangular ${phase} range must cite its midpoint (min ${p.min}, mode ${p.mode}, max ${p.max}, value ${c.value})`);
        }
      }
      for (const key of ["work_hours", "wait_hours", "rework_rate", "sla_hours", "current_wip"]) {
        const v = s[key];
        if (typeof v === "number" && Math.round(v * 100) / 100 !== v) problems.push(`${where}: ${key} has more than 2 decimals`);
      }
    }
  };

  const lintEvidence = (list: unknown, where: string) => {
    const items = arr(list);
    if (!items.length) problems.push(`${where}: a suggestion needs evidence`);
    if (items.length > 20) problems.push(`${where}: at most 20 citations`);
    for (const e of items) {
      if ("field" in e) problems.push(`${where}: suggestion evidence has no field`);
      if ("speaker" in e && typeof e.speaker !== "string") problems.push(`${where}: speaker is left out, never null`);
      if (typeof e.timestamp === "string" && e.timestamp.length > 50) problems.push(`${where}: timestamp is at most 50 characters`);
      const t = transcriptOf(e.source_id, `${where} evidence`);
      if (t) checkQuote(t, e, `${where} evidence`);
    }
  };

  /**
   * One first-principles item (its text fields): every quote cited in it is verbatim, spoken by that speaker at that
   * time in the interview recorded on that date, and the item holds at least one quote or says `Assumed:`.
   */
  const lintFpItem = (strings: string[], where: string, item: unknown = strings) => {
    let quoted = 0;
    for (const text of strings) {
      for (const m of text.matchAll(FP_CITATION)) {
        quoted++;
        const t = [...sources.values()].find((x) => x.title === m[2]);
        if (!t) {
          problems.push(`${where}: no source is titled ${JSON.stringify(m[2])}`);
          continue;
        }
        checkQuote(t, { quote: m[1], speaker: m[3], timestamp: m[4] }, where);
      }
    }
    if (!quoted && !strings.some((x) => x.includes("Assumed:"))) problems.push(`${where}: neither a quote nor "Assumed:" reasoning`);
    // A double-quoted span that is not a citation would pass as the speaker's words without being checked.
    for (const text of allStrings(item)) if (/["“”]/.test(text.replace(FP_CITATION, ""))) problems.push(`${where}: a quote outside the citation format (${JSON.stringify(text.replace(FP_CITATION, ""))})`);
  };
  const lintFirstPrinciples = (args: Obj, where: string) => {
    const texts = (o: Obj, keys: string[]) => keys.map((k) => o[k]).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === "string" && v.trim() !== "");
    for (const key of Object.keys(args)) if (!["process", "workspace", "mode", ...SUGGESTED_BY_FP].includes(key)) problems.push(`${where}: unknown section ${key}`);
    if (isObj(args.job)) for (const [k, v] of Object.entries(args.job)) lintFpItem([String(v)], `${where} job.${k}`);
    for (const st of arr(args.statements)) {
      lintFpItem(texts(st, ["source"]), `${where} statement ${JSON.stringify(st.text)}`, st);
      if (st.kind === "truth" && ![...String(st.source ?? "").matchAll(FP_CITATION)].length) problems.push(`${where}: a truth cites the quote that is its source`);
      if (st.kind !== "truth" && !String(st.test ?? "").trim()) problems.push(`${where}: an assumption needs a test`);
    }
    for (const r of arr(args.requirements)) {
      lintFpItem(texts(r, ["why"]), `${where} requirement ${JSON.stringify(r.text)}`, r);
      if (typeof r.owner !== "string" || !r.owner.trim()) problems.push(`${where}: a requirement needs a named owner`);
    }
    for (const d of arr(args.deletes)) lintFpItem(texts(d, ["breaks_if_removed"]), `${where} delete ${JSON.stringify(d.step)}`, d);
    for (const im of arr(args.improvements)) lintFpItem(texts(im, ["text"]), `${where} improvement ${JSON.stringify(im.text)}`, im);
    if (isObj(args.why)) lintFpItem(texts(args.why, ["problem", "chain", "root"]), `${where} why`, args.why);
    for (const m of arr(args.measures)) {
      lintFpItem(texts(m, ["text"]), `${where} measure ${JSON.stringify(m.text)}`, m);
      // The target is in the KPI's unit and the comparator defaults to atLeast: a stated limit must say atMost, never rely on the default.
      if (m.target !== undefined && m.target !== null && m.comparator === undefined) problems.push(`${where} measure ${JSON.stringify(m.text)}: a target needs an explicit comparator (atLeast or atMost)`);
      if (m.target !== undefined && m.target !== null && !m.kpi) problems.push(`${where} measure ${JSON.stringify(m.text)}: a target needs a kpi to be in a unit`);
    }
  };

  for (const [i, call] of run.calls.entries()) {
    const where = `call ${i + 1} (${call.tool})`;
    const args = call.arguments;
    if (!(TOOL_NAMES as readonly string[]).includes(call.tool)) problems.push(`${where}: no such tool`);
    if (NEVER.includes(call.tool)) problems.push(`${where}: the skill never calls this`);
    if (call.tool === "add_source") {
      adds++;
      const body = substitute(args.body) as string;
      const speakers = (args.speakers as string[] | undefined) ?? [];
      // A source must be linked to something: either named now (`links`), or by the import that cites it (`link_later`).
      if (args.link_later === true && call.save) lateSources.set(call.save, i);
      if (!arr(args.links).length && args.link_later !== true) problems.push(`${where}: pass link_later: true (the import links it) or links`);
      if (call.save) sources.set(call.save, { speakers, body, title: typeof args.title === "string" ? args.title : undefined });
      else problems.push(`${where}: save the source id so later calls can cite it`);
    }
    if (call.tool === "import_process") {
      imports++;
      const pj = args.process_json;
      if (!isObj(pj)) {
        problems.push(`${where}: process_json is an object`);
        continue;
      }
      const cited = allSteps(arr(pj.steps)).flatMap((s) => arr(s.evidence).map((c) => c.source));
      const t = transcriptOf(cited[0], where);
      if (new Set(cited).size > 1) problems.push(`${where}: one import is one interview, but it cites ${new Set(cited).size} sources`);
      lintSteps(arr(pj.steps), arr(pj.assumptions), args.target === undefined, t);
      if (pj.remove_missing) problems.push(`${where}: remove_missing stays at its default`);
    }
    if (call.tool === "update_first_principles") lintFirstPrinciples(args, where);
    if (SUGGESTION_TOOLS.includes(call.tool)) {
      if (call.tool === "set_demand") {
        for (const ls of arr(args.lead_sources)) lintEvidence(ls.evidence ?? args.evidence, `${where} lead source '${ls.name}'`);
        if (!args.lead_sources) lintEvidence(args.evidence, where);
      } else lintEvidence(args.evidence, where);
      if (!String(args.note ?? "").trim() && call.tool !== "set_demand") problems.push(`${where}: a suggestion carries a note with your reading`);
    }
  }
  // A source added with link_later is linked to the process after the import that cites it.
  for (const [id, at] of lateSources) {
    const linked = run.calls.some((c, i) => i > at && c.tool === "link_source" && c.arguments.source === `$${id}`);
    if (!linked) problems.push(`source '${id}' is added with link_later but never linked with link_source after the import`);
  }
  if (imports !== adds) problems.push(`${imports} imports for ${adds} sources: one import per interview`);
  return problems;
}
