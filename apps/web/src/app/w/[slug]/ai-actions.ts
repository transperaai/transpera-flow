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

/** Analyse a process's live version (cached: nothing runs while the model is unchanged). */
export async function analyseProcess(processId: string): Promise<AiRunReply> {
  if (typeof processId !== "string" || !UUID.test(processId)) return { status: "error", message: "That isn't valid." };
  const supabase = await signedIn();
  if (!supabase) return { status: "error", message: "Your session has ended. Sign in again." };
  const out = await runAiAnalysis(supabase, processId);
  if (out.status === "stored") refresh();
  return replyOf(out, "process");
}

/** Analyse the whole company (cached the same way). */
export async function analyseCompany(workspaceId: string): Promise<AiRunReply> {
  if (typeof workspaceId !== "string" || !UUID.test(workspaceId)) return { status: "error", message: "That isn't valid." };
  const supabase = await signedIn();
  if (!supabase) return { status: "error", message: "Your session has ended. Sign in again." };
  const out = await runCompanyAiAnalysis(supabase, workspaceId);
  if (out.status === "stored") refresh();
  return replyOf(out, "company");
}
