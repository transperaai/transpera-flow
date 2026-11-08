// What a step achieves (sandbox G, phase 4; docs/plans/sandbox-p4-brief.md). A step's `purpose` is a key of the workspace's
// category list (`workspaces.settings.purposes`); null means Automatic, worked out each time by `resolvePurpose`. The engine only
// ever sees the key (EngineStep.purpose); the names live here.

import type { WorkspaceSettings } from "./types";

export interface PurposeCategory {
  key: string;
  name: string;
  description: string;
}

/** A category key: the seven defaults, or c + 8 lower-case hex for one the workspace added. */
export const PURPOSE_KEY = /^(client_job|client_upkeep|required|winning|coordination|fixing|removable|c[0-9a-f]{8})$/;
/** What a step may choose (`steps_purpose_key`): client upkeep is for client hours not drawn as steps, not for a step. */
export const STEP_PURPOSE_KEY = /^(client_job|required|winning|coordination|fixing|removable|c[0-9a-f]{8})$/;
/** Can be renamed, described and moved; never deleted: the Automatic rules, rework and client hours need them. */
export const FIXED_PURPOSES = ["client_job", "client_upkeep", "winning", "fixing", "removable"] as const;
/** Ongoing client hours that are not steps (roles' hours per client, a service's fallback load): their own fixed row. */
export const UPKEEP_PURPOSE = "client_upkeep";
export const FIXING_PURPOSE = "fixing";
export const CLIENT_JOB_PURPOSE = "client_job";

export const DEFAULT_PURPOSES: readonly PurposeCategory[] = [
  { key: "client_job", name: "Moves the client's job forward", description: "The work the client pays for." },
  { key: "client_upkeep", name: "Client upkeep", description: "Ongoing client hours that are not steps." },
  { key: "required", name: "Required", description: "Compliance and admin that must be done." },
  { key: "winning", name: "Winning work", description: "Sales and onboarding." },
  { key: "coordination", name: "Coordination", description: "Hand-offs, meetings and chasing." },
  { key: "fixing", name: "Fixing", description: "Rework and corrections." },
  { key: "removable", name: "Could be removed", description: "Steps that could be dropped." },
];
export const MIN_PURPOSES = 5;
export const MAX_PURPOSES = 12;
export const MAX_PURPOSE_NAME = 60;
export const MAX_PURPOSE_DESCRIPTION = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** As the database measures and trims (`char_length`, `btrim`): characters (code points, so an emoji is one), and spaces only. */
const chars = (s: string) => [...s].length;
const trimSpaces = (s: string) => s.replace(/^ +| +$/g, "");

/** The save's check, mirroring `private.is_purpose_list` exactly (one table of cases runs through both). */
export function parsePurposes(input: unknown): { ok: true; purposes: PurposeCategory[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "The categories must be a list." };
  if (input.length < MIN_PURPOSES || input.length > MAX_PURPOSES) return { ok: false, error: `There must be ${MIN_PURPOSES} to ${MAX_PURPOSES} categories.` };
  const out: PurposeCategory[] = [];
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const e of input) {
    if (!isObj(e) || Object.keys(e).some((k) => k !== "key" && k !== "name" && k !== "description")) return { ok: false, error: "Each category has a key, a name and a description." };
    if (typeof e.key !== "string" || typeof e.name !== "string" || (e.description !== undefined && typeof e.description !== "string")) return { ok: false, error: "Each category has a key, a name and a description." };
    if (!PURPOSE_KEY.test(e.key)) return { ok: false, error: "A category has a key that is not allowed." };
    const name = trimSpaces(e.name);
    if (chars(name) < 1 || chars(name) > MAX_PURPOSE_NAME) return { ok: false, error: `A category name is 1 to ${MAX_PURPOSE_NAME} characters.` };
    const description = trimSpaces(e.description ?? "");
    if (chars(description) > MAX_PURPOSE_DESCRIPTION) return { ok: false, error: `A description is at most ${MAX_PURPOSE_DESCRIPTION} characters.` };
    if (keys.has(e.key)) return { ok: false, error: "Two categories have the same key." };
    if (names.has(name.toLowerCase())) return { ok: false, error: `Two categories are called "${name}".` };
    keys.add(e.key);
    names.add(name.toLowerCase());
    out.push({ key: e.key, name, description });
  }
  const missing = FIXED_PURPOSES.find((k) => !keys.has(k));
  if (missing) return { ok: false, error: `The category "${DEFAULT_PURPOSES.find((d) => d.key === missing)!.name}" can be renamed and moved, but not removed.` };
  return { ok: true, purposes: out };
}

/** The stored list, or the defaults when absent, null or (defensively) invalid. */
export function workspacePurposes(settings: Pick<WorkspaceSettings, "purposes"> | null | undefined): PurposeCategory[] {
  const stored = settings?.purposes;
  if (stored === undefined || stored === null) return DEFAULT_PURPOSES.map((p) => ({ ...p }));
  const parsed = parsePurposes(stored);
  return parsed.ok ? parsed.purposes : DEFAULT_PURPOSES.map((p) => ({ ...p }));
}

/** A new category's key: "c" + 8 hex from crypto.getRandomValues, drawn again on a clash. */
export function newPurposeKey(existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const key = `c${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    if (!taken.has(key)) return key;
  }
}

export type PurposeSource = "chosen" | "process_kind" | "deleted_category";

/**
 * A step's purpose (Austin, 29 Oct): its own key when it is in the list; else by where it sits: client work moves the client's job forward, and
 * so does a pipeline step after the sale (`afterSale`: every step after the deciding step on the won path; Austin, 30 Oct: the
 * deciding step itself counts as winning work, like every step before it). A stored key the list no longer has reads as Automatic (`deleted_category`).
 */
export function resolvePurpose(
  step: { id: string; purpose: string | null },
  processKind: string,
  keys: ReadonlySet<string>,
  afterSale = false,
): { key: string; source: PurposeSource } {
  const stored = step.purpose;
  if (stored !== null && stored !== undefined && stored !== UPKEEP_PURPOSE && keys.has(stored)) return { key: stored, source: "chosen" };
  const gone = stored !== null && stored !== undefined;
  const key = processKind === "servicing" || afterSale ? CLIENT_JOB_PURPOSE : "winning";
  return { key, source: gone ? "deleted_category" : "process_kind" };
}
