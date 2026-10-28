// The template library (docs/PRD.md §4.1 "template library", §7.1
// `list_templates` / `create_from_template`). Built in for now: each template
// is an `import_process` graph, so creating from one is an import into a new
// draft. Every number in a template is generic, so each is marked an
// assumption (with the template named as its reasoning) for the consultant
// to confirm against the client's reality. Roles are left open: templates
// can't know a workspace's roles.

import type { ImportEdge, ImportStep } from "./building";

export interface ProcessTemplate {
  id: string;
  name: string;
  industry: string;
  kind: "pipeline" | "servicing";
  entity_name: string;
  description: string;
  steps: ImportStep[];
  edges: ImportEdge[];
}

const why = (text: string) => ({ work_hours: text, wait_hours: text, rework_rate: text });

export const PROCESS_TEMPLATES: readonly ProcessTemplate[] = [
  {
    id: "agency-sales-pipeline",
    name: "Agency sales pipeline",
    industry: "Marketing and creative agencies",
    kind: "pipeline",
    entity_name: "lead",
    description: "From a qualified enquiry to a signed retainer or a lost deal: discovery, audit and proposal, then the decision.",
    steps: [
      { name: "Enquiry", kind: "start" },
      { name: "Qualify enquiry", kind: "task", work_hours: 0.5, wait_hours: 8, rework_rate: 0, reasoning: why("Typical triage time for an agency enquiry.") },
      { name: "Discovery call", kind: "task", work_hours: 1.5, wait_hours: 48, rework_rate: 0, reasoning: why("An hour's call plus notes; a couple of days to book it.") },
      { name: "Audit & proposal", kind: "task", work_hours: 6, wait_hours: 24, rework_rate: 0.15, reasoning: why("A day's work; about one proposal in seven is sent back for changes.") },
      { name: "Client decision", kind: "decision" },
      { name: "Won", kind: "end", outcome: "won" },
      { name: "Lost", kind: "end", outcome: "lost" },
    ],
    edges: [
      { from: "Enquiry", to: "Qualify enquiry" },
      { from: "Qualify enquiry", to: "Discovery call", probability: 0.7 },
      { from: "Qualify enquiry", to: "Lost", probability: 0.3 },
      { from: "Discovery call", to: "Audit & proposal" },
      { from: "Audit & proposal", to: "Client decision" },
      { from: "Client decision", to: "Won", probability: 0.4 },
      { from: "Client decision", to: "Lost", probability: 0.6 },
    ],
  },
  {
    id: "client-onboarding",
    name: "Client onboarding",
    industry: "Service businesses",
    kind: "servicing",
    entity_name: "new client",
    description: "From a signed contract to the first delivered piece of work: kickoff, access and setup, first deliverable.",
    steps: [
      { name: "Contract signed", kind: "start" },
      { name: "Kickoff meeting", kind: "task", work_hours: 3, wait_hours: 40, rework_rate: 0, reasoning: why("Prep, a two-hour meeting and the write-up; a week to find a slot.") },
      { name: "Access and setup", kind: "task", work_hours: 2, wait_hours: 24, rework_rate: 0.2, reasoning: why("Chasing logins and permissions; one in five needs a second round.") },
      { name: "First deliverable", kind: "task", work_hours: 8, wait_hours: 16, rework_rate: 0.1, reasoning: why("A day's work on the first piece, with client review.") },
      { name: "Onboarded", kind: "end", outcome: "done" },
    ],
    edges: [
      { from: "Contract signed", to: "Kickoff meeting" },
      { from: "Kickoff meeting", to: "Access and setup" },
      { from: "Access and setup", to: "First deliverable" },
      { from: "First deliverable", to: "Onboarded" },
    ],
  },
  {
    id: "monthly-reporting",
    name: "Monthly client reporting",
    industry: "Service businesses",
    kind: "servicing",
    entity_name: "report",
    description: "The recurring monthly report: gather the data, draft it, review it, send it.",
    steps: [
      { name: "Month closes", kind: "start" },
      { name: "Gather data", kind: "task", work_hours: 1.5, wait_hours: 8, rework_rate: 0, reasoning: why("Exports from the usual tools.") },
      { name: "Draft report", kind: "task", work_hours: 2, wait_hours: 8, rework_rate: 0, reasoning: why("Charts and commentary for one client.") },
      { name: "Internal review", kind: "task", work_hours: 0.5, wait_hours: 16, rework_rate: 0.2, reasoning: why("A lead's check; one in five goes back for fixes.") },
      { name: "Send to client", kind: "task", work_hours: 0.25, wait_hours: 0, rework_rate: 0, reasoning: why("Email with a short summary.") },
      { name: "Report sent", kind: "end", outcome: "done" },
    ],
    edges: [
      { from: "Month closes", to: "Gather data" },
      { from: "Gather data", to: "Draft report" },
      { from: "Draft report", to: "Internal review" },
      { from: "Internal review", to: "Send to client" },
      { from: "Send to client", to: "Report sent" },
    ],
  },
];
