"use server";

import { ISSUE_STATUSES, loadIssue, loadIssueEvents, payFreeIssueFields, resolveIssue, saveIssue, storedStatus, uiStatus, type IssueEventRow, type IssueLinkRef, type IssueStatus, type Json, type StoredIssueStatus } from "@transpera-flow/db";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { saveField, saveFields } from "@/lib/fields/server";
import { ALREADY_RESOLVED, ALREADY_TRACKED, type RemoveIssueResult, type SaveIssueResult } from "@/lib/issues/store";
import { cleanFieldValue, isId, isIssueField, parseIssueInput, parsePromoteInput, parseResolveInput, parseSaveInput, type Scalar } from "@/lib/issues/validate";
import { sourcesRemovedBySave } from "@/lib/sources/links";
import { createClient } from "@/lib/supabase/server";

// Logging, tracking, editing and deleting issues (issue #17, reworked in #112). Every write runs
// as the signed-in user through RLS (editors, owners and agency admins may
// write; everyone in the workspace may read). The checks in
// lib/issues/validate.ts only reject malformed input early; the database
// checks every enumerated column too. An issue is created or edited through
// `public.save_issue`, which writes it with its links, owners and sources in one
// transaction (one history entry); single fields are per-field saves
// (docs/adr/0001-per-field-saves.md). Nothing here refreshes the page: the
// register already shows the change.

const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const forbidden = { status: "error", message: "You don't have permission to change issues here." } as const;
const invalid = { status: "error", message: "That issue isn't valid." } as const;

async function signedInClient() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return data?.claims?.sub ? supabase : null;
}

const failure = (error: { code?: string; message?: string }) =>
  error.code === "42501"
    ? forbidden
    : error.code === "23505"
      ? ({ status: "error", message: ALREADY_TRACKED } as const)
      : error.code === "23514"
        ? ({ status: "error", message: "Some of those values aren't allowed." } as const)
        : error.code === "22023" && /already resolved/.test(error.message ?? "")
          ? ({ status: "error", message: ALREADY_RESOLVED } as const)
        : error.code === "22023" && /not linked to this issue/.test(error.message ?? "")
          ? ({ status: "error", message: "That solution isn't linked to this issue. Pick one of the solutions listed." } as const)
        : error.code === "22023" && /can't be changed/.test(error.message ?? "")
          ? ({ status: "error", message: "The solution that fixed a resolved issue can't be changed. Reopen the issue first." } as const)
        : error.code === "22023" && /won't fix wasn't fixed/.test(error.message ?? "")
          ? ({ status: "error", message: "An issue marked Won't fix wasn't fixed by a solution." } as const)
        : error.code === "23503"
          ? ({ status: "error", message: "Something the issue links to no longer exists." } as const)
          : ({ status: "error", message: "Couldn't save. Try again." } as const);

/** What an old-style input says it touches, as links: its step, else its process. */
const linksOf = (row: { process_id?: string | null; step_id?: string | null }): IssueLinkRef[] =>
  row.step_id ? [{ process_id: row.process_id ?? null, step_id: row.step_id }] : row.process_id ? [{ process_id: row.process_id, step_id: null }] : [];

async function write(
  workspaceId: string,
  args: { id?: string; fields: Record<string, Json | undefined>; links?: IssueLinkRef[]; owners?: string[]; sources?: string[] },
): Promise<SaveIssueResult> {
  const supabase = await signedInClient();
  if (!supabase) return signedOut;
  // The issue's own list of sources before the save: the sources this save takes off it are the ones whose links go too (A53). A link
  // made elsewhere meanwhile (another tab, the MCP link_source) is not on that list and stays.
  const before =
    args.id && args.sources
      ? ((await supabase.from("issue_sources").select("source_id").eq("issue_id", args.id)).data ?? []).map((r) => r.source_id)
      : [];
  const saved = await saveIssue(supabase, { workspaceId, ...args });
  if ("error" in saved) return failure(saved.error);
  if (args.sources && args.id) {
    const removed = sourcesRemovedBySave(before, args.sources);
    if (removed.length) await supabase.from("source_links").delete().eq("kind", "issue").eq("issue_id", saved.id).in("source_id", removed);
  }
  const issue = await loadIssue(supabase, workspaceId, saved.id);
  return issue ? { status: "ok", issue } : forbidden;
}

/** Log an issue by hand (an audit finding). */
export async function createIssue(workspaceId: unknown, input: unknown): Promise<SaveIssueResult> {
  if (!isId(workspaceId)) return invalid;
  const parsed = parseIssueInput(input);
  if (!parsed.ok) return { status: "error", message: parsed.error };
  const { process_id, step_id, owner_person_id, ...fields } = parsed.value;
  return write(workspaceId, { fields: { ...fields, source: "manual" }, links: linksOf({ process_id, step_id }), owners: owner_person_id ? [owner_person_id] : [] });
}

/** Track a detected issue. Its key is unique per workspace, so tracking it twice is refused. */
export async function promoteIssue(workspaceId: unknown, input: unknown): Promise<SaveIssueResult> {
  if (!isId(workspaceId)) return invalid;
  const parsed = parsePromoteInput(input);
  if (!parsed.ok) return { status: "error", message: parsed.error };
  const { process_id, step_id, owner_person_id, evidence_metrics, ...rest } = parsed.value;
  // `dismissed_revision_id` is in `rest`: a dismissal is written with the revision it was made against.
  // What a browser tab that still runs the old engine sends carries the overtime money: the server strips it (B1 2b).
  return write(workspaceId, {
    fields: payFreeIssueFields({ ...rest, evidence_metrics: evidence_metrics as Json, source: "promoted", status: rest.status ?? "open" }),
    links: linksOf({ process_id, step_id }),
    owners: owner_person_id ? [owner_person_id] : [],
  });
}

