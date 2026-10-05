// The `transpera-process/1` file format (issue #166, B13): one JSON object that describes a process. A JSON file is the
// object itself; an HTML file or a link carries it in an embedded block (slice 2). This module is the format's single
// source of truth: its JSON Schema (published as docs/import/transpera-process-1.schema.json, kept in step by a test),
// the worked example, the checker that tells a person what is wrong in plain words, and the prompt that asks Claude
// for the file. No I/O and no framework, so the browser and the server both use it.
//
// Errors stop the upload (the file can't become a process as it is); warnings are shown in the preview and the upload
// goes ahead (something is odd, or was filled in for you). Every message names the step or link it is about.

export const PROCESS_FILE_FORMAT = "transpera-process/1";
/** The type of the embedded block an HTML file or page carries the object in (slice 2). */
export const PROCESS_FILE_BLOCK_TYPE = "application/vnd.transpera-process+json";

export const FILE_STEP_TYPES = ["step", "decision", "wait", "start", "end"] as const;
export type FileStepType = (typeof FILE_STEP_TYPES)[number];

export const MAX_FILE_STEPS = 200;
export const MAX_FILE_LINKS = 500;
const MAX_NAME = 120;
/** Step ids are short labels ("review"); anything longer is a mistake, and checking it for typos would cost time. */
const MAX_ID = 64;
const MAX_GROUPS = 100;
/** Typo suggestions are a courtesy: only the first few unknown references get one, so a hostile file can't make the checker slow. */
const MAX_SUGGESTIONS = 20;
/** The most problems listed; the rest are counted. */
const MAX_LISTED = 50;
const MAX_HOURS = 10_000;
const MAX_WAIT_HOURS = 100_000;
const MAX_NOTES = 4000;
const SUM_TOLERANCE = 1e-3;

export interface ProcessFileStep {
  id: string;
  name: string;
  type: FileStepType;
  role?: string;
  person?: string;
  hands_on_hours?: number;
  wait_hours?: number;
  rework_rate?: number;
  notes?: string;
  x?: number;
  y?: number;
}

export interface ProcessFileLink {
  from: string;
  to: string;
  probability?: number;
  label?: string;
}

export interface ProcessFileGroup {
  name: string;
  /** Ids of the steps in the group. */
  steps: string[];
}

/** A file that passed the checks, with its defaults filled in. */
export interface ProcessFile {
  format: typeof PROCESS_FILE_FORMAT;
  name: string;
  kind: "pipeline" | "servicing";
  description?: string;
  entity_name?: string;
  steps: ProcessFileStep[];
  links: ProcessFileLink[];
  groups: ProcessFileGroup[];
}

export interface ProcessFileCheck {
  /** Set when there are no errors. */
  file: ProcessFile | null;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// The schema and the worked example
// ---------------------------------------------------------------------------

/** The JSON Schema of the format (draft 2020-12). Unknown fields are allowed here: the checker warns about them. */
export const PROCESS_FILE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Transpera process file (transpera-process/1)",
  description:
    "A process for Transpera Flow: its steps and how they connect. Only the fields marked required have to be there; anything left out is filled in and marked to confirm on the canvas.",
  type: "object",
  required: ["format", "name", "steps"],
  properties: {
    format: { const: PROCESS_FILE_FORMAT, description: "Always the text transpera-process/1." },
    name: { type: "string", minLength: 1, maxLength: MAX_NAME, description: "What the process is called, e.g. Enquiry to signed client." },
    kind: { enum: ["pipeline", "servicing"], default: "pipeline", description: "pipeline: how new leads become clients (default). servicing: a recurring process for existing clients." },
    description: { type: "string", maxLength: 4000, description: "A sentence on what the process covers." },
    entity_name: { type: "string", minLength: 1, maxLength: 100, description: "What flows through it, e.g. lead, task. Default: lead for a pipeline, item for a servicing process." },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: MAX_FILE_STEPS,
      description: "Every step. Give each a short unique id that links refer to.",
      items: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "string", minLength: 1, description: "A short unique id, e.g. review. Links use it." },
          name: { type: "string", minLength: 1, maxLength: MAX_NAME, description: "What the step is called on the map." },
          type: { enum: [...FILE_STEP_TYPES], default: "step", description: "step: someone does work. decision: items branch. wait: items sit and wait. start and end: where items come in and finish." },
          role: { type: "string", description: "The role that does it, e.g. Managing director. Roles the company doesn't have yet are matched in the preview; none are created." },
          person: { type: "string", description: "A person to pin it to (only if they are already in the company; otherwise ignored)." },
          hands_on_hours: { type: "number", minimum: 0, maximum: MAX_HOURS, description: "Hours of hands-on work per item (average)." },
          wait_hours: { type: "number", minimum: 0, maximum: MAX_WAIT_HOURS, description: "Hours an item waits at this step per item (average)." },
          rework_rate: { type: "number", minimum: 0, maximum: 1, description: "Share of items sent back to do again, from 0 to 1 (0.1 is one in ten)." },
          notes: { type: "string", maxLength: MAX_NOTES },
          x: { type: "number", description: "Position on the map. Give x and y together, or leave both out to be laid out left to right." },
          y: { type: "number" },
        },
      },
    },
    links: {
      type: "array",
      maxItems: MAX_FILE_LINKS,
      description: "How the steps connect, each from one step id to another.",
      items: {
        type: "object",
        required: ["from", "to"],
        properties: {
          from: { type: "string", minLength: 1 },
          to: { type: "string", minLength: 1 },
          probability: { type: "number", minimum: 0, maximum: 1, description: "The share of items that take this branch, from 0 to 1. Branches out of a step add up to 1." },
          label: { type: "string", maxLength: 200, description: "e.g. Qualified" },
        },
      },
    },
    groups: {
      type: "array",
      description: "Optional boxes that gather steps on the map.",
      items: {
        type: "object",
        required: ["name", "steps"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: MAX_NAME },
          steps: { type: "array", items: { type: "string" }, description: "Ids of the steps in the group (not start or end steps)." },
        },
      },
    },
  },
} as const;

