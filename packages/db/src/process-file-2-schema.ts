// The published side of `transpera-process/2` (issue #167, B14): its JSON Schema (docs/import/transpera-process-2.schema.json,
// kept in step by a test), the worked example, and the prompt "Copy prompt for Claude" copies. The checker is in
// process-file.ts (steps, links, groups) and process-file-2.ts (what /2 adds). /1 is untouched and still uploads.

import { PROCESS_FILE_BLOCK_TYPE, PROCESS_FILE_SCHEMA } from "@transpera-flow/db/process-file";
import {
  EVIDENCE_FIELDS,
  FP_COMPARATORS,
  FP_KINDS,
  FP_VERDICTS,
  ISSUE_TYPES,
  MAX_FILE_SOURCES,
  PROCESS_FILE_FORMAT_2,
  RATINGS,
  SOURCE_KINDS,
  SUCCESS_KPI_KEYS,
} from "@transpera-flow/db/process-file-2";

const citation = { $ref: "#/$defs/citation" } as const;
const citations = { type: "array", maxItems: 10, items: citation } as const;
const assumed = {
  type: "string",
  minLength: 1,
  maxLength: 2000,
  description: 'Why the value is an assumption: nobody said it, so say where the guess comes from ("Typical for a proposal; Sam confirmed the order of magnitude").',
} as const;
const evidence = { ...citations, description: "Quotes that back this, word for word, each from one of the file's sources." } as const;
/** The two ways to say where something came from. Leave both out when the file just states it. */
const backing = { evidence, assumed } as const;

const rangeHours = (what: string) =>
  ({ type: "object", required: ["min", "max"], properties: { min: { type: "number", minimum: 0 }, max: { type: "number", minimum: 0 } }, description: `The lowest and highest ${what} in hours. The typical value is the number beside it.` }) as const;

const stepProperties = PROCESS_FILE_SCHEMA.properties.steps.items.properties;
const linkProperties = PROCESS_FILE_SCHEMA.properties.links.items.properties;

const named = (extra: Record<string, unknown>, what: string) => ({ type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 200, description: what }, ...extra, ...backing } }) as const;

