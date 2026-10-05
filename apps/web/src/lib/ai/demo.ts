// The public demo's AI text (issue #111, A46): written in advance for the Northbeam sample, so /demo shows what AI
// analysis looks like without calling any AI. The test in apps/web/test/ai-demo.test.ts runs this text through the real
// number check against the sample's own run, so every figure in it is one the simulation produces.

import { NORTHBEAM_PROCESS_ID, northbeamStepIds } from "@transpera-flow/db";
import type { AiAnalysisView, AiInsight, AiReviewFinding } from "./types";

/** The AI's draft as the model would return it (the shape `screenOutput` reads). */
export const DEMO_AI_OUTPUT = {
  read: [
    "The Strategist is the constraint. They are busy avg 97% of the time (range 85%–101%), and work waits 6.2 working days for Audit & proposal. Your first principles say the job is a signed retainer and a kickoff call in the diary, so that wait is where the job slips.",
    "Sales is holding up: Lead to live wins avg 8.9 (range 6–12), and your goal of at least 8 wins is met in 67% of runs. The bigger risk is after the sale. Late or missed servicing work is behind 58% of the PPC management clients lost over the 13-week run.",
  ],
  insights: [
    {
      title: "Proposals wait about a week for the Strategist",
      type: "delay",
      rating: "bad",
      stepId: northbeamStepIds.audit,
      evidence: "Items queue 49.8 h on average before anyone starts them at Audit & proposal.",
      why: "Your job is a signed retainer and a kickoff call in the diary. A week in the proposal queue is a week a founder can go elsewhere.",
      facts: ["fact-b"],
    },
    {
      title: "Late servicing work is the biggest reason PPC clients leave",
      type: "churn_risk",
      rating: "risk",
      stepId: null,
      evidence: "Late or missed servicing work is behind 58% of the PPC management clients lost over the 13-week run.",
      why: "Fixing report timeliness is worth more than any sales change right now.",
      facts: ["fact-d"],
    },
    {
      title: "Only one person can price and scope work",
      type: "spof",
      rating: "bad",
      stepId: northbeamStepIds.audit,
      evidence: "The Strategist is busy avg 97% of the time (range 85%–101%), and only one person can do Audit & proposal.",
      why: "Your root cause is that pricing and scoping rules aren't written down, so every proposal routes through one person.",
      facts: ["fact-e", "fact-f"],
    },
  ],
  review: [
    { step: "saa", level: "bad", text: "“AI lead qualifier” automates Qualify lead, which is still a delete candidate. The run points at Audit & proposal, not Qualify lead, so simplifying that step first would help more." },
    { step: "del", level: "info", text: "Qualify lead is the one delete candidate. The run shows it isn't what holds work up: Audit & proposal is, so deleting it won't free the Strategist." },
    { step: "reqs", level: "warn", text: "“Every lead is qualified before anyone speaks to them” is owned by Sales team, which is a team, and the reason given is habit. Name who set it, and why." },
    { step: "why", level: "ok", text: "The root cause, no written pricing and scoping rules, is in the process, and the run backs it up: the Strategist is busy avg 97% of the time (range 85%–101%)." },
    { step: "measures", level: "bad", text: "“Win rate of at least 12%” is met in 30% of runs today, so it is the measure to watch." },
  ],
} as const;

const KEYS = ["ai:insight:9d1efee1b163", "ai:insight:6f3406c9135d", "ai:insight:6131898b315a"];

/** The facts each demo finding cites (B17), as the sample's run writes them (test/ai-demo.test.ts checks they match). */
const FACTS: Record<string, { kind: "fact"; key: string; text: string }> = {
  "fact-b": { kind: "fact", key: "wait:step:e0000000-0000-4000-8000-000000000003", text: "Work waits 6.2 working days for Audit & proposal." },
  "fact-d": { kind: "fact", key: "churn_risk:driver:80000000-0000-4000-8000-000000000002:late", text: "Late or missed servicing work causes 58% of PPC management clients leaving." },
  "fact-e": { kind: "fact", key: "capacity:role:b0000000-0000-4000-8000-000000000002", text: "Strategist (Maya Collins) at 97% utilisation." },
  "fact-f": { kind: "fact", key: "spof:step:e0000000-0000-4000-8000-000000000003", text: "Only Maya Collins can do Audit & proposal." },
};

/** The demo's analysis of a process, or null for the processes the demo has no AI text for. */
export function demoAiView(processId: string): AiAnalysisView | null {
  if (processId !== NORTHBEAM_PROCESS_ID) return null;
  return {
    status: "ok",
    reason: null,
    trigger: "publish",
    summary: [...DEMO_AI_OUTPUT.read],
    insights: DEMO_AI_OUTPUT.insights.map(({ facts, ...i }, n): AiInsight => ({ ...i, key: KEYS[n]!, facts: facts.map((id) => FACTS[id]!) })),
    review: DEMO_AI_OUTPUT.review.map((r): AiReviewFinding => ({ ...r })),
    checked: 22,
    dropped: 0,
    model: null,
    at: "2026-09-30T09:00:00.000Z",
    revisionId: "demo",
  };
}