/** A worked example: a small sales pipeline. It passes the checker with no errors and no warnings. */
export const PROCESS_FILE_EXAMPLE = {
  format: PROCESS_FILE_FORMAT,
  name: "Enquiry to signed client",
  kind: "pipeline",
  description: "From a new enquiry to a signed engagement letter.",
  steps: [
    { id: "enquiry", name: "Enquiry arrives", type: "start" },
    { id: "review", name: "Review enquiry", type: "step", role: "Managing director", hands_on_hours: 0.25, wait_hours: 4, notes: "Checked the same day if it comes in before noon." },
    { id: "call", name: "Discovery call", type: "step", role: "Managing director", hands_on_hours: 1, wait_hours: 24, rework_rate: 0.1 },
    { id: "proposal", name: "Write proposal", type: "step", role: "Account manager", hands_on_hours: 3, wait_hours: 8 },
    { id: "decides", name: "Client decides", type: "decision" },
    { id: "signed", name: "Client signs", type: "end" },
    { id: "declined", name: "Client declines", type: "end" },
    { id: "unqualified", name: "Not a fit", type: "end" },
  ],
  links: [
    { from: "enquiry", to: "review" },
    { from: "review", to: "call", probability: 0.67, label: "Qualified" },
    { from: "review", to: "unqualified", probability: 0.33, label: "Not a fit" },
    { from: "call", to: "proposal" },
    { from: "proposal", to: "decides" },
    { from: "decides", to: "signed", probability: 0.6, label: "Signs" },
    { from: "decides", to: "declined", probability: 0.4, label: "Declines" },
  ],
} as const;

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A name or id in quotes, cut when it is absurdly long so a message stays readable. */
const q = (s: string) => `'${s.length > 60 ? `${s.slice(0, 57)}...` : s}'`;
const norm = (s: string) => s.trim().toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const TOP_FIELDS = ["$schema", "format", "name", "kind", "description", "entity_name", "steps", "links", "groups"];
const STEP_FIELDS = ["id", "name", "type", "role", "person", "hands_on_hours", "wait_hours", "rework_rate", "notes", "x", "y"];
const LINK_FIELDS = ["from", "to", "probability", "label"];
const GROUP_FIELDS = ["name", "steps"];

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length]!;
}

/**
 * The step id closest to `ref`, when it is near enough to be a typo. Bounded: ids and references longer than MAX_ID get none, ids
 * whose length can't be close enough are skipped without comparing, and `budget` limits how many suggestions a file can ask for.
 */
