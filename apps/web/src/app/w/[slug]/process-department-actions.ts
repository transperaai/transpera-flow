"use server";

import { isId } from "@/lib/editor/validate";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { saveFields } from "@/lib/fields/server";
import { getSessionUser } from "@/lib/auth/session";
import { WHOLE_BUSINESS_CHOICE } from "@/lib/process-page/department";

// A process's department from its page (Q4): the Owner and Agency admins choose one of the workspace's departments or "Sales and whole
// business"; clearing it goes back to the worked-out one. An ordinary update of `processes` through the compare-and-set `save_fields`,
// as the signed-in user, so row-level security decides who may (a Viewer can't). Both columns are saved together, each checked against
// its own base.

const invalid = { status: "error", message: "That value isn't valid." } as const;
const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;

type Choice = string | null;

/** The two columns a choice is stored as: a department id, whole business, or neither (worked out). */
function columns(choice: Choice): { department_id: string | null; whole_business: boolean } {
  return { department_id: choice && choice !== WHOLE_BUSINESS_CHOICE ? choice : null, whole_business: choice === WHOLE_BUSINESS_CHOICE };
}

const valid = (v: unknown): v is Choice => v === null || v === WHOLE_BUSINESS_CHOICE || isId(v);

export async function saveProcessDepartment(processId: string, base: Choice, value: Choice): Promise<SaveOutcome<Choice>> {
  if (!isId(processId) || !valid(base) || !valid(value)) return invalid;
  if (!(await getSessionUser())) return signedOut;
  const out = await saveFields("processes", { id: processId }, columns(base), columns(value));
  if (out.status === "saved") return { status: "saved", value };
  if (out.status === "conflict") {
    const t = out.theirs;
    const theirs = t.whole_business === true ? WHOLE_BUSINESS_CHOICE : typeof t.department_id === "string" ? t.department_id : null;
    // Only one of the two may have moved; the stored pair is unknown if just one is reported, so ask the person to reload their choice.
    return { status: "conflict", theirs: "department_id" in t || "whole_business" in t ? theirs : null };
  }
  if (out.status === "not_found") return { status: "not_found" };
  return out;
}
