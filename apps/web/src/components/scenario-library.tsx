"use client";

// Saved scenarios (docs/PRD.md §4.1): apply (and stack, in the order
// applied), duplicate and delete, and save the current levers as a new one.
// Anyone who can see the process can apply and compare; only editors save
// and delete (the database enforces it too).

import { useState, type FormEvent } from "react";
import type { ScenarioRow, Viewer } from "@transpera-flow/db";
import type { BrokenPatch, EngineModel, RetiredSteps } from "@transpera-flow/engine";
import { repointTargets } from "@/lib/scenarios/broken";
import { MAX_DESCRIPTION, MAX_NAME } from "@/lib/scenarios/validate";
import { describePatch } from "@/lib/scenarios/scenarios";

const buttonClass = "rounded-token border border-line px-2 py-0.5 text-xs hover:bg-panel-2 disabled:opacity-50";

/**
 * One broken change of a scenario (issue #16): what it pointed at and what
 * happened to it, and (for editors) where to point it instead, the steps
 * that replaced it first.
 */
function BrokenChange({
  model,
  viewer,
  problem,
  canEdit,
  busy,
  onRepoint,
}: {
  model: EngineModel;
  viewer?: Viewer;
  problem: BrokenPatch;
  canEdit: boolean;
  busy: boolean;
  onRepoint: (targetId: string) => void;
}) {
  const { suggested, others } = repointTargets(model, problem, viewer);
  const what = problem.kind === "steps" ? "step" : problem.kind === "people" ? "person" : problem.kind === "roles" ? "role" : "service";
  return (
    <li className="flex flex-col gap-1" data-broken-path={problem.path}>
      <p>
        <code className="rounded bg-panel-2 px-1 text-[11px] break-all text-fg-2">{problem.path}</code> {problem.message}
      </p>
      {canEdit && (suggested.length > 0 || others.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {suggested.map((t) => (
            <button key={t.id} type="button" disabled={busy} onClick={() => onRepoint(t.id)} className={`${buttonClass} border-accent`}>
              Point at {t.name}
            </button>
          ))}
          {others.length > 0 && (
            <select
              aria-label={`Re-point to another ${what}`}
              value=""
              disabled={busy}
              onChange={(e) => e.target.value && onRepoint(e.target.value)}
              className="rounded-token border border-line bg-panel px-1 py-0.5 text-xs"
            >
              <option value="">{suggested.length ? `Or another ${what}…` : `Re-point to a ${what}…`}</option>
              {others.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </li>
  );
}

function ScenarioItem({
  scenario,
  model,
  viewer,
  position,
  problems,
  retired,
  canEdit,
  busy,
  onToggle,
  onRepoint,
  onDuplicate,
  onDelete,
}: {
  scenario: ScenarioRow;
  model: EngineModel;
  viewer?: Viewer;
  /** 1-based place in the stack, or null when not applied. */
  position: number | null;
  problems: BrokenPatch[];
  retired: RetiredSteps;
  canEdit: boolean;
  busy: boolean;
  onToggle: () => void;
  onRepoint: (index: number, targetId: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const broken = problems.length > 0;
  return (
    <li
      data-scenario={scenario.name}
      className={`flex flex-col gap-1 rounded-token border px-2 py-1.5 ${position !== null ? "border-accent bg-accent-soft/60" : "border-line"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
            {position !== null && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs text-accent-fg" title="Order in the stack">
                {position}
              </span>
            )}
            {scenario.name}
            {broken && (
              <span
                className="rounded-token border border-crit bg-crit-soft px-1 text-xs font-normal"
                title={problems.map((p) => p.message).join(" ")}
                data-needs-attention
              >
                Needs attention
              </span>
            )}
          </p>
          {scenario.description && <p className="text-xs text-fg-2">{scenario.description}</p>}
        </div>
        <button type="button" onClick={onToggle} disabled={broken && position === null} aria-pressed={position !== null} className={buttonClass}>
          {position !== null ? "Remove" : "Apply"}
        </button>
      </div>
      <ul className="text-xs text-fg-3">
        {scenario.patch.map((p, i) => (
          <li key={i}>{describePatch(model, p, retired, viewer)}</li>
        ))}
      </ul>
      {broken && (
        <div className="flex flex-col gap-1 rounded-token border border-crit bg-crit-soft/50 p-1.5 text-xs" role="note">
          <p className="font-semibold text-crit">
            Left out of the comparison until {problems.length === 1 ? "this change is" : "these changes are"} re-pointed:
          </p>
          <ul className="flex flex-col gap-1.5">
            {problems.map((p) => (
              <BrokenChange key={p.index} model={model} viewer={viewer} problem={p} canEdit={canEdit} busy={busy} onRepoint={(id) => onRepoint(p.index, id)} />
            ))}
          </ul>
        </div>
      )}
      {canEdit && (
        <div className="flex gap-2">
          <button type="button" onClick={onDuplicate} disabled={busy} className={buttonClass}>
            Duplicate
          </button>
          {confirming ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  onDelete();
                }}
                disabled={busy}
                className="rounded-token bg-crit px-2 py-0.5 text-xs font-semibold text-crit-fg"
              >
                Delete “{scenario.name}”
              </button>
              <button type="button" onClick={() => setConfirming(false)} className={buttonClass}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} disabled={busy} className={buttonClass}>
              Delete
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function ScenarioLibrary({
  scenarios,
  model,
  viewer,
  stack,
  problems,
  retired = {},
  canEdit,
  leverCount,
  busy,
  error,
  onToggle,
  onClear,
  onRepoint,
  onSave,
  onDuplicate,
  onDelete,
}: {
  scenarios: ScenarioRow[];
  model: EngineModel;
  /** Who is looking: other people are named "A team member" (B1 2b). */
  viewer?: Viewer;
  stack: string[];
  problems: Record<string, BrokenPatch[]>;
  /** Steps the model no longer has, to name them in broken changes. */
  retired?: RetiredSteps;
  canEdit: boolean;
  /** Levers moved off neutral, which "Save" would store. */
  leverCount: number;
  busy: boolean;
  error: string | null;
  onToggle: (id: string) => void;
  onClear: () => void;
  /** Point patch `index` of a scenario at another target (issue #16). */
  onRepoint: (id: string, index: number, targetId: string) => void;
  onSave: (name: string, description: string) => Promise<boolean>;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await onSave(name, description)) {
      setName("");
      setDescription("");
    }
  };
  return (
    <section aria-labelledby="scenarios-heading" className="flex flex-col gap-2 rounded-token border border-line bg-panel p-3 shadow-token">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="scenarios-heading" className="text-sm font-bold">
          Scenarios
        </h2>
        {stack.length > 0 && (
          <button type="button" onClick={onClear} className="text-xs text-fg-2 underline">
            Remove all ({stack.length})
          </button>
        )}
      </div>
      <p className="text-xs text-fg-3">
        Apply one to compare it with today; apply more to stack them, in the order applied.
        {!canEdit && " You can apply and compare scenarios; editors can save and delete them."}
      </p>
      {error && (
        <p role="alert" className="rounded-token border border-crit bg-crit-soft px-2 py-1 text-xs">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {scenarios.map((s) => {
          const at = stack.indexOf(s.id);
          return (
            <ScenarioItem
              key={s.id}
              scenario={s}
              model={model}
              viewer={viewer}
              position={at >= 0 ? at + 1 : null}
              problems={problems[s.id] ?? []}
              retired={retired}
              canEdit={canEdit}
              busy={busy}
              onToggle={() => onToggle(s.id)}
              onRepoint={(index, targetId) => onRepoint(s.id, index, targetId)}
              onDuplicate={() => onDuplicate(s.id)}
              onDelete={() => onDelete(s.id)}
            />
          );
        })}
        {!scenarios.length && <li className="text-xs text-fg-3">No saved scenarios yet.</li>}
      </ul>
      {canEdit && (
        <form onSubmit={submit} className="flex flex-col gap-1.5 border-t border-line pt-2">
          <label htmlFor="scenario-name" className="text-xs font-medium text-fg-2">
            Save the levers as a scenario
          </label>
          <input
            id="scenario-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME}
            placeholder="e.g. Automate proposals"
            className="rounded-token border border-line bg-panel px-2 py-1 text-sm"
          />
          <textarea
            aria-label="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={MAX_DESCRIPTION}
            rows={2}
            placeholder="What it stands for (optional)"
            className="rounded-token border border-line bg-panel px-2 py-1 text-sm"
          />
          <button
            type="submit"
            disabled={busy || !leverCount || !name.trim()}
            className="self-start rounded-token bg-accent px-3 py-1 text-sm font-semibold text-accent-fg disabled:opacity-50"
          >
            Save {leverCount ? `${leverCount} lever change${leverCount === 1 ? "" : "s"}` : "levers"}
          </button>
          {!leverCount && <p className="text-xs text-fg-3">Move a lever first.</p>}
        </form>
      )}
    </section>
  );
}
