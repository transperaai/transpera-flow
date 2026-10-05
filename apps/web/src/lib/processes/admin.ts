// Process admin on the Processes page (issue #182, B19 2/2; ADR 0014 "B19: archiving a process"): the words for each kind, what
// changing the kind does to the simulation, and the results the server actions give back. Pure, so the page, its tests and the
// server actions say the same thing.

export type ProcessKind = "pipeline" | "servicing";

export const PROCESS_KIND_LABELS: Record<ProcessKind, string> = { pipeline: "Sales pipeline", servicing: "Client work" };

/** The choices in "New process" and "Change type". */
export const PROCESS_KIND_CHOICES: readonly { value: ProcessKind; label: string; description: string }[] = [
  { value: "pipeline", label: PROCESS_KIND_LABELS.pipeline, description: "How new work comes in: leads arrive from Demand, and some are won." },
  { value: "servicing", label: PROCESS_KIND_LABELS.servicing, description: "Work done again and again for existing clients, such as a monthly report." },
];

/** What changes for the simulation when a process becomes `to`: the warning "Change type" shows before it saves. */
export function kindChangeWarning(name: string, to: ProcessKind): string[] {
  return to === "servicing"
    ? [
        `Leads stop arriving at ${name}: Demand no longer feeds it.`,
        `It only runs once a service is linked to it (Settings, Services), once per client, and its work competes with the pipeline for the same people.`,
        "Its card moves to the client work column of the company map. Its steps, versions and issues stay as they are.",
      ]
    : [
        `Leads start arriving at ${name} from Demand, and revenue is booked when one reaches a Won end. Check its first step and its ends.`,
        "It no longer runs per client for the services that used to generate it.",
        "Its card moves to the pipeline column of the company map. Its steps, versions and issues stay as they are.",
      ];
}

/** What archiving does, in the confirm. */
export const ARCHIVE_EXPLAINED =
  "It leaves the company map, the lists and the simulation. Nothing is deleted: its versions, history, issues and sources are kept, and you can restore it from Processes, Archived.";

export type ProcessAdminResult = { status: "ok" } | { status: "error"; message: string };

/** The Processes page's admin actions (server actions bound to the workspace; stand-ins in tests). */
export interface ProcessAdminOps {
  rename(processId: string, name: string): Promise<ProcessAdminResult>;
  changeKind(processId: string, kind: ProcessKind): Promise<ProcessAdminResult>;
  archive(processId: string): Promise<ProcessAdminResult>;
  restore(processId: string): Promise<ProcessAdminResult>;
}

/** An archived process as the Archived filter lists it. */
export interface ArchivedProcess {
  id: string;
  name: string;
  kind: ProcessKind;
  /** When it was archived (an ISO timestamp). */
  archivedAt: string;
}

export const MAX_PROCESS_NAME = 120;

/** A name as it will be saved, or an error to show. */
export function cleanProcessName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > MAX_PROCESS_NAME) return { ok: false, error: `Give it a name (up to ${MAX_PROCESS_NAME} characters).` };
  return { ok: true, name };
}
