"use client";

import { useState, useTransition } from "react";
import { companyOf, runResults, snapshotModel, type ProcessBundle } from "@transpera-flow/db";
import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveRun } from "@/app/w/[slug]/run-actions";
import { saveDemoRun } from "@/lib/demo/company-store";
import { defaultRunName, type SaveRunInput, type SaveRunResult } from "@/lib/runs/runs";
import { EDIT_ONLY } from "@/lib/phone";

// "Save this run" on the process page (issue #25): keeps the results shown
// with a snapshot of the model behind them, so opening the run later says
// what has changed since. Live: a Server Action that snapshots the model on
// the server. Demo: kept in memory.

function saveInDemo(input: SaveRunInput, bundle: ProcessBundle): SaveRunResult {
  const id = crypto.randomUUID();
  saveDemoRun({
    id,
    workspace_id: bundle.workspace.id,
    process_id: input.processId,
    name: input.name,
    scenario_id: null,
    revision_ids: [input.revisionId],
    engine_version: input.engineVersion,
    reps: input.reps,
    seed: input.seed,
    params_snapshot: snapshotModel(companyOf(bundle), [
      { id: bundle.process.id, name: bundle.process.name, revision_id: bundle.revision.id, revision: bundle.revision.number },
    ]),
    results: input.results,
    duration_ms: input.durationMs,
    created_at: new Date().toISOString(),
    created_by: null,
  });
  return { status: "ok", id };
}

export function SaveRunBar({
  mode,
  bundle,
  model,
  result,
  durationMs,
}: {
  mode: "live" | "demo";
  /** The live revision the results are of. */
  bundle: ProcessBundle;
  model: EngineModel;
  /** Null while the simulation runs. */
  result: SimulationResult | null;
  durationMs: number | null;
}) {
  const [naming, setNaming] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ tone: "ok" | "error"; text: string; name?: string } | null>(null);
  const [busy, startTransition] = useTransition();

  const submit = (name: string) => {
    if (!result) return;
    const input: SaveRunInput = {
      name: name.trim(),
      processId: bundle.process.id,
      revisionId: bundle.revision.id,
      results: runResults(model, result, bundle.workspace.settings.currency),
      seed: result.seed,
      reps: result.reps,
      durationMs,
      engineVersion: result.engineVersion,
    };
    startTransition(async () => {
      const r = mode === "demo" ? saveInDemo(input, bundle) : await saveRun(input);
      if (r.status === "ok") {
        setOutcome({ tone: "ok", text: "Saved", name: input.name });
        setNaming(null);
      } else setOutcome({ tone: "error", text: r.message });
    });
  };

  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs ${EDIT_ONLY}`} data-edit-entry>
      {naming === null ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!result}
          onClick={() => {
            setOutcome(null);
            setNaming(defaultRunName(new Date()));
          }}
        >
          Save this run
        </Button>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (naming.trim()) submit(naming);
          }}
        >
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Name</span>
            <Input autoFocus value={naming} maxLength={200} onChange={(e) => setNaming(e.target.value)} className="h-8 w-56 text-xs" />
          </label>
          <Button type="submit" size="sm" disabled={busy || !naming.trim() || !result}>
            Save
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setNaming(null)}>
            Cancel
          </Button>
        </form>
      )}
      <span role="status" aria-live="polite" className={outcome?.tone === "error" ? "text-destructive" : "text-muted-foreground"}>
        {outcome?.tone === "ok" ? <>Saved “{outcome.name}”.</> : outcome?.text}
      </span>
    </div>
  );
}
