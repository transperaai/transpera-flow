"use server";

import { saveFields } from "@/lib/fields/server";
import type { OpenResult, PublishResult } from "@/lib/drafts/session";
import type { UpdateResult, WriteResult } from "@/lib/editor/store";
import { parseFieldUpdate, parseIds, parseNewEdge, parseNewStep, isId } from "@/lib/editor/validate";
import { rpc } from "@transpera-flow/db/client";
import { pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

// Writes from the process editor (issue #8). Every write runs as the signed-in
// user through RLS; the checks in lib/editor/validate.ts only reject malformed
// input early. Field updates are per-field compare-and-set
// (docs/adr/0001-per-field-saves.md); creates and deletes are plain inserts and
// deletes. Nothing here refreshes the page: the editor already shows the edit.
// Edits go into the process's draft revision (issue #9): the editor opens it
// with openDraft before its first save, and publishDraft / discardDraft end it.

const invalid = { status: "error", message: "That change isn't valid." } as const;
const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const forbidden = { status: "error", message: "You don't have permission to edit this process." } as const;

const notDraft = {
  status: "error",
  message: "This draft was published or discarded by someone else. Reload to see the process as it is now.",
} as const;

/**
 * The revision if the signed-in user can edit it: its workspace and process
 * come from the database, not the client. Only drafts are editable (issue #9);
 * the database refuses the rest too.
 */
async function editableRevision(revisionId: string) {
  if (!(await getSessionUser())) return { ok: false, error: signedOut } as const;
  const db = await getDb();
  let revision;
  try {
    revision = await db.selectFrom("process_revisions").select(["id", "workspace_id", "process_id", "status"]).where("id", "=", revisionId).executeTakeFirst();
  } catch {
    return { ok: false, error: forbidden } as const;
  }
  // A discarded draft is gone.
  if (!revision) return { ok: false, error: notDraft } as const;
  const canEdit = await rpc(db, "can_edit_workspace", { ws: revision.workspace_id }).catch(() => null);
  if (canEdit !== true) return { ok: false, error: forbidden } as const;
  if (revision.status !== "draft") return { ok: false, error: notDraft } as const;
  return { ok: true, db, revision } as const;
}

const failure = (e: unknown): WriteResult =>
  pgCode(e) === "42501"
    ? forbidden
    : pgCode(e) === "55000"
      ? notDraft
      : pgCode(e) === "23514"
        ? { status: "error", message: "Some of those values aren't allowed." }
        : pgCode(e) === "23503"
          ? { status: "error", message: "That refers to something that no longer exists." }
          : { status: "error", message: "Couldn't save. Try again." };

/** The signed-in user's client, or the reason there is none. */
async function signedIn() {
  return (await getSessionUser()) ? ({ ok: true, db: await getDb() } as const) : ({ ok: false, error: signedOut } as const);
}

type Reply = { status: string; revision_id?: string; number?: number; created?: boolean; steps?: { id: string; name: string }[] };

/** Open the process's draft (a copy of live with the same ids), or continue the one that is open. */
export async function openDraft(processId: string): Promise<OpenResult> {
  if (!isId(processId)) return invalid;
  const session = await signedIn();
  if (!session.ok) return session.error;
  let data;
  try {
    data = await rpc(session.db, "open_draft", { target_process: processId });
  } catch (e) {
    return failure(e) as OpenResult;
  }
  const r = data as Reply;
  if (r.status !== "ok") return forbidden;
  return { status: "ok", revision: { id: r.revision_id!, number: r.number! }, created: r.created === true };
}

/** Throw the process's draft away. */
export async function discardDraft(processId: string): Promise<WriteResult> {
  if (!isId(processId)) return invalid;
  const session = await signedIn();
  if (!session.ok) return session.error;
  let data;
  try {
    data = await rpc(session.db, "discard_draft", { target_process: processId });
  } catch (e) {
    return failure(e);
  }
  const r = data as Reply;
  return r.status === "not_found" ? forbidden : { status: "ok" };
}

/**
 * Make the draft live. Refused while steps are unconfirmed estimates unless
 * `acceptEstimates`; the choice is written to the audit log.
 */
export async function publishDraft(processId: string, acceptEstimates: unknown): Promise<PublishResult> {
  if (!isId(processId) || typeof acceptEstimates !== "boolean") return invalid;
  const session = await signedIn();
  if (!session.ok) return session.error;
  let data;
  try {
    data = await rpc(session.db, "publish_process", { target_process: processId, accept_estimates: acceptEstimates });
  } catch (e) {
    return failure(e) as PublishResult;
  }
  const r = data as Reply;
  if (r.status === "published") {
    return { status: "published", revision: { id: r.revision_id!, number: r.number! } };
  }
  if (r.status === "unresolved") return { status: "unresolved", steps: (r.steps ?? []).map((s) => ({ id: s.id, name: s.name })) };
  if (r.status === "no_draft") return notDraft;
  return forbidden;
}

/** Save fields of one step or edge if each is still what the editor last saw. */
export async function saveProcessFields(
  revisionId: string,
  table: unknown,
  id: string,
  base: unknown,
  changes: unknown,
): Promise<UpdateResult> {
  const parsed = parseFieldUpdate(table, base, changes);
  if (!isId(revisionId) || !isId(id) || !parsed) return invalid;
  const access = await editableRevision(revisionId);
  if (!access.ok) return access.error;
  return saveFields(parsed.table, { revision_id: revisionId, id }, parsed.base, parsed.changes);
}

/** Insert new (or restored) steps, then edges, into the revision. */
export async function insertProcessRows(revisionId: string, steps: unknown, edges: unknown): Promise<WriteResult> {
  if (!isId(revisionId) || !Array.isArray(steps) || !Array.isArray(edges) || steps.length + edges.length > 500) return invalid;
  const newSteps = steps.map(parseNewStep);
  const newEdges = edges.map(parseNewEdge);
  if (newSteps.some((s) => !s) || newEdges.some((e) => !e)) return invalid;
  const access = await editableRevision(revisionId);
  if (!access.ok) return access.error;
  const { db, revision } = access;
  const owner = { revision_id: revision.id, workspace_id: revision.workspace_id, process_id: revision.process_id };
  if (newSteps.length) {
    try {
      await db.insertInto("steps").values(newSteps.map((s) => ({ ...s!, ...owner }))).execute();
    } catch (e) {
      return failure(e);
    }
  }
  if (newEdges.length) {
    try {
      await db.insertInto("edges").values(newEdges.map((e) => ({ ...e!, ...owner }))).execute();
    } catch (e) {
      return failure(e);
    }
  }
  return { status: "ok" };
}

/** Delete edges, then steps (whose remaining edges go with them). Rows already gone are fine. */
export async function deleteProcessRows(revisionId: string, stepIds: unknown, edgeIds: unknown): Promise<WriteResult> {
  const steps = parseIds(stepIds);
  const edges = parseIds(edgeIds);
  if (!isId(revisionId) || !steps || !edges) return invalid;
  const access = await editableRevision(revisionId);
  if (!access.ok) return access.error;
  const { db } = access;
  if (edges.length) {
    try {
      await db.deleteFrom("edges").where("revision_id", "=", revisionId).where("id", "in", edges).execute();
    } catch (e) {
      return failure(e);
    }
  }
  if (steps.length) {
    try {
      await db.deleteFrom("steps").where("revision_id", "=", revisionId).where("id", "in", steps).execute();
    } catch (e) {
      return failure(e);
    }
  }
  return { status: "ok" };
}