function suggest(ref: string, ids: readonly string[], budget: { left: number }): string | null {
  if (ref.length > MAX_ID || budget.left <= 0) return null;
  budget.left--;
  const limit = Math.max(1, Math.floor(ref.length / 3));
  let best: { id: string; d: number } | null = null;
  for (const id of ids) {
    if (id.length > MAX_ID || Math.abs(id.length - ref.length) > limit) continue;
    const d = distance(ref.toLowerCase(), id.toLowerCase());
    if (!best || d < best.d) best = { id, d };
  }
  return best && best.d <= limit ? best.id : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Check a parsed file and say, in plain words, what is wrong with it. Errors: the wrong or missing `format`, no name or
 * steps, duplicate ids or names, links to or from steps that don't exist, links the editor wouldn't allow, more than one
 * start step, loops with nothing to decide when they stop, numbers out of range. Warnings: fields we don't read, no
 * start or end step, branches that don't add up to 1, steps nothing leaves or reaches. When there are no errors, `file`
 * is the file with its defaults filled in (a missing start step is chosen, the type of every step is set).
 */
export function checkProcessFile(input: unknown): ProcessFileCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const budget = { left: MAX_SUGGESTIONS };
  /** A long list of problems is cut, so a hostile file can't make a huge answer. */
  const listed = (list: string[]): string[] => (list.length > MAX_LISTED ? [...list.slice(0, MAX_LISTED), `…and ${list.length - MAX_LISTED} more problems like these.`] : list);
  const fail = (): ProcessFileCheck => ({ file: null, errors: listed(errors), warnings: listed(warnings) });

  if (!isObject(input)) {
    errors.push("The file isn't a process: it should be one JSON object with a format, a name and steps. Use 'Copy prompt for Claude' to ask for one, or 'Download example' to see what it looks like.");
    return fail();
  }

  // The format comes first: if it is wrong, nothing else in the file can be trusted to mean what we think.
  const format = input.format;
  if (format === undefined) {
    errors.push(`The file doesn't say which format it is in. Add "format": "${PROCESS_FILE_FORMAT}" at the top.`);
    return fail();
  }
  if (format !== PROCESS_FILE_FORMAT) {
    const said = typeof format === "string" ? q(format) : "something that isn't text";
    errors.push(
      typeof format === "string" && format.startsWith("transpera-process/")
        ? `The file is in format ${said}, but this version of Transpera reads ${q(PROCESS_FILE_FORMAT)}. Ask Claude to redo it in that format.`
        : `The file says its format is ${said}, but Transpera reads ${q(PROCESS_FILE_FORMAT)}. If this file came from Claude, ask it to follow the format from 'Copy prompt for Claude'.`,
    );
    return fail();
  }

  for (const key of Object.keys(input)) {
    if (!TOP_FIELDS.includes(key)) warnings.push(`The file has a field ${q(key)} that Transpera doesn't use. It was ignored.`);
  }

  // Name, kind and the rest of the process.
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errors.push("The process has no name. Add a \"name\" at the top, e.g. \"Enquiry to signed client\".");
  else if (name.length > MAX_NAME) errors.push(`The process name is ${name.length} characters long; the most is ${MAX_NAME}.`);
  let kind: ProcessFile["kind"] = "pipeline";
  if (input.kind !== undefined) {
    if (input.kind === "pipeline" || input.kind === "servicing") kind = input.kind;
    else errors.push(`The process kind ${typeof input.kind === "string" ? q(input.kind) : "given"} isn't one Transpera knows. Use "pipeline" (new leads becoming clients) or "servicing" (recurring work for existing clients), or leave it out.`);
  }
  const text = (key: "description" | "entity_name", max: number): string | undefined => {
    const v = input[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") {
      errors.push(`The process ${key === "description" ? "description" : "entity_name"} should be text.`);
      return undefined;
    }
    if (v.length > max) errors.push(`The process ${key} is ${v.length} characters long; the most is ${max}.`);
    return v.trim() || undefined;
  };
  const description = text("description", 4000);
  const entity_name = text("entity_name", 100);

  // Steps.
  const rawSteps = input.steps;
  const steps: ProcessFileStep[] = [];
  /** Ids of steps that have one, even if the step has other problems already reported, so links to it aren't blamed too. */
  const declared = new Set<string>();
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    errors.push("The file has no steps. Add a \"steps\" list with at least one step, each with an id and a name.");
  } else {
    if (rawSteps.length > MAX_FILE_STEPS) errors.push(`The file has ${rawSteps.length} steps; the most Transpera takes in one upload is ${MAX_FILE_STEPS}.`);
    const seenIds = new Map<string, string>();
    const seenNames = new Map<string, string>();
    rawSteps.slice(0, MAX_FILE_STEPS).forEach((raw, i) => {
      const where = `Step ${i + 1}`;
      if (!isObject(raw)) {
        errors.push(`${where} should be an object with an id and a name.`);
        return;
      }
      const id = typeof raw.id === "string" ? raw.id.trim() : typeof raw.id === "number" ? String(raw.id) : "";
      const nm = typeof raw.name === "string" ? raw.name.trim() : "";
      const label = nm ? `Step ${q(nm)}` : id ? `Step ${q(id)}` : where;
      if (!id) errors.push(`${label} has no id. Give each step a short unique id (like "review") so links can point at it.`);
      if (!nm) errors.push(`${label} has no name.`);
      else if (nm.length > MAX_NAME) errors.push(`${label}'s name is ${nm.length} characters long; the most is ${MAX_NAME}.`);
      else if (!norm(nm)) errors.push(`${label} has no letters or numbers in its name. Give it a name people can read.`);
      if (id.length > MAX_ID) errors.push(`${label}'s id is ${id.length} characters long; ids are short labels (the most is ${MAX_ID}).`);
      for (const key of Object.keys(raw)) {
        if (!STEP_FIELDS.includes(key)) warnings.push(`${label} has a field ${q(key)} that Transpera doesn't use. It was ignored.`);
      }
      if (id) {
        declared.add(id);
        if (seenIds.has(id)) errors.push(`Two steps have the id ${q(id)} (${q(seenIds.get(id)!)} and ${q(nm || id)}). Every step needs its own id.`);
        else seenIds.set(id, nm || id);
      }
      if (nm) {
        const key = norm(nm);
        if (seenNames.has(key)) errors.push(`Two steps are both called ${q(nm)}. Give them different names so they can be told apart on the map.`);
        else seenNames.set(key, id);
      }
      let type: FileStepType = "step";
      if (raw.type !== undefined) {
        if (typeof raw.type === "string" && (FILE_STEP_TYPES as readonly string[]).includes(raw.type)) type = raw.type as FileStepType;
        else errors.push(`${label} has the type ${typeof raw.type === "string" ? q(raw.type) : "given"}, which Transpera doesn't know. Use step, decision, wait, start or end.`);
      }
      const num = (key: "hands_on_hours" | "wait_hours" | "rework_rate", max: number, hint: string): number | undefined => {
        const v = raw[key];
        if (v === undefined || v === null) return undefined;
        if (typeof v !== "number" || !Number.isFinite(v)) {
          errors.push(`${label}: ${key} should be a number (${hint}).`);
          return undefined;
        }
        if (v < 0 || v > max) {
          errors.push(`${label}: ${key} is ${v}, but it has to be between 0 and ${max}${key === "rework_rate" ? " (0.1 means one item in ten goes back)" : ""}.`);
          return undefined;
        }
        return v;
      };
      const str = (key: "role" | "person" | "notes", max: number): string | undefined => {
        const v = raw[key];
        if (v === undefined || v === null) return undefined;
        if (typeof v !== "string") {
          errors.push(`${label}: ${key} should be text.`);
          return undefined;
        }
        if (v.length > max) errors.push(`${label}: ${key} is ${v.length} characters long; the most is ${max}.`);
        return v.trim() || undefined;
      };
      const hands = num("hands_on_hours", MAX_HOURS, "hours, like 0.25");
      const wait = num("wait_hours", MAX_WAIT_HOURS, "hours, like 24");
      const rework = num("rework_rate", 1, "a share from 0 to 1, like 0.1");
      let x: number | undefined;
      let y: number | undefined;
      if (raw.x !== undefined || raw.y !== undefined) {
        if (typeof raw.x === "number" && typeof raw.y === "number" && Number.isFinite(raw.x) && Number.isFinite(raw.y) && Math.abs(raw.x) <= 1e6 && Math.abs(raw.y) <= 1e6) {
          x = raw.x;
          y = raw.y;
        } else warnings.push(`${label} has a position that isn't two numbers (x and y), so it will be placed automatically.`);
      }
      if (id && nm) {
        const step: ProcessFileStep = { id, name: nm, type };
        const role = str("role", 200);
        const person = str("person", 200);
        const notes = str("notes", MAX_NOTES);
        if (role) step.role = role;
        if (person) step.person = person;
        if (notes) step.notes = notes;
        if (hands !== undefined) step.hands_on_hours = hands;
        if (wait !== undefined) step.wait_hours = wait;
        if (rework !== undefined) step.rework_rate = rework;
        if (x !== undefined && y !== undefined) {
          step.x = x;
          step.y = y;
        }
        steps.push(step);
      } else {
        str("role", 200);
        str("person", 200);
        str("notes", MAX_NOTES);
      }
    });
  }
  const ids = steps.map((s) => s.id);
  const nameTaken = (nm: string) => steps.some((s) => norm(s.name) === norm(nm)) || groups.some((g) => norm(g.name) === norm(nm));
  const byId = new Map(steps.map((s) => [s.id, s]));
  const stepName = (id: string) => byId.get(id)?.name ?? id;

  // Links.
  const links: ProcessFileLink[] = [];
  const rawLinks = input.links;
  if (rawLinks !== undefined && !Array.isArray(rawLinks)) errors.push("\"links\" should be a list of {from, to} pairs.");
  else if (Array.isArray(rawLinks)) {
    if (rawLinks.length > MAX_FILE_LINKS) errors.push(`The file has ${rawLinks.length} links; the most Transpera takes in one upload is ${MAX_FILE_LINKS}.`);
    const seen = new Set<string>();
    rawLinks.slice(0, MAX_FILE_LINKS).forEach((raw, i) => {
      if (!isObject(raw)) {
        errors.push(`Link ${i + 1} should be an object with a from and a to.`);
        return;
      }
      const from = typeof raw.from === "string" ? raw.from.trim() : typeof raw.from === "number" ? String(raw.from) : "";
      const to = typeof raw.to === "string" ? raw.to.trim() : typeof raw.to === "number" ? String(raw.to) : "";
      if (!from || !to) {
        errors.push(`Link ${i + 1} needs both a "from" and a "to" (step ids).`);
        return;
      }
      for (const key of Object.keys(raw)) {
        if (!LINK_FIELDS.includes(key)) warnings.push(`The link from ${q(from)} to ${q(to)} has a field ${q(key)} that Transpera doesn't use. It was ignored.`);
      }
      let ok = true;
      for (const [end, ref] of [["from", from], ["to", to]] as const) {
        if (declared.has(ref) && !byId.has(ref)) return;
        if (!byId.has(ref)) {
          const near = suggest(ref, ids, budget);
          errors.push(
            end === "from"
              ? `Link from ${q(from)} goes to ${q(to)}, but ${q(from)} isn't a step.${near ? ` Did you mean ${q(near)}?` : ""}`
              : `Link from ${q(from)} goes to ${q(to)}, which isn't a step.${near ? ` Did you mean ${q(near)}?` : ""}`,
          );
          ok = false;
          break;
        }
      }
      if (!ok) return;
      const a = byId.get(from)!;
      const b = byId.get(to)!;
      if (from === to) return void errors.push(`${q(a.name)} links to itself. To send work back to the same step, give it a rework_rate instead.`);
      if (a.type === "end") return void errors.push(`${q(a.name)} is an end step, so nothing can follow it, but there is a link from it to ${q(b.name)}.`);
      if (b.type === "start") return void errors.push(`${q(b.name)} is the start step, so nothing can lead into it, but ${q(a.name)} links to it.`);
      const key = `${from}\u0000${to}`;
      if (seen.has(key)) return void errors.push(`${q(a.name)} is linked to ${q(b.name)} twice.`);
      seen.add(key);
      let probability: number | undefined;
      if (raw.probability !== undefined && raw.probability !== null) {
        if (typeof raw.probability !== "number" || !(raw.probability >= 0 && raw.probability <= 1)) {
          return void errors.push(`The link from ${q(a.name)} to ${q(b.name)} has a probability that isn't a number from 0 to 1 (0.6 means 60%).`);
        }
        probability = raw.probability;
      }
      const link: ProcessFileLink = { from, to };
      if (probability !== undefined) link.probability = probability;
      if (typeof raw.label === "string" && raw.label.trim()) link.label = raw.label.trim().slice(0, 200);
      links.push(link);
    });
  }

  // Groups.
  const groups: ProcessFileGroup[] = [];
  const rawGroups = input.groups;
  if (rawGroups !== undefined && !Array.isArray(rawGroups)) errors.push("\"groups\" should be a list of {name, steps} boxes.");
  else if (Array.isArray(rawGroups)) {
    const inGroup = new Map<string, string>();
    const taken = new Set(steps.map((x) => norm(x.name)));
    if (rawGroups.length > MAX_GROUPS) errors.push(`The file has ${rawGroups.length} groups; the most Transpera takes in one upload is ${MAX_GROUPS}.`);
    rawGroups.slice(0, MAX_GROUPS).forEach((raw, i) => {
      if (!isObject(raw)) return void errors.push(`Group ${i + 1} should be an object with a name and a list of step ids.`);
      const nm = typeof raw.name === "string" ? raw.name.trim() : "";
      if (!nm) return void errors.push(`Group ${i + 1} has no name.`);
      if (nm.length > MAX_NAME) return void errors.push(`Group ${q(nm)}'s name is ${nm.length} characters long; the most is ${MAX_NAME}.`);
      if (!norm(nm)) return void errors.push(`Group ${q(nm)} has no letters or numbers in its name. Give it a name people can read.`);
      for (const key of Object.keys(raw)) {
        if (!GROUP_FIELDS.includes(key)) warnings.push(`Group ${q(nm)} has a field ${q(key)} that Transpera doesn't use. It was ignored.`);
      }
      if (!Array.isArray(raw.steps)) return void errors.push(`Group ${q(nm)} needs a "steps" list of step ids.`);
      if (taken.has(norm(nm))) return void errors.push(`A group and a step (or two groups) are both called ${q(nm)}. Give them different names.`);
      taken.add(norm(nm));
      if (raw.steps.length > MAX_FILE_STEPS) return void errors.push(`Group ${q(nm)} lists ${raw.steps.length} steps; a file can't have that many.`);
      const members: string[] = [];
      for (const ref of raw.steps) {
        const id = typeof ref === "string" ? ref.trim() : "";
        const s = byId.get(id);
        if (!s) {
          const near = id ? suggest(id, ids, budget) : null;
          errors.push(`Group ${q(nm)} lists ${q(String(ref))}, which isn't a step.${near ? ` Did you mean ${q(near)}?` : ""}`);
        } else if (s.type === "start" || s.type === "end") errors.push(`Group ${q(nm)} holds ${q(s.name)}, but start and end steps stay outside groups.`);
        else if (inGroup.has(id)) errors.push(`${q(s.name)} is in two groups (${q(inGroup.get(id)!)} and ${q(nm)}); a step can be in one.`);
        else {
          inGroup.set(id, nm);
          members.push(id);
        }
      }
      if (!members.length) warnings.push(`Group ${q(nm)} has no steps, so it was left out.`);
      else groups.push({ name: nm, steps: members });
    });
  }

  if (errors.length) return fail();

  // The graph.
  const out = new Map<string, ProcessFileLink[]>();
  const into = new Map<string, number>();
  for (const l of links) {
    out.set(l.from, [...(out.get(l.from) ?? []), l]);
    into.set(l.to, (into.get(l.to) ?? 0) + 1);
  }

  const starts = steps.filter((s) => s.type === "start");
  if (starts.length > 1) errors.push(`A process has one start step, but this file has ${starts.length} (${starts.map((s) => q(s.name)).join(", ")}). Keep one and make the others ordinary steps.`);

  // Loops: a group of steps that lead back to each other needs a decision that decides when it stops.
  for (const comp of loops(ids, links)) {
    if (!comp.some((id) => byId.get(id)!.type === "decision")) {
      errors.push(
        `${comp.map((id) => q(stepName(id))).join(" → ")} → ${q(stepName(comp[0]!))} goes round in a loop with nothing to decide when it stops. Add a decision step to the loop (with a branch that leaves it), or use rework_rate to send work back.`,
      );
    }
  }
  if (errors.length) return fail();

  // A start step is where items come in, and the simulation takes it as the entry only: it must lead to exactly one step.
  for (const s of starts) {
    const leaving = out.get(s.id) ?? [];
    if (leaving.length > 1) {
      errors.push(`Start step ${q(s.name)} leads to ${leaving.length} steps, but a start step leads to exactly one. Link it to one step, and put a decision step after it to branch.`);
    }
  }
  if (errors.length) return fail();

  const normalised = steps.map((s) => ({ ...s }));
  if (!starts.length) {
    const entry = steps.find((s) => s.type !== "end" && !into.has(s.id)) ?? steps.find((s) => s.type !== "end");
    const grouped = new Set(groups.flatMap((g) => g.steps));
    // A step can stand in as the start only if that costs it nothing: no numbers, role or person of its own (a start step is an
    // entry point, so they would be lost), one way out, nothing leading into it, and not inside a group.
    const plain =
      entry !== undefined &&
      entry.type === "step" &&
      entry.hands_on_hours === undefined &&
      entry.wait_hours === undefined &&
      entry.rework_rate === undefined &&
      entry.role === undefined &&
      entry.person === undefined &&
      !into.has(entry.id) &&
      (out.get(entry.id) ?? []).length === 1 &&
      !grouped.has(entry.id);
    if (entry && plain) {
      warnings.push(`No start step: ${q(entry.name)} will be used as the start.`);
      normalised.find((s) => s.id === entry.id)!.type = "start";
    } else if (entry) {
      let id = "start";
      for (let n = 2; declared.has(id); n++) id = `start-${n}`;
      let nm = "Start";
      for (let n = 2; nameTaken(nm); n++) nm = `Start ${n}`;
      warnings.push(`No start step: a start step will be added in front of ${q(entry.name)}.`);
      normalised.unshift({ id, name: nm, type: "start" });
      links.unshift({ from: id, to: entry.id });
      out.set(id, [{ from: id, to: entry.id }]);
    } else warnings.push("No start step, and every step is an end step.");
  }
  if (!steps.some((s) => s.type === "end")) {
    warnings.push("No end step: nothing says how an item finishes. Add an end step (won, lost or done) for each way it can finish.");
  }

  const finalById = new Map(normalised.map((s) => [s.id, s]));
  for (const s of normalised) {
    const leaving = out.get(s.id) ?? [];
    const label = `${s.type === "decision" ? "Decision" : s.type === "start" ? "Start step" : "Step"} ${q(s.name)}`;
    if (s.type !== "end" && !leaving.length && normalised.length > 1) {
      warnings.push(`Nothing leaves ${q(s.name)}, so items stop there. Link it to the next step, or make it an end step.`);
      continue;
    }
    if (s.type !== "start" && leaving.length) {
      const given = leaving.filter((l) => l.probability !== undefined);
      const total = given.reduce((sum, l) => sum + l.probability!, 0);
      if (given.length === leaving.length) {
        if (Math.abs(total - 1) > SUM_TOLERANCE) warnings.push(`${label} branches add up to ${round(total)}, not 1. The probabilities of the ways out of a step should add up to 1.`);
      } else if (total > 1 + SUM_TOLERANCE) {
        warnings.push(`${label} branches already add up to ${round(total)}, which leaves nothing for the ${plural(leaving.length - given.length, "branch")} with no probability.`);
      }
    }
  }
  // Steps nothing reaches from the start.
  const start = normalised.find((s) => s.type === "start");
  if (start) {
    const reached = new Set<string>([start.id]);
    const queue = [start.id];
    while (queue.length) {
      for (const l of out.get(queue.shift()!) ?? []) {
        if (!reached.has(l.to)) {
          reached.add(l.to);
          queue.push(l.to);
        }
      }
    }
    for (const s of normalised) {
      if (!reached.has(s.id)) warnings.push(`${q(finalById.get(s.id)!.name)} can't be reached from the start step, so no item would ever get there.`);
    }
  }

  return {
    file: { format: PROCESS_FILE_FORMAT, name, kind, ...(description ? { description } : {}), ...(entity_name ? { entity_name } : {}), steps: normalised, links, groups },
    errors,
    warnings,
  };
}

