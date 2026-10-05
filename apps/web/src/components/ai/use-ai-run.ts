"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { analyseProcess } from "@/app/w/[slug]/ai-actions";

export type AiRunMessage = { kind: "ok" | "error"; text: string };

/**
 * "Analyse" for the first-principles review panel (issue #111, A46; B17): analyses a process's live version on the server, then
 * refreshes the page so it shows what was stored. On the public demo nothing is sent anywhere: it waits a moment and
 * says so, because the demo's text is written in advance.
 */
export function useAiRun(demo: boolean, processId: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<AiRunMessage | null>(null);
  const run = () => {
    setMessage(null);
    start(async () => {
      if (demo) {
        await new Promise((r) => setTimeout(r, 900));
        setMessage({ kind: "ok", text: "Analysis done. Nothing new to review. (Demo: the text is written in advance; nothing was sent to an AI.)" });
        return;
      }
      try {
        const out = await analyseProcess(processId);
        setMessage({ kind: out.status === "ok" ? "ok" : "error", text: out.message });
        if (out.status === "ok") router.refresh();
      } catch {
        setMessage({ kind: "error", text: "Couldn't run the AI review. Check your connection and try again." });
      }
    });
  };
  return { pending, message, run };
}
