// What an analysis run says to the person who pressed "Analyse" (issue #175, B17), in plain words. Pure.

import { AI_NOT_SET_UP } from "./types";
import type { AiRunResult } from "./service";

export type AiRunReply = { status: "ok"; message: string } | { status: "error"; message: string };

/** What a result says, in plain words. */
export function replyOf(out: AiRunResult, scope: "process" | "company"): AiRunReply {
  if (out.status === "error") return { status: "error", message: out.message };
  if (out.status === "skipped") {
    const message =
      out.why === "not_set_up"
        ? AI_NOT_SET_UP
        : out.why === "unchanged"
          ? "Nothing has changed since the last analysis, so it wasn't run again."
          : out.why === "no_first_principles"
            ? scope === "company"
              ? "Write the first principles of your main process first: the analysis judges the company against them."
              : "Write this process's first principles first, and publish them: the analysis judges the process against them."
            : out.why === "forbidden"
              ? "Only owners and editors can run the analysis."
              : out.why === "no_live"
                ? "Publish a version of this process first."
                : (out.message ?? "AI analysis didn't run.");
    return { status: out.why === "unchanged" ? "ok" : "error", message };
  }
  const o = out.outcome;
  if (o.status === "unavailable") return { status: "error", message: o.reason ?? AI_NOT_SET_UP };
  if (o.status === "failed") return { status: "error", message: `AI couldn't write an analysis that matched the run: ${o.reason ?? "no reason given"}.` };
  if (!o.insights.length) return { status: "ok", message: "Analysis done. AI proposed no findings." };
  const n = out.added;
  return { status: "ok", message: n ? `Analysis done: ${n} finding${n === 1 ? "" : "s"} to review.` : "Analysis done. Nothing new to review." };
}
