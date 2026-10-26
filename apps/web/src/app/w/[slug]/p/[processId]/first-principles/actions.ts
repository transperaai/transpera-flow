"use server";

import { normalizeFirstPrinciples } from "@transpera-flow/engine";
import { saveFirstPrinciples } from "@transpera-flow/db";
import { rpc } from "@transpera-flow/db/client";
import type { FpSaveResult } from "@/lib/first-principles/types";
import { getDb, getSessionUser } from "@/lib/auth/session";

// Saves a process's first principles (issue #119, A54). Runs as the signed-in user through RLS: owners and editors
// write, everyone else is refused. The answers go into the process's draft, which this opens if there isn't one
// (like every edit, docs/adr/0004-drafts-as-revisions.md); the live version is never changed, and the database
// refuses it too. The answers are cleaned first, so a hand-made request can't store anything the flow wouldn't.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function saveFirstPrinciplesAction(
  workspaceId: string,
  processId: string,
  input: unknown,
  version: string | null,
  revisionId: string | null,
): Promise<FpSaveResult> {
  if (!UUID.test(workspaceId) || !UUID.test(processId) || !(version === null || typeof version === "string") || !(revisionId === null || UUID.test(revisionId))) {
    return { status: "error", message: "That isn't valid." };
  }
  if (!(await getSessionUser())) return { status: "error", message: "Your session has ended. Sign in again." };
  const db = await getDb();

  let opened;
  try {
    opened = await rpc(db, "open_draft", { target_process: processId });
  } catch {
    return { status: "error", message: "Couldn't open a draft to save into. Try again." };
  }
  const draft = opened as unknown as { status: string; revision_id?: string };
  // open_draft locks the process for update, so one the user may read but not edit is not found.
  if (draft.status !== "ok" || !draft.revision_id) return { status: "error", message: "Only owners and editors can change first principles." };
  const draftId = draft.revision_id;
  // The draft the flow was editing is gone (published or discarded) and this is a newer one: its version means nothing here.
  if (revisionId !== null && revisionId !== draftId) return { status: "stale" };
  // No draft when the page loaded, so there was no row of the draft's own to have a version of.
  const base = revisionId === null ? null : version;

  const outcome = await saveFirstPrinciples(db, { workspaceId, processId, revisionId: draftId }, normalizeFirstPrinciples(input), base);
  switch (outcome.status) {
    case "saved":
      return { status: "saved", version: outcome.version, revisionId: draftId };
    case "conflict":
      return { status: "conflict", doc: outcome.doc, version: outcome.version, revisionId: draftId };
    case "forbidden":
      return { status: "error", message: "Only owners and editors can change first principles." };
    case "not_draft":
      return { status: "stale" };
    case "invalid":
    case "error":
      return { status: "error", message: outcome.message };
  }
}