/** The JSON Schema of the format (draft 2020-12). Unknown fields are allowed here: the checker warns about them. */
export const PROCESS_FILE_SCHEMA_2 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Transpera process file (transpera-process/2)",
  description:
    "A process for Transpera Flow, with the evidence behind it. Only the fields marked required have to be there; anything left out is filled in and marked to confirm on the canvas. Nothing company-wide is applied: company facts and proposals wait for a person to accept them.",
  type: "object",
  required: ["format", "name", "steps"],
  $defs: {
    citation: {
      type: "object",
      required: ["source", "quote"],
      description: "One quote that backs a value.",
      properties: {
        source: { type: "string", minLength: 1, description: "The id of one of the file's sources." },
        quote: { type: "string", minLength: 1, maxLength: 2000, description: "The words said, verbatim. Quote just the sentence that gives the number." },
        speaker: { type: "string", maxLength: 200, description: "Who said it." },
        time: { type: "string", maxLength: 100, description: "Where in the source: a time in the recording (00:14:05), a page, a cell." },
        value: { type: "number", minimum: 0, description: "The number they stated, in the units of the value it backs (hours; 0 to 1 for a share). Different values for one number are a conflict, shown for you to settle." },
      },
    },
  },
  properties: {
    format: { const: PROCESS_FILE_FORMAT_2, description: "Always the text transpera-process/2." },
    name: PROCESS_FILE_SCHEMA.properties.name,
    kind: PROCESS_FILE_SCHEMA.properties.kind,
    description: PROCESS_FILE_SCHEMA.properties.description,
    entity_name: PROCESS_FILE_SCHEMA.properties.entity_name,
    sources: {
      type: "array",
      maxItems: MAX_FILE_SOURCES,
      description: "The materials the file is built from. They are added to Sources and linked to this process. Evidence points at them by id.",
      items: {
        type: "object",
        required: ["id", "title"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64, description: "A short unique id, e.g. interview-maya. Evidence uses it." },
          title: { type: "string", minLength: 1, maxLength: 200, description: "e.g. Interview with Maya Chen, 30 Sep." },
          kind: { enum: [...SOURCE_KINDS], default: "transcript", description: "transcript (a conversation), sop (a written procedure), spreadsheet, data (an export), notes (any other document, or a drawn map), screenshot or other." },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "The day it is from, like 2026-09-30." },
          speakers: { type: "array", items: { type: "string" }, description: "Who spoke or wrote it." },
          body: { type: "string", maxLength: 500000, description: "The text itself (optional; leave it out for a long one). When given, quotes are checked against it." },
        },
      },
    },
    steps: {
      ...PROCESS_FILE_SCHEMA.properties.steps,
      description: "Every step. Give each a short unique id that links refer to. Leave out any number nobody gave you: it is marked as missing, and never invented.",
      items: {
        type: "object",
        required: ["id", "name"],
        properties: {
          ...stepProperties,
          hands_on_range: rangeHours("hands-on time"),
          wait_range: rangeHours("wait"),
          rework_to: { type: "string", description: "The id of the step rework goes back to. Default: this step." },
          tool: { type: "string", maxLength: 200, description: "The tool used, e.g. HubSpot." },
          sla_hours: { type: "number", minimum: 0, maximum: 10000, description: "Target hours for one visit to the step." },
          waiting_now: { type: "integer", minimum: 0, description: "Items sitting at the step right now." },
          evidence: {
            type: "object",
            description: `Quotes by value: ${EVIDENCE_FIELDS.join(", ")}. Every number that came from a source should have its quote.`,
            properties: Object.fromEntries(EVIDENCE_FIELDS.map((f) => [f, citations])),
          },
          assumed: {
            type: "object",
            description: `Why a value is an assumption, by value: ${EVIDENCE_FIELDS.join(", ")}.`,
            properties: Object.fromEntries(EVIDENCE_FIELDS.map((f) => [f, assumed])),
          },
        },
      },
    },
    links: {
      ...PROCESS_FILE_SCHEMA.properties.links,
      items: { type: "object", required: ["from", "to"], properties: { ...linkProperties, evidence, assumed } },
    },
    groups: PROCESS_FILE_SCHEMA.properties.groups,
    company: {
      type: "object",
      description: "Facts about the company found in the materials. Each becomes a suggestion for someone to accept or reject; nothing is applied.",
      properties: {
        people: {
          type: "array",
          items: named(
            {
              roles: { type: "array", items: { type: "string" } },
              fte: { type: "number", minimum: 0.01, maximum: 1.5, description: "1 is full time." },
              hours_per_week: { type: "number", minimum: 0.5, maximum: 168 },
              cost_rate: { type: "number", minimum: 0, description: "The hourly cost." },
              email: { type: "string" },
              start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              leave: {
                type: "array",
                description: "Booked leave: the days they are away, from the first to the last.",
                items: {
                  type: "object",
                  required: ["start_date", "end_date"],
                  properties: {
                    start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                    end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                    note: { type: "string", maxLength: 500 },
                  },
                },
              },
            },
            "The person's name.",
          ),
        },
        roles: { type: "array", items: named({}, "The role's name.") },
        clients: {
          type: "array",
          items: named(
            {
              services: { type: "array", items: { type: "string" } },
              mrr: { type: "number", minimum: 0, description: "Monthly recurring revenue." },
              start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              health: { type: "number", minimum: 0, maximum: 100 },
              notes: { type: "string", maxLength: 2000 },
              active: { type: "boolean", description: "false when the client has left; true when they are back." },
              assignments: {
                type: "object",
                description: "Who looks after the client, by role, like {\"Account director\": \"Tom Whitfield\"}. Roles and people the company already has.",
                additionalProperties: { type: "string" },
              },
            },
            "The client's name.",
          ),
        },
        services: {
          type: "array",
          items: named(
            {
              pricing_model: { enum: ["retainer", "one_off", "hourly"] },
              price: { type: "number", minimum: 0, description: "The monthly fee, the whole fee or the hourly rate." },
              margin: { type: "number", minimum: 0, maximum: 1 },
              tenure_months: { type: "number", minimum: 0 },
              monthly_churn: { type: "number", minimum: 0, maximum: 1, description: "0.02 is 2% of clients leaving a month." },
              mix_share: { type: "number", minimum: 0, description: "The relative share of new work." },
            },
            "The service's name.",
          ),
        },
        demand: {
          type: "object",
          properties: {
            lead_sources: {
              type: "array",
              items: named(
                {
                  volume_per_week: { type: "number", minimum: 0, description: "Leads a week." },
                  conversion_to_qualified: { type: "number", minimum: 0, maximum: 1 },
                },
                "The lead source's name, e.g. Website form.",
              ),
            },
            growth_monthly: { type: "number", description: "0.02 is +2% a month." },
            seasonality: { type: "array", minItems: 12, maxItems: 12, items: { type: "number", minimum: 0 }, description: "Twelve multipliers, January first (1 means no effect)." },
            ...backing,
          },
        },
      },
    },
    proposals: {
      type: "array",
      maxItems: 50,
      description: "Issues and ideas found in the materials. They wait in Suggestions for a person to accept; nothing is created.",
      items: {
        type: "object",
        required: ["type", "title"],
        properties: {
          type: { enum: ["issue", "solution_idea"], description: "issue: a problem worth tracking. solution_idea: an idea for an issue you already track (give for_issue)." },
          title: { type: "string", minLength: 1, maxLength: 200 },
          detail: { type: "string", maxLength: 5000, description: "What was seen or said." },
          rating: { enum: [...RATINGS], description: "Issues: great, good (could improve), bad (not urgent) or risk. Default good." },
          issue_type: { enum: [...ISSUE_TYPES] },
          steps: { type: "array", items: { type: "string" }, description: "Issues: ids of the steps it touches. Without any it touches the whole process." },
          target_measure: { type: "string", maxLength: 200 },
          target_now: { type: "string", maxLength: 200 },
          target_goal: { type: "string", maxLength: 200 },
          for_issue: { type: "string", description: "Solution ideas: the number (12 or #12) or title of an issue you already track." },
          proposed_steps: {
            type: "array",
            maxItems: 30,
            description: "Solution ideas: the steps it would put in place, in order.",
            items: { type: "object", required: ["name"], properties: { name: { type: "string" }, kind: { type: "string" }, role: { type: "string" } } },
          },
          expect: { type: "string", maxLength: 1000, description: "Solution ideas: what you expect it to do." },
          ...backing,
        },
      },
    },
    first_principles: {
      type: "object",
      description: "Fill only what the materials say, with the quote. Leave the rest out.",
      properties: {
        job: {
          type: "object",
          properties: { who: { type: "string" }, progress: { type: "string" }, situation: { type: "string" }, done: { type: "string" }, ...backing },
          description: "The job the process does for the person it serves: who, the progress they want, the situation, and what done looks like.",
        },
        truths: {
          type: "array",
          items: { type: "object", required: ["text"], properties: { text: { type: "string" }, kind: { enum: [...FP_KINDS] }, test: { type: "string", description: "For an assumption: how to test it." }, ...backing } },
        },
        requirements: {
          type: "array",
          items: {
            type: "object",
            required: ["text"],
            properties: {
              text: { type: "string" },
              owner: { type: "string", description: "A named person who set it, not a team." },
              why: { type: "string" },
              verdict: { enum: [...FP_VERDICTS] },
              step: { type: "string", description: "The id of the step it creates." },
              ...backing,
            },
          },
        },
        measures: {
          type: "array",
          items: {
            type: "object",
            required: ["text"],
            properties: {
              text: { type: "string" },
              kpi: { enum: [...SUCCESS_KPI_KEYS] },
              comparator: { enum: [...FP_COMPARATORS] },
              target: { type: "number", description: "In the unit people read: a win rate of 30% is 30." },
              horizon: { type: "string" },
              ...backing,
            },
          },
        },
        why: {
          type: "object",
          properties: { problem: { type: "string" }, chain: { type: "array", items: { type: "string" }, description: "Each answer to 'why?', in order." }, root: { type: "string" }, ...backing },
        },
      },
    },
  },
} as const;

