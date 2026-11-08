"use server";

import { refresh } from "next/cache";
import { isId } from "@/lib/editor/validate";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { saveFields } from "@/lib/fields/server";
import { getSessionUser } from "@/lib/auth/session";

// A process's notes, from the Sources section of its page (migration 20270202000000). An ordinary update of `processes.notes` through the
// compare-and-set `save_fields`, as the signed-in user, so row-level security decides who may (a Viewer can't) and a stale base is a
// conflict. Not versioned: the notes sit on the process, not on a version.

const MAX_PROCESS_NOTES = 4000;

const invalid = { status: "error", message: "That value isn't valid." } as const;
const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;

/** Trimmed; empty is null (no notes). */
function clean(v: string | null): string | null {
  const t = v?.trim() ?? "";
  return t === "" ? null : t;
}

export async function saveProcessNotes(processId: string, base: string | null, value: string | null): Promise<SaveOutcome<string | null>> {
  if (!isId(processId) || (base !== null && typeof base !== "string") || (value !== null && typeof value !== "string")) return invalid;
  const next = clean(value);
  if (next !== null && next.length > MAX_PROCESS_NOTES) return { status: "error", message: "Keep the notes to 4,000 characters." };
  if (!(await getSessionUser())) return signedOut;
  // The base is compared as stored (not trimmed): it is what the page loaded.
  const out = await saveFields("processes", { id: processId }, { notes: base }, { notes: next });
  if (out.status === "saved") return { status: "saved", value: next };
  if (out.status === "conflict") {
    const theirs = out.theirs.notes;
    return { status: "conflict", theirs: typeof theirs === "string" ? theirs : null };
  }
  if (out.status === "not_found") return { status: "not_found" };
  return out;
}

/**
 * The process page's notes field, bound to the process and the notes it loaded: a sentence when the save failed, null when it saved.
 * A save refreshes the page, so the next edit's base is what was just saved.
 */
export async function saveProcessNotesFromPage(processId: string, base: string | null, value: string): Promise<string | null> {
  const out = await saveProcessNotes(processId, base, value);
  switch (out.status) {
    case "saved":
      refresh();
      return null;
    case "conflict":
      return "Someone else changed these notes since you opened the page. Reload to see theirs, then make your change again.";
    case "not_found":
      return "You can't change this process's notes, or it isn't there any more. Reload the page.";
    case "error":
      return out.message;
  }
}
