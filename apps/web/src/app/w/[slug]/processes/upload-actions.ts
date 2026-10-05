"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkProcessFileText, processTextFrom, type ProcessFileCheck } from "@transpera-flow/db/process-file";
import { fetchPublicPage, importProcessFile, LinkError, previewProcessFile, takeLinkFetch, ToolError } from "@transpera-flow/mcp";
import { isId } from "@/lib/editor/validate";
import { sourceLabel, uploadSizeProblem, type CreateUploadInput, type CreateUploadResult, type PreviewInput, type PreviewResult, type UploadPreview } from "@/lib/processes/upload";
import { NOTICE_COOKIE, noticeValue } from "@/lib/processes/upload-notice";
import { createClient } from "@/lib/supabase/server";

// Upload a process (issue #166, B13). The file is checked here, not trusted from the browser, and written by the same code
// the MCP `import_process` tool uses (packages/mcp/src/import-file.ts), acting as the signed-in user through RLS: only
// editors can, nothing is published, and no role, person or client is created. The result opens in the editor as a draft.
// Who is asking is settled before the file is looked at: someone who isn't a signed-in editor of the workspace costs us
// nothing but the answer.

const MAX_NAME = 120;
const GENERIC = "Couldn't read that. Try again.";

/** The signed-in editor's context, or why there isn't one. */
async function editorContext(workspaceId: string): Promise<{ ctx: Awaited<ReturnType<typeof context>> & object } | { error: string }> {
  const ctx = await context(workspaceId);
  if (!ctx) return { error: "Your session has ended. Sign in again." };
  const { data: canEdit } = await ctx.db.rpc("can_edit_workspace", { ws: workspaceId });
  if (canEdit !== true) return { error: "Only editors and owners can upload a process." };
  return { ctx };
}

async function context(workspaceId: string) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return null;
  return { db: supabase, tokenHash: "", userId, activeWorkspaceId: workspaceId, today: new Date().toISOString().slice(0, 10) };
}

const failure = (check: ProcessFileCheck, source: string): UploadPreview => ({
  source,
  name: "",
  kind: "pipeline",
  steps: 0,
  links: 0,
  groups: 0,
  errors: check.errors,
  warnings: check.warnings,
  roles: [],
  matchedRoles: [],
  unknownRoles: [],
  unknownPeople: [],
  nameTaken: null,
});

/**
 * Check an uploaded file, or a page fetched from a link, and say what creating it would do, without writing anything. For a
 * link the server does the fetching (https only, public addresses only: packages/mcp/src/fetch-link.ts) and hands the process
 * text back, so creating it later doesn't fetch the page a second time.
 */
export async function previewUpload(workspaceId: string, _slug: string, input: PreviewInput): Promise<PreviewResult> {
  const link = input?.kind === "link";
  if (!isId(workspaceId) || (input?.kind !== "file" && !link)) return { error: GENERIC };
  if (input.kind === "link" ? typeof input.url !== "string" : typeof input.text !== "string" || typeof input.fileName !== "string") return { error: GENERIC };
  // Cheap checks first, and the person before the file: nothing is fetched or parsed for someone who may not upload.
  const who = await editorContext(workspaceId);
  if ("error" in who) return { error: who.error };
  let content: string;
  let source: string;
  if (input.kind === "link") {
    source = sourceLabel(input.url);
    // Each fetch is counted before it is made (10 a minute per person), so pasting links in a loop can't use the server as a crawler.
    const turn = await takeLinkFetch(who.ctx);
    if (!turn.allowed) return { error: turn.message };
    try {
      content = await fetchPublicPage(input.url);
    } catch (e) {
      return { error: e instanceof LinkError ? e.message : "Couldn't open that link. Make the page viewable by anyone with the link, or download the HTML and upload that." };
    }
    const found = processTextFrom(content);
    if (found.error !== undefined) return { error: found.error };
    content = found.text;
  } else {
    source = sourceLabel(input.fileName);
    content = input.text;
  }
  const tooBig = uploadSizeProblem(Buffer.byteLength(content));
  if (tooBig) return { preview: failure({ file: null, errors: [tooBig], warnings: [] }, source) };
  const check = checkProcessFileText(content);
  if (!check.file) return { preview: failure(check, source) };
  try {
    const p = await previewProcessFile(who.ctx, workspaceId, check.file);
    return {
      ...(input.kind === "link" ? { text: content } : {}),
      preview: {
        source,
        name: check.file.name,
        kind: check.file.kind,
        steps: check.file.steps.length,
        links: check.file.links.length,
        groups: check.file.groups.length,
        errors: check.errors,
        warnings: [
          ...check.warnings,
          ...p.unknownPeople.map((n) => `'${n}' isn't in your company, so the steps that name them are left unassigned. Uploading never adds people.`),
        ],
        roles: p.roles,
        matchedRoles: p.matchedRoles.map((m) => ({ name: m.name, role: m.role.name })),
        unknownRoles: p.unknownRoles,
        unknownPeople: p.unknownPeople,
        nameTaken: p.nameTaken?.name ?? null,
        gap: p.gap,
        ...(p.extras
          ? {
              extras: {
                sources: p.extras.sources,
                suggestions: p.extras.suggestions.map((s) => ({ subject: s.subject, headline: s.headline, isNew: s.isNew })),
                proposals: p.extras.proposals,
                firstPrinciplesParts: p.extras.firstPrinciplesParts,
                notes: p.extras.notes,
                conflicts: [...(check.conflicts ?? []), ...p.extras.conflicts],
              },
            }
          : {}),
      },
    };
  } catch (e) {
    return { error: e instanceof ToolError ? e.message : GENERIC };
  }
}

/** Create the process, with a draft, from the file and the person's choices; opens it in the editor. */
export async function createUpload(workspaceId: string, slug: string, input: CreateUploadInput): Promise<CreateUploadResult> {
  if (!isId(workspaceId) || typeof slug !== "string" || typeof input?.text !== "string" || typeof input.source !== "string") return { error: GENERIC };
  const name = String(input.name ?? "").trim();
  if (!name || name.length > MAX_NAME) return { error: `Give it a name (up to ${MAX_NAME} characters).` };
  if (!Array.isArray(input.roleMap) || input.roleMap.length > 500) return { error: GENERIC };
  const roleMap = new Map<string, string | null>();
  for (const pair of input.roleMap) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || (pair[1] !== null && !isId(pair[1]))) return { error: GENERIC };
    roleMap.set(pair[0], pair[1]);
  }
  const who = await editorContext(workspaceId);
  if ("error" in who) return { error: who.error };
  const tooBig = uploadSizeProblem(Buffer.byteLength(input.text));
  if (tooBig) return { error: tooBig };
  const check = checkProcessFileText(input.text);
  if (!check.file) return { error: check.errors[0] ?? GENERIC };
  let processId: string;
  let warnings: string[];
  try {
    const made = await importProcessFile(who.ctx, check.file, { workspaceId, source: sourceLabel(input.source), name, roleMap });
    processId = made.process.id;
    warnings = [...check.warnings, ...made.warnings];
  } catch (e) {
    if (e instanceof ToolError) return { error: e.message };
    return { error: "Couldn't create it. Try again." };
  }
  // The redirect below ends the request, so what the upload noticed rides along in a short-lived cookie for the editor to show once.
  const notice = noticeValue(processId, warnings);
  if (notice) (await cookies()).set(NOTICE_COOKIE, notice, { path: "/", maxAge: 60, sameSite: "lax", httpOnly: false });
  redirect(`/w/${encodeURIComponent(slug)}/p/${processId}/edit`);
}
