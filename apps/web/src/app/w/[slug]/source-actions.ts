"use server";

import {
  linkColumns,
  loadSourceBody,
  searchSources,
  type Db,
  type SourceLinkRow,
  type SourceListRow,
  type SourceRow,
} from "@transpera-flow/db";
import { mapOutcome, type SaveOutcome } from "@/lib/fields/field-controller";
import { saveField } from "@/lib/fields/server";
import { PAGE_SIZE, parseLibraryQuery } from "@/lib/sources/library";
import { linkJson, parseNewSource, parseTarget } from "@/lib/sources/links";
import type { LinkSourceResult, RemoveSourceResult, SaveSourceResult } from "@/lib/sources/store";
import { cleanSourceField, formatSpeakers, isId, isSourceField, parseSpeakers, type Scalar } from "@/lib/sources/validate";
import { rpc } from "@transpera-flow/db/client";
import { pgError } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

const SOURCE_COLS = ["id", "workspace_id", "kind", "title", "speakers", "recorded_at", "body", "file_url", "created_at", "updated_at"] as const;
const SOURCE_LINK_COLS = ["id", "workspace_id", "source_id", "kind", "process_id", "step_id", "insight_key", "issue_id", "solution_id", "created_at", "created_by"] as const;

// Adding, editing and deleting sources (issue #21). Every write runs as the
// signed-in user through RLS (editors, owners and agency admins may write;
// everyone in the workspace may read). The checks in lib/sources/validate.ts
// only reject malformed input early; the table checks them again. Edits are
// per-field saves (docs/adr/0001-per-field-saves.md).

const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const forbidden = { status: "error", message: "You don't have permission to change sources here." } as const;
const invalid = { status: "error", message: "That source isn't valid." } as const;

async function signedInClient(): Promise<Db | null> {
  return (await getSessionUser()) ? getDb() : null;
}

const failure = (e: unknown) => {
  const error = pgError(e);
  return failureOf(error);
};

const failureOf = (error: { code?: string; message?: string }) =>
  error.code === "42501"
    ? forbidden
    : error.code === "22023" && error.message
      ? // The database's own plain-English refusals (a source with no link, a step that is not in that process).
        ({ status: "error", message: error.message } as const)
      : error.code === "23505"
        ? ({ status: "error", message: "That source is already linked to that." } as const)
        : error.code === "23503"
          ? ({ status: "error", message: "That isn't something in this workspace any more. Reload and try again." } as const)
          : error.code === "23514"
            ? ({ status: "error", message: "Some of those values aren't allowed." } as const)
            : ({ status: "error", message: "Couldn't save. Try again." } as const);

/**
 * Add a source (a transcript, notes or a screenshot link) with the links it must have: at least one. The database function
 * `add_source` saves the source and its links together, so a source is never saved without one.
 */
export async function createSource(workspaceId: unknown, input: unknown, links: unknown): Promise<SaveSourceResult> {
  if (!isId(workspaceId)) return invalid;
  const parsed = parseNewSource(input, links);
  if (!parsed.ok) return { status: "error", message: parsed.error };
  const db = await signedInClient();
  if (!db) return signedOut;
  const { input: fields, links: targets } = parsed.value;
  let id;
  try {
    id = await rpc(db, "add_source", { p_workspace: workspaceId, p_source: { ...fields }, p_links: targets.map(linkJson) });
  } catch (e) {
    return failure(e);
  }
  if (!id) return failure({});
  try {
    const [made, madeLinks] = await Promise.all([
      db.selectFrom("sources").select(SOURCE_COLS).where("id", "=", id as string).executeTakeFirstOrThrow(),
      db.selectFrom("source_links").select(SOURCE_LINK_COLS).where("source_id", "=", id as string).orderBy("created_at").orderBy("id").execute(),
    ]);
    return { status: "ok", source: made as unknown as SourceRow, links: madeLinks as unknown as SourceLinkRow[] };
  } catch (e) {
    return failure(e);
  }
}

/** Link an existing source to one more process, step, insight, issue or solution. */
export async function linkSource(sourceId: unknown, target: unknown): Promise<LinkSourceResult> {
  if (!isId(sourceId)) return invalid;
  const parsed = parseTarget(target);
  if (!parsed.ok) return { status: "error", message: parsed.error };
  const db = await signedInClient();
  if (!db) return signedOut;
  // The link carries its source's workspace: read it (RLS: only a member sees the source), then insert as the user.
  let found;
  try {
    found = await db.selectFrom("sources").select("workspace_id").where("id", "=", sourceId).executeTakeFirst();
  } catch (e) {
    return failure(e);
  }
  if (!found) return { status: "error", message: "That source isn't there any more." };
  let link: SourceLinkRow;
  try {
    const data = await db
      .insertInto("source_links")
      .values({ workspace_id: found.workspace_id, source_id: sourceId, ...linkColumns(parsed.value) })
      .returning(SOURCE_LINK_COLS)
      .executeTakeFirstOrThrow();
    link = data as unknown as SourceLinkRow;
  } catch (e) {
    return failure(e);
  }
  // An issue keeps its own list of sources too (`issue_sources`, which its history logs): keep it in step. Best effort: a
  // detected issue has no list to add to, and the link is already there.
  if (link.kind === "issue" && link.issue_id) {
    await db.insertInto("issue_sources").values({ issue_id: link.issue_id, source_id: link.source_id, workspace_id: link.workspace_id }).execute().catch(() => undefined);
  }
  return { status: "ok", link };
}

