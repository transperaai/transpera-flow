"use server";

import { refresh } from "next/cache";
import { replyOf, type AiRunReply } from "@/lib/ai/reply";
import { runAiAnalysis, runCompanyAiAnalysis } from "@/lib/ai/service";
import { createClient } from "@/lib/supabase/server";

// "Analyse" (issue #175, B17): one process from its page, or the whole company from the Overview. The only way AI
// analysis runs. As the signed-in user: the analysis and its proposed findings are written under RLS, so a viewer's click
// writes nothing (and the button isn't shown to them). It waits for the model, so the pages that call it allow a long
// request (`maxDuration`). The Anthropic key never leaves the server: only `lib/narration/anthropic.ts` reads it.

export type { AiRunReply };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function signedIn() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return data?.claims?.sub ? supabase : null;
}

/**
 * Analyse a process's live version. Cached: the model isn't called while what the analysis read is unchanged, unless
 * `force` ("Analyse again"), which still reserves a run, so the daily cap and the cooldown hold.
 */
export async function analyseProcess(processId: string, force: boolean = false): Promise<AiRunReply> {
  if (typeof processId !== "string" || !UUID.test(processId) || typeof force !== "boolean") return { status: "error", message: "That isn't valid." };
  const supabase = await signedIn();
  if (!supabase) return { status: "error", message: "Your session has ended. Sign in again." };
  const out = await runAiAnalysis(supabase, processId, { force });
  if (out.status === "stored") refresh();
  return replyOf(out, "process");
}

/** Analyse the whole company (cached, and forced, the same way). */
export async function analyseCompany(workspaceId: string, force: boolean = false): Promise<AiRunReply> {
  if (typeof workspaceId !== "string" || !UUID.test(workspaceId) || typeof force !== "boolean") return { status: "error", message: "That isn't valid." };
  const supabase = await signedIn();
  if (!supabase) return { status: "error", message: "Your session has ended. Sign in again." };
  const out = await runCompanyAiAnalysis(supabase, workspaceId, { force });
  if (out.status === "stored") refresh();
  return replyOf(out, "company");
}