/** Groups of steps that lead back to each other (strongly connected components of two or more steps), in file order. */
function loops(ids: readonly string[], links: readonly ProcessFileLink[]): string[][] {
  const next = new Map<string, string[]>();
  for (const l of links) next.set(l.from, [...(next.get(l.from) ?? []), l.to]);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let counter = 0;
  const visit = (v: string) => {
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      for (let w: string; ; ) {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      if (comp.length > 1) found.push(comp.sort((a, b) => ids.indexOf(a) - ids.indexOf(b)));
    }
  };
  for (const id of ids) if (!index.has(id)) visit(id);
  return found.sort((a, b) => ids.indexOf(a[0]!) - ids.indexOf(b[0]!));
}

/** Parse the text of a JSON file and check it; a file that isn't JSON says so plainly. */
export function checkProcessFileText(text: string): ProcessFileCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    const detail = e instanceof Error ? ` (${e.message})` : "";
    return { file: null, errors: [`The file isn't valid JSON${detail}. If Claude wrote it, ask it to send the JSON again with nothing before or after it.`], warnings: [] };
  }
  return checkProcessFile(parsed);
}

/** The roles the file names, with how many steps use each, in order of first use. */
export function rolesInFile(file: ProcessFile): { name: string; steps: number }[] {
  const roles = new Map<string, { name: string; steps: number }>();
  for (const s of file.steps) {
    if (!s.role) continue;
    const key = norm(s.role);
    const have = roles.get(key);
    if (have) have.steps++;
    else roles.set(key, { name: s.role, steps: 1 });
  }
  return [...roles.values()];
}