/** A worked example with every section. It passes the checker with no errors and no warnings. */
export const PROCESS_FILE_EXAMPLE_2 = {
  format: PROCESS_FILE_FORMAT_2,
  name: "Enquiry to signed client",
  kind: "pipeline",
  description: "From a new enquiry to a signed engagement letter.",
  sources: [
    {
      id: "interview-maya",
      title: "Interview with Maya Chen, managing director",
      kind: "transcript",
      date: "2026-09-30",
      speakers: ["Maya Chen", "Interviewer"],
      body: "Interviewer: How long does the first review take?\nMaya Chen: About fifteen minutes an enquiry, and I do it the same day.\nInterviewer: And proposals?\nMaya Chen: Three hours to write, but they sit for a day before I review them. Most of the website enquiries go nowhere, maybe two in three are a fit.",
    },
    { id: "sales-sop", title: "Sales process SOP, version 3", kind: "notes", date: "2026-06-01", speakers: [] },
    { id: "lead-export", title: "Lead export, Q3 2026", kind: "data", date: "2026-09-30", speakers: [] },
  ],
  steps: [
    { id: "enquiry", name: "Enquiry arrives", type: "start" },
    {
      id: "review",
      name: "Review enquiry",
      type: "step",
      role: "Managing director",
      hands_on_hours: 0.25,
      wait_hours: 4,
      tool: "HubSpot",
      notes: "Checked the same day if it comes in before noon.",
      evidence: { hands_on_hours: [{ source: "interview-maya", speaker: "Maya Chen", time: "00:02:10", quote: "About fifteen minutes an enquiry, and I do it the same day.", value: 0.25 }] },
      assumed: { wait_hours: "Nobody gave a wait; four hours is the half-day the SOP allows." },
    },
    {
      id: "call",
      name: "Discovery call",
      type: "step",
      role: "Managing director",
      hands_on_hours: 1,
      hands_on_range: { min: 0.5, max: 1.5 },
      wait_hours: 24,
      rework_rate: 0.1,
      assumed: { hands_on_hours: "The SOP says calls last up to an hour.", wait_hours: "A day to book, from the SOP's 'next working day'.", rework_rate: "A rough one in ten; nobody measured it." },
    },
    {
      id: "proposal",
      name: "Write proposal",
      type: "step",
      role: "Account manager",
      hands_on_hours: 3,
      wait_hours: 24,
      waiting_now: 2,
      evidence: {
        hands_on_hours: [{ source: "interview-maya", speaker: "Maya Chen", time: "00:06:40", quote: "Three hours to write, but they sit for a day before I review them.", value: 3 }],
        wait_hours: [{ source: "interview-maya", speaker: "Maya Chen", time: "00:06:40", quote: "they sit for a day before I review them", value: 24 }],
      },
    },
    { id: "decides", name: "Client decides", type: "decision" },
    { id: "signed", name: "Client signs", type: "end" },
    { id: "declined", name: "Client declines", type: "end" },
    { id: "unqualified", name: "Not a fit", type: "end" },
  ],
  links: [
    { from: "enquiry", to: "review" },
    {
      from: "review",
      to: "call",
      probability: 0.67,
      label: "Qualified",
      evidence: [{ source: "interview-maya", speaker: "Maya Chen", time: "00:08:15", quote: "maybe two in three are a fit", value: 0.67 }],
    },
    { from: "review", to: "unqualified", probability: 0.33, label: "Not a fit" },
    { from: "call", to: "proposal" },
    { from: "proposal", to: "decides" },
    { from: "decides", to: "signed", probability: 0.6, label: "Signs", assumed: "No data on win rate yet; 60% is the figure the SOP plans around." },
    { from: "decides", to: "declined", probability: 0.4, label: "Declines" },
  ],
  company: {
    people: [{ name: "Maya Chen", roles: ["Managing director"], fte: 1, evidence: [{ source: "interview-maya", speaker: "Maya Chen", time: "00:00:30", quote: "About fifteen minutes an enquiry, and I do it the same day." }], leave: [{ start_date: "2026-12-21", end_date: "2026-12-31", note: "Christmas" }] }],
    clients: [
      {
        name: "Northgate Foods",
        assignments: { "Managing director": "Maya Chen" },
        evidence: [{ source: "sales-sop", time: "page 4", quote: "Maya looks after Northgate Foods herself." }],
      },
    ],
    roles: [{ name: "Account manager", assumed: "The SOP names the role but nobody holds it yet." }],
    services: [{ name: "Monthly retainer", pricing_model: "retainer", price: 1500, evidence: [{ source: "sales-sop", time: "page 2", quote: "The standard retainer is £1,500 a month." }] }],
    demand: {
      lead_sources: [{ name: "Website form", volume_per_week: 8, evidence: [{ source: "lead-export", time: "Sheet 1", quote: "Website form: 104 enquiries in 13 weeks", value: 8 }] }],
    },
  },
  proposals: [
    {
      type: "issue",
      title: "Proposals sit for a day before review",
      detail: "Written proposals wait a full day for the managing director to review them.",
      rating: "good",
      issue_type: "delay",
      steps: ["proposal"],
      evidence: [{ source: "interview-maya", speaker: "Maya Chen", time: "00:06:40", quote: "they sit for a day before I review them" }],
    },
  ],
  first_principles: {
    job: {
      who: "A founder who needs marketing help",
      done: "A signed engagement letter they trust",
      evidence: [{ source: "sales-sop", time: "page 1", quote: "Every enquiry gets a reply the same day." }],
    },
    requirements: [
      {
        text: "Every enquiry gets a reply the same day",
        owner: "Maya Chen",
        why: "It is how the firm wins on trust.",
        verdict: "keep",
        step: "review",
        evidence: [{ source: "sales-sop", time: "page 1", quote: "Every enquiry gets a reply the same day." }],
      },
    ],
    measures: [{ text: "Win rate of at least 30%", kpi: "winRate", comparator: "atLeast", target: 30, horizon: "6 months", assumed: "Austin's goal for the year; no history to check it against." }],
  },
} as const;

