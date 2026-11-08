import type { Db, ProcessRow } from "../index";
import { ImportError } from "./errors";

/** Who is importing: a database handle acting as the signed-in user (claims set per query, so RLS decides). */
export interface ImportContext {
  db: Db;
  /** Who acts, for provenance `by`. */
  userId?: string | null;
}

export interface WorkspaceRef {
  id: string;
  name: string;
  slug: string;
  settings: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Workspaces the user can see; RLS decides. */
async function visibleWorkspaces(db: Db): Promise<WorkspaceRef[]> {
  return await db.selectFrom("workspaces").select(["id", "name", "slug", "settings"]).orderBy("name").execute();
}

const summary = (w: WorkspaceRef) => ({ id: w.id, name: w.name, slug: w.slug });

/** Find one workspace by id, slug or name (case-insensitive) among those visible. */
function matchWorkspace(workspaces: WorkspaceRef[], ref: string): WorkspaceRef {
  const needle = ref.trim().toLowerCase();
  const exact = workspaces.filter((w) => (UUID.test(needle) && w.id === needle) || w.slug === needle || w.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;
  const partial = workspaces.filter((w) => w.name.toLowerCase().includes(needle) || w.slug.includes(needle));
  if (exact.length === 0 && partial.length === 1) return partial[0]!;
  const candidates = (exact.length ? exact : partial).map(summary);
  if (candidates.length) throw new ImportError("ambiguous", `'${ref}' matches more than one workspace`, candidates);
  throw new ImportError("not_found", `No workspace you can access matches '${ref}'`, workspaces.map(summary));
}

/** The workspace an import acts on, by id, slug or name, among those the user can see. */
export async function resolveWorkspace(ctx: ImportContext, ref: string): Promise<WorkspaceRef> {
  return matchWorkspace(await visibleWorkspaces(ctx.db), ref);
}

export type ProcessWithDraft = ProcessRow & { draft_revision_id: string | null };
