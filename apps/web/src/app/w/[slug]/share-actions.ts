"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { ENGINE_VERSION } from "@transpera-flow/engine";
import { ShareBuildError, loadShareData, loadShareSecrets, shareSnapshotLeaks, type Db, type ShareKind } from "@transpera-flow/db";
import { canEditWorkspace } from "@/lib/access-data";
import { isId } from "@/lib/editor/validate";
import { parseShareInput } from "@/lib/share/input";
import { jsonb, pgError } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

// Making, refreshing and turning off share links (issue #32, B3; docs/adr/0016-share-links.md). The server builds the snapshot as the
// signed-in editor (so RLS and `share_team_capacity` decide what it may read), redacts it, checks it again here, and saves it;
// Postgres checks it once more on the write. The link itself is shown once: only its SHA-256 is stored.

type ShareError = { status: "error"; message: string };
export type ShareResult = { status: "ok"; url?: string } | ShareError;

const signedOut: ShareError = { status: "error", message: "Your session has ended. Sign in again." };
const forbidden: ShareError = { status: "error", message: "Only owners and editors can share." };
const generic: ShareError = { status: "error", message: "Couldn't save. Try again." };
const unsafe: ShareError = { status: "error", message: "Couldn't make a safe copy of this page. Nothing was shared." };

const WORKSPACE_COLUMNS = ["id", "name", "slug", "settings"] as const;

async function signedInClient(): Promise<Db | null> {
  return (await getSessionUser()) ? getDb() : null;
}

/** The address the app is served from, as the browser sees it (the link is built on it). */
async function originOf(): Promise<string> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin) return origin;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return host ? `${proto}://${host}` : "";
}

/** What the database's refusals mean to a person. */
function refusal(error: { code?: string; message?: string; details?: string }): ShareError {
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  if (error.code === "42501") return forbidden;
  if (error.code === "23514") {
    if (/share_links_restricted/.test(text)) return { status: "error", message: "Add at least one email address and choose when the link stops working." };
    if (/share_links_emails/.test(text)) return { status: "error", message: "Check the email addresses: each one once, with at most 50 in all." };
    if (/share_links_snapshot_size/.test(text)) return { status: "error", message: "This page is too big to share." };
    if (/share_links_label/.test(text)) return { status: "error", message: "Keep the name under 120 characters." };
    return unsafe;
  }
  if (error.code === "22023" && error.message) return { status: "error", message: error.message };
  console.error("share link write failed", error.code, error.message);
  return generic;
}

/** Builds the snapshot and runs the app's own leak check on it. A string for a problem to show; the snapshot otherwise. */
async function buildSnapshot(db: Db, workspace: { id: string; name: string; slug: string; settings: unknown }, target: { kind: ShareKind; id: string | null }, toggles: { people: boolean; financials: boolean }) {
  try {
    const snapshot = await loadShareData(db, workspace, target, toggles);
    const leaks = shareSnapshotLeaks(snapshot, await loadShareSecrets(db, workspace.id), toggles);
    if (leaks.length) {
      // The kinds of problem, never the values.
      console.error("share snapshot refused by the leak check:", leaks.join(", "));
      return { error: unsafe.message };
    }
    return { snapshot };
  } catch (err) {
    if (err instanceof ShareBuildError) return { error: err.message, build: true as const };
    console.error("share snapshot failed", err instanceof Error ? err.message : err);
    return { error: "Couldn't make a copy of this page. Try again." };
  }
}

/**
 * Makes a link to a frozen, redacted copy of one page. Returns its address once: it is never stored or shown again (only its hash
 * is kept), so the dialog says to copy it now.
 */