/** What "Copy prompt for Claude" copies: a short ask, the rules for evidence, then the schema and an example. */
export function claudePrompt2(): string {
  return [
    "I'm going to upload business processes into Transpera Flow, a tool that simulates how work moves through a company.",
    "Please turn the materials I give you (interview transcripts, rough process maps, SOPs, spreadsheets) into ONE JSON object per process in the transpera-process/2 format below.",
    "",
    "How to work:",
    "1. Read everything first. List what you found (processes, people, numbers) and where the sources disagree.",
    "2. Ask me only the questions that block you, at most five, all in one message.",
    "3. Then build one file per process.",
    "",
    "Rules:",
    "- Reply with the JSON only, in a single code block, nothing else (put anything you want to tell me in a separate short summary after it).",
    `- If you are making a Claude Design page instead, put the same JSON in the page inside one <script type="${PROCESS_FILE_BLOCK_TYPE}"> block. Transpera reads only that block, never the drawing.`,
    '- "format" must be "transpera-process/2". Every step needs a short unique "id" and a "name"; links use those ids.',
    "- Include a start step and at least one end step. Branches out of a step (usually a decision) have probabilities that add up to 1.",
    '- List every material in "sources" (an id, a title, a kind, a date, who spoke). Leave out "body" for long ones.',
    '- Every number comes from a source or is an assumption. A number from a source carries "evidence": the quote word for word (never reworded), its source id, who said it and where (a time or a page), and "value" when they stated a number. A number nobody stated carries "assumed": one sentence on why. If neither is true, leave the number out. Never invent one.',
    "- Quote a day length exactly as it was said: if someone says a working day, keep that in the quote and convert it in the number (7.5 hours a day unless the sources say otherwise). If two sources give different numbers, give both as separate quotes with their own value: Transpera flags the disagreement for me to settle.",
    "- Useful minimum for a meaningful simulation: a role and hands-on time on every work step, a wait on every wait step, odds on every branch of a decision, and how many leads (or recurring tasks) arrive. Ask me for what's missing rather than guessing; the upload warns about anything still missing.",
    '- Facts about the company (people with their booked leave, roles, clients with whether they are still clients and who looks after them, services, lead volumes) go in "company", each with evidence. They only become suggestions for me to accept. When two sources disagree on a company fact, keep both quotes and leave the value out; when one source corrects another later, the correction wins.',
    '- Problems and ideas you find go in "proposals", each with its quote. They only become proposals for me to accept. A "solution_idea" needs "for_issue": an issue I already track.',
    '- "first_principles" only holds what the materials say, quoted. Leave the rest empty.',
    "- Use role names exactly as I use them. Don't add fields that aren't in the schema.",
    "- Don't put loops in the links unless a decision step decides when they stop. For work sent back to be redone, use rework_rate (and rework_to for where it goes).",
    "",
    "The schema:",
    JSON.stringify(PROCESS_FILE_SCHEMA_2, null, 2),
    "",
    "A worked example:",
    JSON.stringify(PROCESS_FILE_EXAMPLE_2, null, 2),
  ].join("\n");
}
