// Process categories (capacity Q3, decision D41): what a process is for, in the words people use. The engine kind (pipeline or
// servicing) stays underneath and decides what the simulation does; the category is for people (the Processes page, the process page's
// About). Pure.

import type { RecurrenceJson } from "./types";

export const PROCESS_CATEGORIES = ["sales", "onboarding", "routine_client_work", "ad_hoc", "internal"] as const;
export type ProcessCategory = (typeof PROCESS_CATEGORIES)[number];

export const PROCESS_CATEGORY_LABELS: Record<ProcessCategory, string> = {
  sales: "Sales",
  onboarding: "Onboarding",
  routine_client_work: "Routine client work",
  ad_hoc: "Ad hoc",
  internal: "Internal",
};

/** One short line for each category: the Processes page's help. */
export const PROCESS_CATEGORY_HELP: Record<ProcessCategory, string> = {
  sales: "How new work comes in and is won.",
  onboarding: "Getting a new client set up, once per client.",
  routine_client_work: "Work done again and again for existing clients, like a monthly report.",
  ad_hoc: "Requests that come in at random, with no fixed schedule.",
  internal: "Work for the agency itself, not for a client.",
};

export const isProcessCategory = (v: unknown): v is ProcessCategory => typeof v === "string" && (PROCESS_CATEGORIES as readonly string[]).includes(v);

/** A recurrence that is requests at random: the ad-hoc driver or a Poisson rate. */
export const isAdHocRecurrence = (r: RecurrenceJson | null | undefined): boolean => !!r && ("poisson_per_month" in r || ("driver" in r && r.driver === "adhoc"));

/**
 * The category a new process gets when none is chosen: from its kind, as the migration backfills it. A pipeline is Sales; a servicing
 * process is Routine client work, or Ad hoc when its links to services use the ad-hoc driver or a Poisson recurrence (`links`).
 */
export function defaultProcessCategory(kind: "pipeline" | "servicing", links: readonly { recurrence: RecurrenceJson }[] = []): ProcessCategory {
  if (kind === "pipeline") return "sales";
  return links.some((l) => isAdHocRecurrence(l.recurrence)) ? "ad_hoc" : "routine_client_work";
}

/**
 * The engine kind a category runs as (D52): Sales and Onboarding are pipelines (an onboarding pipeline runs when the company map hands
 * won clients to it); Routine client work, Ad hoc and Internal are servicing.
 */
export function kindForCategory(category: ProcessCategory): "pipeline" | "servicing" {
  return category === "sales" || category === "onboarding" ? "pipeline" : "servicing";
}
