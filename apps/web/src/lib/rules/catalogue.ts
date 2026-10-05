// How each analysis rule reads: its plain name, the number it measures, how the cost per month is worked out, and a plain
// description with an example. Since B17 (D40) the rules give the facts a page shows as evidence, at their documented
// default cut-offs (docs/analysis-rules.md); the editor that changed them is gone. Wording follows the prototype
// (apps/web/prototype/app-flow.html, RULE_DEFS and HELP). The rules themselves and their defaults are in the engine
// (packages/engine/src/analysis-settings.ts). Pure.

import { ANALYSIS_RULE_IDS, type AnalysisRuleId } from "@transpera-flow/engine";

export interface RuleUi {
  id: AnalysisRuleId;
  /** The prototype's plain name. */
  name: string;
  /** The number it rates, in plain words. */
  rates: string;
  /** How the cost per month is worked out. */
  cost: string;
  /** Plain-English description and an example, for the (i). */
  help: { description: string; example: string };
}

const UI: Record<AnalysisRuleId, Omit<RuleUi, "id">> = {
  busy: {
    name: "Too busy",
    rates: "How full someone's week is",
    cost: "Extra wins one more person would bring × value of a loss, plus overtime",
    help: {
      description: "How full someone's week is. Too full, and work starts to pile up.",
      example: "Maya is busy 82% of her week. In a bad month it's 97%. That's too full.",
    },
  },
  spare: {
    name: "Spare time",
    rates: "How empty someone's week is",
    cost: "Idle hours × cost rate",
    help: {
      description: "Someone has lots of free time. They could help a busier person.",
      example: "Sales is only busy 12% of the week. They could take some work off Maya.",
    },
  },
  overtime: {
    name: "Overtime",
    rates: "How much of the overtime limit is used",
    cost: "Overtime hours × cost rate",
    help: {
      description: "Extra hours people work to keep up. It is rated on how much of the overtime limit (Settings → Company) they use.",
      example: "Nina works 3 extra hours a week to keep up with her clients.",
    },
  },
  queue: {
    name: "Work piling up",
    rates: "How fast the pile grows each week",
    cost: "Value of the work stuck in the queue",
    help: {
      description: "Work comes in faster than it gets done, so the pile keeps getting bigger.",
      example: "Each week, one more report is waiting for review than the week before.",
    },
  },
  wait: {
    name: "Waiting too long",
    rates: "Wait compared with the expected wait",
    cost: "Deals lost through the step's drop-off per day of waiting",
    help: {
      description: "How long work sits before someone starts it, compared with how long it should sit.",
      example: "New leads should get a reply in 4 hours. They wait 20 hours.",
    },
  },
  rework: {
    name: "Rework",
    rates: "Share of work done twice",
    cost: "Repeated hours × cost rate",
    help: { description: "How often work has to be done again.", example: "8 out of every 100 proposals have to be redone." },
  },
  sla: {
    name: "Missed deadlines",
    rates: "Share of deadlines missed",
    cost: "Churned revenue through the churn drivers",
    help: { description: "How often you miss a deadline you promised.", example: "Reports are promised by the 5th working day. 14 in 100 are late." },
  },
  spof: {
    name: "Only one person can do it",
    rates: "Work lost, and weeks to catch up, when they're away",
    cost: "Damage of one absence × absences a year ÷ 12",
    help: {
      description: "Only one person can do a job. What happens if they're away for 2 weeks?",
      example: "If Maya is away, a quarter of proposals stop, and it takes 5 weeks to catch up.",
    },
  },
  health: {
    name: "Client health",
    rates: "Client group score, 0 to 100",
    cost: "Churned clients × value of a loss",
    help: {
      description: "A score from 0 to 100 for how happy a group of clients is. Late work makes it drop.",
      example: "PPC clients score 61 because their reports are often late.",
    },
  },
  driver: {
    name: "Cause of clients leaving",
    rates: "Share of lost clients it causes",
    cost: "That driver's share of churned revenue",
    help: { description: "What's causing clients to leave.", example: "Late reports cause 41 out of every 100 clients who leave." },
  },
  success: {
    name: "Goals met",
    rates: "How often the goal is met",
    cost: "Depends on the measure",
    help: {
      description: "Checks the goals you set for a process. How often are they met?",
      example: "“Send proposals within 3 days” happens 58 times out of 100.",
    },
  },
  dropoff: {
    name: "Work lost at a step",
    rates: "Work lost compared with your normal",
    cost: "Lost items × value of a loss",
    help: {
      description: "How much work is lost at a step, compared with what's normal for you.",
      example: "Normally 60 in 100 prospects say no. Right now it's 68.",
    },
  },
  cycle: {
    name: "Too slow overall",
    rates: "Start-to-finish time compared with the target",
    cost: "Revenue delayed",
    help: {
      description: "How long a process takes from start to finish, compared with your target.",
      example: "You want new clients signed in 10 days. It takes 12.",
    },
  },
  sources: {
    name: "Numbers don't match",
    rates: "How far apart the two numbers are",
    cost: "None: a data-quality finding",
    help: {
      description: "Two people or records give very different numbers for the same thing.",
      example: "Tom says checking a lead takes 10 minutes. The CRM says 25.",
    },
  },
  broken: {
    name: "Broken solution",
    rates: "Solution uses a step that's gone",
    cost: "None: a data-quality finding",
    help: {
      description: "A saved solution uses a step that has since been changed or deleted.",
      example: "A solution changes “Qualify lead”, but that step was renamed later.",
    },
  },
};

export const RULES_UI: Record<AnalysisRuleId, RuleUi> = Object.fromEntries(
  ANALYSIS_RULE_IDS.map((id) => [id, { id, ...UI[id] }]),
) as Record<AnalysisRuleId, RuleUi>;