// ---------------------------------------------------------------------------
// Finding the object in an HTML page
// ---------------------------------------------------------------------------

export const NO_BLOCK_MESSAGE = `This page has no Transpera process in it. The importer only reads a <script type="${PROCESS_FILE_BLOCK_TYPE}"> block and never guesses from the drawing. Ask Claude to add that block, using 'Copy prompt for Claude'.`;

/** Longest attribute section of a script tag that is looked at; a real tag is a few dozen characters. */
const MAX_TAG = 2_000;

/** The value of the `type` attribute in a script tag's attribute text (`a="b" type='c'`), or null. Linear; the name must be exactly `type`. */
function typeAttribute(attrs: string): string | null {
  const n = attrs.length;
  let i = 0;
  while (i < n) {
    while (i < n && /[\s/]/.test(attrs[i]!)) i++;
    const start = i;
    while (i < n && !/[\s=/]/.test(attrs[i]!)) i++;
    const name = attrs.slice(start, i).toLowerCase();
    while (i < n && /\s/.test(attrs[i]!)) i++;
    if (attrs[i] !== "=") {
      if (i === start) i++;
      continue;
    }
    i++;
    while (i < n && /\s/.test(attrs[i]!)) i++;
    let value: string;
    const quote = attrs[i];
    if (quote === '"' || quote === "'") {
      const end = attrs.indexOf(quote, i + 1);
      value = attrs.slice(i + 1, end === -1 ? n : end);
      i = end === -1 ? n : end + 1;
    } else {
      const from = i;
      while (i < n && !/\s/.test(attrs[i]!)) i++;
      value = attrs.slice(from, i);
    }
    if (name === "type") return value.trim().toLowerCase();
  }
  return null;
}

