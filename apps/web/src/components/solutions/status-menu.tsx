"use client";

// A solution's status as a pill dropdown (Q10, D43): on the Solution page's header and on each "Solutions tried" row of an issue. Editors
// choose one and it saves at once; a reader sees the plain pill. The demo keeps the change in this tab.

import { useState } from "react";
import type { SolutionRow, SolutionStatus } from "@transpera-flow/db";
import { StatusPillMenu } from "@/components/page-kit";
import { saveSolutionStatus } from "@/app/w/[slug]/solution-page-actions";
import { setDemoStatus } from "@/lib/solutions/demo";
import { SOLUTION_STATUS_OPTIONS } from "@/lib/solutions/status";
import type { ScreenMode } from "@/lib/mode";

export function SolutionStatusMenu({
  solution,
  mode,
  onSaved,
  onError,
}: {
  solution: Pick<SolutionRow, "id" | "status">;
  mode: ScreenMode;
  /** The status that was saved (or, after a conflict, the one somebody else saved), so the page can show it. */
  onSaved: (status: SolutionStatus) => void;
  onError?: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const readOnly = mode === "readonly";
  const change = async (next: SolutionStatus) => {
    onError?.(null);
    if (mode === "demo") {
      setDemoStatus(solution.id, next);
      return onSaved(next);
    }
    setBusy(true);
    try {
      const r = await saveSolutionStatus(solution.id, solution.status, next);
      if (r.status === "ok") onSaved(r.value);
      else if (r.status === "conflict") {
        onSaved(r.theirs);
        onError?.("Someone else changed this status first. It now shows theirs.");
      } else onError?.(r.message);
    } catch {
      onError?.("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return <StatusPillMenu name="Solution status" value={solution.status} options={SOLUTION_STATUS_OPTIONS} onChange={(s) => void change(s)} disabled={readOnly || busy} />;
}