/**
 * The Acknowledge dialog (new issue, acknowledge an insight, edit): creates or edits an issue with what it touches,
 * its owners and its sources in one transaction, so the history gets one entry.
 */
export async function saveIssueFromDialog(workspaceId: unknown, input: unknown): Promise<SaveIssueResult> {
  if (!isId(workspaceId)) return invalid;
  const parsed = parseSaveInput(input);
  if (!parsed.ok) return { status: "error", message: parsed.error };
  const v = parsed.value;
  const fields: Record<string, Json | undefined> = {
    title: v.title,
    severity: v.severity,
    evidence: v.evidence ?? null,
    target_measure: v.target_measure,
    target_now: v.target_now,
    target_goal: v.target_goal,
  };
  if (v.id) {
    if (v.status) fields.status = v.status;
  } else {
    fields.type = v.type ?? "manual";
    if (v.from) {
      const { evidence_metrics, ...from } = v.from;
      Object.assign(fields, from, { evidence_metrics: evidence_metrics as Json, source: "promoted" });
    } else {
      fields.source = "manual";
    }
  }
  // An edit saves the evidence again, so it goes through the same strip (B1 2b).
  return write(workspaceId, { id: v.id, fields: payFreeIssueFields(fields), links: v.links, owners: v.owner_ids, sources: v.source_ids });
}

/** Dismiss an insight again: its row stays dismissed, against the process's current live revision. */
export async function redismissIssue(workspaceId: unknown, id: unknown, revisionId: unknown): Promise<SaveIssueResult> {
  if (!isId(workspaceId) || !isId(id) || !(revisionId === null || isId(revisionId))) return invalid;
  return write(workspaceId, { id, fields: { status: "dismissed", dismissed_revision_id: revisionId } });
}

/** Save one field of an issue if its stored value is still `base`. */
export async function saveIssueField(id: unknown, field: unknown, base: unknown, value: unknown): Promise<SaveOutcome<Scalar>> {
  if (!isId(id) || !isIssueField(field)) return invalid;
  const clean = cleanFieldValue(field, value);
  const isScalar = base === null || ["string", "number", "boolean"].includes(typeof base);
  if (!clean || !isScalar) return { status: "error", message: "That value isn't valid." };
  if (!(await signedInClient())) return signedOut;
  if (field === "status") return saveStatus(id, base as Scalar, clean.value);
  return saveField("issues", { id }, field, base as Scalar, clean.value);
}

/**
 * The status as shown (Open, Testing solutions, Resolved, Won't fix) is stored as the older spellings plus a
 * resolution, so a status edit saves both fields together, each checked against what the person last saw
 * (issue-status.ts in packages/db is the one place that maps them).
 */
async function saveStatus(id: string, base: Scalar, next: Scalar): Promise<SaveOutcome<Scalar>> {
  const isShown = (v: Scalar): v is IssueStatus => (ISSUE_STATUSES as readonly Scalar[]).includes(v);
  if (!isShown(base) || !isShown(next)) return { status: "error", message: "That value isn't valid." };
  const from = storedStatus(base);
  const to = storedStatus(next);
  const r = await saveFields<Scalar>("issues", { id }, { status: from.status, resolution: from.resolution }, { status: to.status, resolution: to.resolution });
  if (r.status === "saved") return { status: "saved", value: next };
  if (r.status === "conflict") {
    const theirs = uiStatus((r.theirs.status ?? from.status) as StoredIssueStatus, (r.theirs.resolution ?? from.resolution) as string | null);
    return { status: "conflict", theirs };
  }
  return r;
}

/** Delete an issue. A row that is gone, or that the user may not delete, reads as forbidden. */
export async function deleteIssue(id: unknown): Promise<RemoveIssueResult> {
  if (!isId(id)) return invalid;
  const supabase = await signedInClient();
  if (!supabase) return signedOut;
  const { data, error } = await supabase.from("issues").delete().eq("id", id).select("id");
  if (error) return failure(error);
  if (!data.length) return forbidden;
  return { status: "ok" };
}

/**
 * Mark an issue resolved: how it was resolved (a solution fixed it, the process was changed directly, or it is no longer
 * a problem) and a note, in one write, so the history gets one entry carrying both (public.resolve_issue).
 */
export async function resolveIssueAction(workspaceId: unknown, id: unknown, how: unknown, note: unknown, solutionId: unknown = null): Promise<SaveIssueResult> {
  if (!isId(workspaceId) || !isId(id)) return invalid;
  const parsed = parseResolveInput({ how, note, solutionId });
  if (!parsed.ok) return { status: "error", message: parsed.error };
  const supabase = await signedInClient();
  if (!supabase) return signedOut;
  const done = await resolveIssue(supabase, { workspaceId, id, how: parsed.value.how, note: parsed.value.note, solutionId: parsed.value.solutionId });
  if ("error" in done) return failure(done.error);
  const issue = await loadIssue(supabase, workspaceId, id);
  return issue ? { status: "ok", issue } : forbidden;
}

/** Set a resolved issue back to Open. The database logs it as reopened and clears the issue's own how and note; the history keeps them. */
export async function reopenIssue(workspaceId: unknown, id: unknown): Promise<SaveIssueResult> {
  if (!isId(workspaceId) || !isId(id)) return invalid;
  return write(workspaceId, { id, fields: { status: "open" } });
}

/** An issue's history, oldest first, for the Issue page to refresh after a change. */
export async function issueEvents(workspaceId: unknown, id: unknown): Promise<IssueEventRow[]> {
  if (!isId(workspaceId) || !isId(id)) return [];
  const supabase = await signedInClient();
  return supabase ? loadIssueEvents(supabase, workspaceId, id) : [];
}