/**
 * The text of the process block in an HTML page, or why there isn't one. Only a script block of type
 * `application/vnd.transpera-process+json` counts; the first one wins. Comments are skipped, `type` has to be the attribute's
 * own name (not `data-type`), and a `>` inside a quoted attribute value doesn't end the tag. One pass over the page with
 * `indexOf`, so a hostile page can't make it slow.
 *
 * Text that is already a JSON object is returned as it is: always with `json: true` (a .json file, or a JSON content type);
 * otherwise only when it parses as JSON, so a page that starts with "{" is still searched for its block.
 */
export function processTextFrom(content: string, opts: { json?: boolean } = {}): { text: string; error?: undefined } | { text?: undefined; error: string } {
  const trimmed = content.replace(/^\uFEFF/, "").trim();
  if (trimmed.startsWith("{")) {
    if (opts.json) return { text: trimmed };
    try {
      JSON.parse(trimmed);
      return { text: trimmed };
    } catch {
      // Not JSON: look for a block.
    }
  } else if (opts.json) return { text: trimmed };
  const lower = content.toLowerCase();
  let at = 0;
  let nextScript = lower.indexOf("<script", at);
  let nextComment = lower.indexOf("<!--", at);
  while (nextScript !== -1) {
    if (nextComment !== -1 && nextComment < at) nextComment = lower.indexOf("<!--", at);
    if (nextComment !== -1 && nextComment < nextScript) {
      const end = lower.indexOf("-->", nextComment + 4);
      if (end === -1) break;
      at = end + 3;
      if (nextScript < at) nextScript = lower.indexOf("<script", at);
      nextComment = lower.indexOf("<!--", at);
      continue;
    }
    const open = nextScript + 7;
    const after = lower[open];
    if (after !== undefined && !/[\s>/]/.test(after)) {
      at = open;
      nextScript = lower.indexOf("<script", at);
      continue;
    }
    // The tag ends at the first ">" outside quotes.
    let i = open;
    let quote = "";
    const limit = Math.min(lower.length, open + MAX_TAG);
    for (; i < limit; i++) {
      const c = lower[i]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (i >= limit) {
      // No end to the tag within reason: not a tag we read, and what it swallowed isn't looked at again (this keeps the pass linear).
      at = limit;
      nextScript = lower.indexOf("<script", at);
      continue;
    }
    const close = lower.indexOf("</script", i + 1);
    if (close === -1) break;
    if (typeAttribute(content.slice(open, i)) === PROCESS_FILE_BLOCK_TYPE) {
      const body = content.slice(i + 1, close).trim();
      if (!body) return { error: "The process block in this page is empty. Ask Claude to fill it in, using 'Copy prompt for Claude'." };
      return { text: body };
    }
    at = close + 8;
    nextScript = lower.indexOf("<script", at);
    if (nextComment !== -1 && nextComment < at) nextComment = lower.indexOf("<!--", at);
  }
  return { error: NO_BLOCK_MESSAGE };
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/** What "Copy prompt for Claude" copies: a short ask, then the schema. */
export function claudePrompt(): string {
  return [
    "I'm going to upload a business process into Transpera Flow, a tool that simulates how work moves through a company.",
    "Please turn the process I describe (or the document, diagram or notes I give you) into ONE JSON object in the transpera-process/1 format below.",
    "",
    "Rules:",
    "- Reply with the JSON only, in a single code block, nothing else.",
    `- If you are making a Claude Design page instead, put the same JSON in the page inside one <script type="${PROCESS_FILE_BLOCK_TYPE}"> block. Transpera reads only that block, never the drawing.`,
    '- "format" must be "transpera-process/1". Every step needs a short unique "id" and a "name"; links use those ids.',
    "- Include a start step and at least one end step. Branches out of a step (usually a decision) have probabilities that add up to 1.",
    "- Only give numbers (hands_on_hours, wait_hours, rework_rate, probability) that I told you or the source says. Leave the rest out: they are marked to confirm in Transpera. Don't invent numbers.",
    "- Use role names exactly as I use them. Don't add fields that aren't in the schema.",
    "- Don't put loops in the links unless a decision step decides when they stop. For work sent back to be redone, use rework_rate.",
    "",
    "The schema:",
    JSON.stringify(PROCESS_FILE_SCHEMA, null, 2),
    "",
    "A small example:",
    JSON.stringify(PROCESS_FILE_EXAMPLE, null, 2),
  ].join("\n");
}
