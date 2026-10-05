"use server";

import { createManualFinding, setFindingStatus, updateFinding, type FindingDraft, type FindingWrite } from "@transpera-flow/db";
import { createClient } from "@/lib/supabase/server";

// Findings (issue #175, B17): add one by hand, edit one, accept or dismiss one. As the signed-in user: RLS lets owners and
// editors write and nobody delete; the database stamps who and when.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nullableId = (v: unknown) => v === null || (typeof v === "string" && UUID.test(v));

/** A draft as the client sent it, checked for shape (the database checks the values). */
function parseDraft(d: unknown): FindingDraft | null {
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  if (!nullableId(o.processId) || !nullableId(o.stepId)) return null;
  if (typeof o.title !== "string" || typeof o.evidence !== "string" || typeof o.why !== "string" || typeof o.rating !== "string" || typeof o.type !== "string") return null;
  const sourceIds = Array.isArray(o.sourceIds) ? o.sourceIds : [];
  if (!sourceIds.every((s) => typeof s === "string" && UUID.test(s))) return null;
  return {
    processId: o.processId as string | null,
    stepId: o.stepId as string | null,
    rating: o.rating as FindingDraft["rating"],
    type: o.type as FindingDraft["type"],
    title: o.title,
    evidence: o.evidence,
    why: o.why,
    sourceIds: sourceIds as string[],
  };
}

const invalid: FindingWrite = { status: "invalid", message: "That isn't valid." };

export async function createFinding(workspaceId: string, draft: unknown): Promise<FindingWrite> {
  const d = parseDraft(draft);
  if (typeof workspaceId !== "string" || !UUID.test(workspaceId) || !d) return invalid;
  return createManualFinding(await createClient(), workspaceId, d);
}

export async function editFinding(id: string, draft: unknown, accept: boolean): Promise<FindingWrite> {
  const d = parseDraft(draft);
  if (typeof id !== "string" || !UUID.test(id) || !d) return invalid;
  return updateFinding(await createClient(), id, d, accept ? "accepted" : undefined);
}

export async function decideFinding(id: string, status: "accepted" | "dismissed"): Promise<FindingWrite> {
  if (typeof id !== "string" || !UUID.test(id) || (status !== "accepted" && status !== "dismissed")) return invalid;
  return setFindingStatus(await createClient(), id, status);
}