/** Take a link away. The source stays; with no link left it is flagged on the Sources page. */
export async function unlinkSource(linkId: unknown): Promise<RemoveSourceResult> {
  // A source on an issue's own list that has no link row shows as a link with a made-up id: taking it off is taking it off the list.
  const listed = typeof linkId === "string" ? /^issue-source:([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(linkId) : null;
  if (listed && isId(listed[1]) && isId(listed[2])) {
    const db = await signedInClient();
    if (!db) return signedOut;
    try {
      const data = await db.deleteFrom("issue_sources").where("issue_id", "=", listed[1]).where("source_id", "=", listed[2]).returning("issue_id").execute();
      return data.length ? { status: "ok" } : forbidden;
    } catch (e) {
      return failure(e);
    }
  }
  if (!isId(linkId)) return invalid;
  const db = await signedInClient();
  if (!db) return signedOut;
  let data;
  try {
    data = await db.deleteFrom("source_links").where("id", "=", linkId).returning(["id", "kind", "issue_id", "source_id"]).execute();
  } catch (e) {
    return failure(e);
  }
  if (!data.length) return forbidden;
  // Taking a source off an issue takes it off the issue's own list as well, or the issue would still show it.
  const gone = data[0]!;
  if (gone.kind === "issue" && gone.issue_id) {
    await db.deleteFrom("issue_sources").where("issue_id", "=", gone.issue_id).where("source_id", "=", gone.source_id).execute().catch(() => undefined);
  }
  return { status: "ok" };
}

/** Save one field of a source if its stored value is still `base`. Speakers travel as "a, b" text. */
export async function saveSourceField(id: unknown, field: unknown, base: unknown, value: unknown): Promise<SaveOutcome<Scalar>> {
  if (!isId(id) || !isSourceField(field)) return invalid;
  const clean = cleanSourceField(field, value);
  const isScalar = base === null || ["string", "number", "boolean"].includes(typeof base);
  if (!clean || !isScalar) return { status: "error", message: "That value isn't valid." };
  if (!(await signedInClient())) return signedOut;
  if (field === "speakers") {
    const outcome = await saveField("sources", { id }, field, parseSpeakers(base as string | null), clean.value as string[]);
    return mapOutcome(outcome, (speakers) => formatSpeakers(speakers) || null);
  }
  return saveField("sources", { id }, field, base as Scalar, clean.value as Scalar);
}

/** Delete a source. Values citing it keep their quotes; the Sources page shows them as citing a deleted source. */
export async function deleteSource(id: unknown): Promise<RemoveSourceResult> {
  if (!isId(id)) return invalid;
  const db = await signedInClient();
  if (!db) return signedOut;
  let data;
  try {
    data = await db.deleteFrom("sources").where("id", "=", id).returning("id").execute();
  } catch (e) {
    return failure(e);
  }
  if (!data.length) return forbidden;
  return { status: "ok" };
}

export type LibraryPageResult = { status: "ok"; rows: SourceListRow[]; total: number } | { status: "error"; message: string };

/** One page of the Sources library (the database's `search_sources`): rows without their full text, and how many match in all. */
export async function searchSourcesPage(workspaceId: unknown, query: unknown, offset: unknown, limit: unknown): Promise<LibraryPageResult> {
  const q = parseLibraryQuery(query);
  const from = typeof offset === "number" && Number.isInteger(offset) && offset >= 0 && offset <= 1_000_000 ? offset : null;
  const size = typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : PAGE_SIZE;
  if (!isId(workspaceId) || !q || from === null) return invalid;
  const db = await signedInClient();
  if (!db) return signedOut;
  try {
    const page = await searchSources(db, workspaceId, {
      search: q.search,
      ...(q.kind !== "all" ? { kind: q.kind } : {}),
      ...(q.processId !== "all" ? { processId: q.processId } : {}),
      unlinkedOnly: q.unlinkedOnly,
      sort: q.sort,
      limit: size,
      offset: from,
    });
    return { status: "ok", ...page };
  } catch {
    return { status: "error", message: "Couldn't load the sources. Try again." };
  }
}

/** A source's full text, read when it is opened. */
export async function readSourceBody(sourceId: unknown): Promise<{ status: "ok"; body: string | null } | { status: "error"; message: string }> {
  if (!isId(sourceId)) return invalid;
  const db = await signedInClient();
  if (!db) return signedOut;
  try {
    return { status: "ok", body: await loadSourceBody(db, sourceId) };
  } catch {
    return { status: "error", message: "Couldn't load the text. Try again." };
  }
}
