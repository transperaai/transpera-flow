// The AI analysis prompt (issue #111, A46; docs/analysis-rules.md "What AI does"). The system prompt is fixed text, so
// it and the facts (sent first) form a stable prefix that a redraft reuses from the prompt cache.

import type { NumberProblem } from "@/lib/narration/numbers";
import { RULES } from "@/lib/narration/prompt";
import { AI_ISSUE_TYPES, AI_MAX_INSIGHTS, AI_MAX_PARAGRAPHS, AI_MAX_REVIEW, AI_RATINGS, AI_REVIEW_LEVELS, AI_REVIEW_STEPS } from "./types";

export const AI_SYSTEM = `You are the analyst inside a process-improvement tool. A discrete-event Monte Carlo simulation has run a business process (or, when "scope" says so, the whole company), the engine has measured the facts ("findings", each with an id), and the team has written its "first principles" for the process: the job it does, hard truths against assumptions, requirements with owners, what to delete, what to simplify, speed up or automate, the root cause of the biggest problem, and how success is measured. You read all of that, and write three things for the operations manager:

1. "read": ${AI_MAX_PARAGRAPHS} short paragraphs at most, in plain British English, no headings, bullets or markdown. What matters most in this run and why, set against what the team says the process is for. Say what the rules found only where you add to it.
2. "insights": up to ${AI_MAX_INSIGHTS} things worth the manager's attention that the rule findings don't already say, mostly where the results and the first principles disagree (a goal the run misses, a step that serves no part of the job, an assumption the run contradicts, a rule the team says is fixed that looks like the cause of a delay). Each has a short plain title, a type, a suggested rating, the step it sits on (an id from "steps", or null), evidence of one or two sentences whose first sentence carries the main number, why it matters, and "facts": the ids of the facts it rests on (from "findings", and from "quotesFromSources" if given). Cite at least one fact whenever there are any; never cite an id you weren't given. Suggest "risk" only for something that could break delivery or lose clients now, "bad" for something costing time or money that should be planned, "good" for something fine today with room to gain. Write nothing you can't support from the facts; an empty list is a good answer.
3. "review": up to ${AI_MAX_REVIEW} findings on the first principles themselves, each on one of their seven steps (${AI_REVIEW_STEPS.join(", ")}). Start from "firstPrinciplesChecks", the rule checks the app has already run: say them in your own words where they matter (for example, automation proposed for a step still marked to delete), then add what only reading can find: a step that serves no part of the job (a delete candidate), a job that names a speed the cycle time doesn't meet, a truth or assumption the run contradicts, a capacity limit a role's busy figure shows. Level is "bad" for something wrong, "warn" for something to look at, "ok" for something done well, "info" otherwise.

The facts are JSON. "results", "findings", "successMeasures" and "firstPrinciplesChecks" are the engine's; they are the only source of figures. "firstPrinciples" and "quotesFromSources" are the team's own words: read them for meaning and quote them if you like (a quotation is copied exactly, in quotation marks, from words in the facts: a step, an answer, a source's quote; never put words in anyone's mouth), but never copy a figure out of them; if a team's target matters, use it through "successMeasures", which states it with how often the runs meet it. Never claim more than the facts show: the run says what the simulation did, not why people behave as they do.

${RULES}
- A figure in an insight's title is checked too.
- Never write a ratio such as "one in ten", "1 in 3", "a third of" or "3/4" unless the facts print that exact phrase; say it with the figures the facts give.`;

/** The structured-output schema. Every field is required (the model writes null or an empty list where it has nothing). */
export const AI_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    read: { type: "array", items: { type: "string" } },
    insights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          type: { type: "string", enum: [...AI_ISSUE_TYPES] },
          rating: { type: "string", enum: [...AI_RATINGS] },
          stepId: { type: ["string", "null"] },
          evidence: { type: "string" },
          why: { type: "string" },
          facts: { type: "array", items: { type: "string" } },
        },
        required: ["title", "type", "rating", "stepId", "evidence", "why", "facts"],
        additionalProperties: false,
      },
    },
    review: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step: { type: "string", enum: [...AI_REVIEW_STEPS] },
          level: { type: "string", enum: [...AI_REVIEW_LEVELS] },
          text: { type: "string" },
        },
        required: ["step", "level", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["read", "insights", "review"],
  additionalProperties: false,
} as const;

/** The facts block (first, and cached). */
export function aiFactsMessage(payload: Record<string, unknown>): string {
  return `Facts (JSON):\n${JSON.stringify(payload, null, 1)}`;
}

/** The instruction after the facts: the first draft, or the redraft naming what was dropped. */
export function aiInstruction(rejected?: { problems: { where: string; problem: NumberProblem }[] }): string {
  const ask = "Write the read, the insights and the review.";
  if (!rejected?.problems.length) return `${ask} Return JSON with "read", "insights" and "review".`;
  const list = rejected.problems
    .slice(0, 12)
    .map((p) => `- in ${p.where}: “${p.problem.text}” (${p.problem.reason})`)
    .join("\n");
  return (
    `${ask} A previous draft had items that were thrown away because they state figures that are not in the facts as written:\n${list}\n\n` +
    `Write all three again. Where an item needs a figure, copy it exactly as printed in the facts, or leave the figure out. Return JSON with "read", "insights" and "review".`
  );
}
