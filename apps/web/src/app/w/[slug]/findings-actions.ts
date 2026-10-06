"use server";

import {
  createManualFinding,
  labelNames,
  loadTeam,
  nameFinding,
  nameLabels,
  readPersonLabels,
  setFindingStatus,
  updateFinding,
  type Db,
  type FindingDraft,
  type FindingRow,
  type FindingWrite,
} from "@transpera-flow/db";
import { createClient } from "@/lib/supabase/server";

// Findings (issue #175, B17): add one by hand, edit one, accept or dismiss one. As the signed-in user: RLS lets owners and
// editors write and nobody delete; the database stamps who and when.
//
// An AI finding is stored with labels ("Team member A") and a `person_labels` map; the editor sees names (B1 2b). So an
// edit turns the names back into labels before it is stored, and what comes back is named again for the editor.

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

/** The finding as the reader it is for sees it: its labels named. A failed read of the team leaves it with its labels, which never show a name. */
async function named(db: Db, row: FindingRow): Promise<FindingRow> {
  if (!Object.keys(readPersonLabels(row.person_labels)).length) return row;
  try {
    return nameFinding(row, await loadTeam(db, row.workspace_id));
  } catch {
    return nameFinding(row, { viewer: { seesEveryone: false, ownPersonId: null }, people: [] });
  }
}

export async function editFinding(id: string, draft: unknown, accept: boolean): Promise<FindingWrite> {
  const d = parseDraft(draft);
  if (typeof id !== "string" || !UUID.test(id) || !d) return invalid;
  const db = await createClient();
  // What is stored, and who the labels stand for.
  const { data: row } = await db.from("findings").select("workspace_id, title, evidence, why, person_labels").eq("id", id).maybeSingle();
  const labels = readPersonLabels(row?.person_labels);
  let team: Awaited<ReturnType<typeof loadTeam>> | null = null;
  if (row && Object.keys(labels).length) {
    try {
      team = await loadTeam(db, row.workspace_id);
    } catch {
      return { status: "forbidden" };
    }
  }
  // The text the editor was shown, named; an unchanged field is stored exactly as it was (a label for someone since deleted
  // reads "A team member", which must not become the stored text), and a changed one has its names put back as labels.
  const store = (stored: string | undefined, sent: string): string => {
    if (!row || !team || stored === undefined) return sent;
    if (sent === nameLabels(stored, labels, team)) return stored;
    return labelNames(sent, labels, team.people);
  };
  const updated = await updateFinding(
    db,
    id,
    { ...d, title: store(row?.title, d.title), evidence: store(row?.evidence, d.evidence), why: store(row?.why, d.why) },
    accept ? "accepted" : undefined,
  );
  return updated.status === "saved" ? { status: "saved", finding: team ? nameFinding(updated.finding, team) : updated.finding } : updated;
}

export async function decideFinding(id: string, status: "accepted" | "dismissed"): Promise<FindingWrite> {
  if (typeof id !== "string" || !UUID.test(id) || (status !== "accepted" && status !== "dismissed")) return invalid;
  const db = await createClient();
  const decided = await setFindingStatus(db, id, status);
  return decided.status === "saved" ? { status: "saved", finding: await named(db, decided.finding) } : decided;
}
