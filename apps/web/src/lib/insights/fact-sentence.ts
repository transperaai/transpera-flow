// Facts from the run, one plain sentence each (Q3 item 4). The engine's evidence is long (cut-offs, ranges, escalation notes);
// the process page shows one short sentence per fact, with at most one number in it. The sentence for each kind of rule lives here,
// in one place, and nowhere else. A kind with no sentence of its own falls back to the fact's title. Pure.

import type { DetectedIssue } from "@transpera-flow/engine";

/** How to turn ids into names. A name that isn't known reads as a generic word, never as an id. */
export interface FactNames {
  step: (id: string) => string | null;
  role: (id: string) => string | null;
  person: (id: string) => string | null;
}

const pct = (share: number) => `${Math.round(share * 100)}%`;
const num = (v: number, digits = 1) => v.toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** The first part of a fact's key: the detector (`capacity`, `spof` …), or `forecast`. */
const kindOf = (key: string): string => key.split(":")[0]!;

/**
 * One sentence for a fact. Each rule kind:
 * - capacity: "{Who} is busy 92% of the time" (or, when client work alone is too much: "{Who}'s client work alone is more than the time they have")
 * - overtime: "{Who} works 6 h a week of overtime"
 * - queue: "Work keeps piling up at {step}"
 * - wait, rework, dropoff, success, churn_risk, uncovered, broken scenario: the fact's own title, which is already one sentence with one number
 * - sla: "{Step} misses its deadline 30% of the time"
 * - spof: "Only {who} can do {step}: if they're away, that work stops"
 * - cycle: "Takes 2.1× its target time end to end"
 * - spare: "{Who} has about 9 h a week free"
 * - forecast: "{Who} gets too busy in Mar" (the title without its percentage)
 */
export function factSentence(f: Pick<DetectedIssue, "key" | "title" | "metrics" | "stepId" | "roleId" | "personId">, names: FactNames): string {
  const m = f.metrics;
  const step = f.stepId ? (names.step(f.stepId) ?? "this step") : "this step";
  const person = f.personId ? names.person(f.personId) : null;
  const role = f.roleId ? names.role(f.roleId) : null;
  const who = person ?? role ?? "Someone";
  const kind = kindOf(f.key);
  const has = (k: string) => typeof m[k] === "number" && Number.isFinite(m[k]);

  switch (kind) {
    case "capacity":
      if (/client work alone exceeds capacity/.test(f.title)) return `${who}'s client work alone is more than the time ${person ? "they have" : "the team has"}`;
      return has("utilisation") ? `${who} is busy ${pct(m.utilisation!)} of the time` : f.title;
    case "overtime":
      return has("overtime_hours_week") ? `${who} works ${num(m.overtime_hours_week!)} h a week of overtime` : f.title;
    case "queue":
      return `Work keeps piling up at ${step}`;
    case "sla":
      return has("breach_share") ? `${step} misses its deadline ${pct(m.breach_share!)} of the time` : f.title;
    case "spof": {
      const only = person ? `Only ${person}` : role ? `Only one ${role}` : "Only one person";
      return `${only} can do ${step}: if ${person || role ? "they're" : "they are"} away, that work stops`;
    }
    case "cycle":
      return has("target_ratio") ? `Takes ${num(m.target_ratio!)}× its target time end to end` : f.title;
    case "spare":
      return has("free_hours_week") ? `${who} has about ${num(m.free_hours_week!, 0)} h a week free` : f.title;
    case "forecast":
      // "Organic gets too busy in Mar (92% on average)": the month is the point; the percentage is left to the Capacity page.
      return f.title.replace(/\s*\([^)]*\)\s*$/, "");
    default:
      return f.title;
  }
}
