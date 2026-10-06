import "server-only";
import {
  DEFAULT_AI_SETTINGS,
  loadAiAnalyses,
  loadAiSettings,
  loadFindings,
  loadLatestAiAnalyses,
  nameAnalysisRow,
  nameFinding,
  type AiSettings,
  type FindingRow,
  type NameSource,
} from "@transpera-flow/db";
import { narrationConfigured } from "@/lib/narration/anthropic";
import { createClient } from "../supabase/server";
import { aiViewFromRow, type AiAnalysisView } from "./types";

/** Whether this server has an Anthropic API key (the one narration uses): without it AI analysis says it isn't set up. */
export const aiConfigured = (): boolean => narrationConfigured();

/** The workspace's AI switches (RLS: every member reads); the defaults if they can't be read (say the table isn't there yet). */
export async function loadWorkspaceAiSettings(workspaceId: string): Promise<AiSettings> {
  try {
    return await loadAiSettings(await createClient(), workspaceId);
  } catch (err) {
    console.error("Couldn't load the AI settings; using the defaults.", err instanceof Error ? err.message : err);
    return { ...DEFAULT_AI_SETTINGS };
  }
}

/**
 * The stored AI analyses of these versions (RLS: every member reads), by revision id; none if they can't be read. The text is
 * saved with labels ("Team member A"); `who` is the reader, who gets names back where they may see them (B1 2b).
 */
export async function loadAiViews(revisionIds: readonly string[], who: NameSource): Promise<Record<string, AiAnalysisView>> {
  try {
    const rows = await loadAiAnalyses(await createClient(), revisionIds);
    return Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, aiViewFromRow(nameAnalysisRow(row, who))]));
  } catch (err) {
    console.error("Couldn't load the AI analysis; showing none.", err instanceof Error ? err.message : err);
    return {};
  }
}

/** The latest stored analysis of each of these processes, whichever version it read (B17), by process id; none if they can't be read. */
export async function loadLatestAiViews(processIds: readonly string[], who: NameSource): Promise<Record<string, AiAnalysisView>> {
  try {
    const rows = await loadLatestAiAnalyses(await createClient(), processIds);
    return Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, aiViewFromRow(nameAnalysisRow(row, who))]));
  } catch (err) {
    console.error("Couldn't load the AI analysis; showing none.", err instanceof Error ? err.message : err);
    return {};
  }
}

/**
 * The workspace's findings a page shows or reviews (proposed and accepted; RLS: every member reads); none if they can't be
 * read. Their text is saved with labels and named here for the reader `who` (B1 2b).
 */
export async function loadWorkspaceFindings(workspaceId: string, who: NameSource): Promise<FindingRow[]> {
  try {
    return (await loadFindings(await createClient(), workspaceId)).map((r) => nameFinding(r, who));
  } catch (err) {
    console.error("Couldn't load the findings; showing none.", err instanceof Error ? err.message : err);
    return [];
  }
}