export async function createShareLink(slug: unknown, input: unknown): Promise<ShareResult> {
  if (typeof slug !== "string") return generic;
  const db = await signedInClient();
  if (!db) return signedOut;
  const workspace = await db.selectFrom("workspaces").select(WORKSPACE_COLUMNS).where("slug", "=", slug).executeTakeFirst().catch(() => undefined);
  if (!workspace) return { status: "error", message: "That workspace isn't there any more. Reload the page." };
  if (!(await canEditWorkspace(workspace.id))) return forbidden;

  const parsed = parseShareInput(input);
  if (!parsed.ok) return { status: "error", message: parsed.message };
  const v = parsed.value;

  const built = await buildSnapshot(db, workspace, { kind: v.kind, id: v.targetId }, { people: v.people, financials: v.financials });
  if (!built.snapshot) return { status: "error", message: built.error };

  const token = randomBytes(32).toString("base64url");
  try {
    await db
      .insertInto("share_links")
      .values({
        workspace_id: workspace.id,
        token_hash: createHash("sha256").update(token).digest("hex"),
        kind: v.kind,
        target_id: v.targetId,
        mode: v.play ? "play" : "view",
        show_people: v.people,
        show_financials: v.financials,
        allowed_emails: v.emails,
        expires_at: v.expiresAt,
        label: v.label,
        snapshot: jsonb(built.snapshot),
        engine_version: ENGINE_VERSION,
      })
      .execute();
  } catch (e) {
    return refusal(pgError(e));
  }
  revalidatePath(`/w/${slug}/share`);
  return { status: "ok", url: `${await originOf()}/s/${token}` };
}

/** Rebuilds a link's copy from today's page. The link, its settings and its address stay the same. */
export async function refreshShareLink(slug: unknown, id: unknown): Promise<ShareResult> {
  if (typeof slug !== "string" || !isId(id)) return generic;
  const db = await signedInClient();
  if (!db) return signedOut;
  const workspace = await db.selectFrom("workspaces").select(WORKSPACE_COLUMNS).where("slug", "=", slug).executeTakeFirst().catch(() => undefined);
  if (!workspace) return { status: "error", message: "That workspace isn't there any more. Reload the page." };
  if (!(await canEditWorkspace(workspace.id))) return forbidden;
  const row = await db
    .selectFrom("share_links")
    .select(["id", "kind", "target_id", "show_people", "show_financials", "revoked_at"])
    .where("id", "=", id)
    .where("workspace_id", "=", workspace.id)
    .executeTakeFirst()
    .catch(() => undefined);
  if (!row) return { status: "error", message: "That link isn't there any more. Reload the page." };
  if (row.revoked_at) return { status: "error", message: "This link was turned off." };

  const built = await buildSnapshot(db, workspace, { kind: row.kind as ShareKind, id: row.target_id }, { people: row.show_people, financials: row.show_financials });
  if (!built.snapshot) {
    return { status: "error", message: "build" in built && built.build ? "That page no longer exists, so the link keeps its last copy." : built.error };
  }
  let data;
  try {
    data = await db.updateTable("share_links").set({ snapshot: jsonb(built.snapshot), engine_version: ENGINE_VERSION }).where("id", "=", id).returning("id").execute();
  } catch (e) {
    return refusal(pgError(e));
  }
  if (!data.length) return forbidden;
  revalidatePath(`/w/${slug}/share`);
  return { status: "ok" };
}

/** Turns a link off for everyone, straight away. It can't be turned back on. */
export async function revokeShareLink(slug: unknown, id: unknown): Promise<ShareResult> {
  if (typeof slug !== "string" || !isId(id)) return generic;
  const db = await signedInClient();
  if (!db) return signedOut;
  let data;
  try {
    data = await db.updateTable("share_links").set({ revoked_at: new Date().toISOString() }).where("id", "=", id).where("revoked_at", "is", null).returning("id").execute();
  } catch (e) {
    return refusal(pgError(e));
  }
  if (!data.length) return { status: "error", message: "That link is already off, or you can't change it." };
  revalidatePath(`/w/${slug}/share`);
  return { status: "ok" };
}
