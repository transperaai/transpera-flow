"use client";

// Draft mode on the process page (issue #9, PRD §7.1b): the Live/Draft switch
// with Publish and Discard, the list of changes against live (each with
// Discard, Restore or Revert), and the draft-vs-live KPI comparison.

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import type { ProcessBundle, StepRow } from "@transpera-flow/db";
import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import { compareRuns } from "@/lib/drafts/compare";
import { discardChange, discardProblem } from "@/lib/drafts/discard";
import type { Change, DraftDiff } from "@/lib/drafts/diff";
import type { DraftSession, DraftState } from "@/lib/drafts/session";
import { describeValue, fieldLabel } from "@/lib/editor/describe";
import type { ProcessEditor } from "@/lib/editor/editor";
import type { BreakingScenario } from "@/lib/scenarios/broken";
import type { Table } from "@/lib/editor/ops";
import { EDIT_ONLY } from "@/lib/phone";

export type DraftView = "draft" | "live";

const button = "rounded-token border border-line bg-panel px-2 py-1 font-semibold hover:bg-panel-2 disabled:cursor-not-allowed disabled:text-fg-3";
const primary = "rounded-token bg-accent px-2.5 py-1 font-semibold text-accent-fg disabled:cursor-not-allowed disabled:opacity-50";
const danger = "rounded-token border border-crit px-2 py-1 font-semibold text-crit hover:bg-crit-soft disabled:cursor-not-allowed disabled:opacity-50";

export function DraftBar({
  session,
  drafts,
  canEdit,
  view,
  onView,
  changes,
  blocked,
  unresolved,
  compare,
  onCompare,
  onReview,
  breaks = [],
}: {
  session: DraftSession;
  drafts: DraftState;
  /** The user may edit (and so publish and discard). */
  canEdit: boolean;
  view: DraftView;
  onView: (view: DraftView) => void;
  /** How many changes the draft has against live. */
  changes: number;
  /** Why publishing has to wait (saving, a conflict, an unsimulatable draft), or null. */
  blocked: string | null;
  /** Steps of the draft still marked as estimates. */
  unresolved: StepRow[];
  compare: boolean;
  onCompare: (on: boolean) => void;
  /** Show a step in the inspector. */
  onReview: (stepId: string) => void;
  /** Saved scenarios that publishing would break (issue #16). */
  breaks?: BreakingScenario[];
}) {
  const [confirming, setConfirming] = useState<"publish" | "discard" | null>(null);
  const hasDraft = drafts.draft !== null || drafts.opening;
  const liveNumber = drafts.live.revision.number;
  const draftNumber = drafts.draft?.number ?? liveNumber + 1;
  const busy = drafts.busy !== null;
  // What a refused publish reported, else what the draft shows now.
  const estimates = drafts.unresolved ?? unresolved.map((s) => ({ id: s.id, name: s.name }));
  // Steps where sources disagree (issue #21); publishing counts them with the estimates.
  const conflicts = unresolved.filter((s) => s.conflict).length;
  // Never published (issue #76): there is no live model yet, only the draft.
  const unpublished = liveNumber === 0;

  // The one-line state of the draft. It truncates in the top bar; the title carries the whole sentence.
  const status =
    unpublished
      ? hasDraft
        ? `This process has never been published: it exists only as this draft${changes ? ` (${plural(changes, "change")})` : ""}. ${canEdit ? "Publish it to make it live." : "It goes live when an editor publishes it."}`
        : canEdit
          ? "This process has never been published. Add steps to start its draft."
          : "This process has never been published."
      : !hasDraft
      ? canEdit
        ? "Edits open a draft; the live model only changes when you publish."
        : "The live model."
      : view === "live"
        ? `The live model, as simulation and forecasts use it. The draft has ${plural(changes, "change")}.`
        : changes
          ? `${plural(changes, "change")} against live${conflicts ? ` · ${plural(conflicts, "conflict")}` : ""}${unresolved.length - conflicts ? ` · ${plural(unresolved.length - conflicts, "unconfirmed estimate")}` : ""}${breaks.length ? ` · publishing breaks ${plural(breaks.length, "saved scenario")}` : ""}.`
          : "No changes against live yet.";

  return (
    <section aria-label="Draft controls" className="contents text-xs">
      {unpublished ? (
        <Badge variant="outline" className="border-warn bg-warn-soft py-1 text-xs text-fg">
          Not published yet{hasDraft ? ` · Draft · version ${draftNumber}` : ""}
        </Badge>
      ) : hasDraft ? (
        <div role="group" aria-label="Show revision" className="flex overflow-hidden rounded-md border border-input bg-panel shadow-xs">
          {(["live", "draft"] as const).map((v) => (
            <Toggle
              key={v}
              size="sm"
              pressed={view === v}
              onPressedChange={() => onView(v)}
              className="h-7 rounded-none px-2.5 text-xs font-semibold [&+&]:border-l"
            >
              {v === "live" ? `Live · version ${liveNumber}` : `Draft · version ${draftNumber}`}
            </Toggle>
          ))}
        </div>
      ) : (
        <Badge variant="outline" className="py-1 text-xs text-fg">
          Live · version {liveNumber}
        </Badge>
      )}
      <p title={status} className="order-last min-w-0 basis-full truncate text-xs text-muted-foreground xl:order-none xl:basis-0 xl:flex-1" aria-live="polite">
        {status}
      </p>
      {hasDraft && (
        <div className="flex flex-wrap items-center gap-1.5">
          {!unpublished && (
            <Button type="button" variant="outline" size="sm" aria-pressed={compare} onClick={() => onCompare(!compare)} className={compare ? "border-accent bg-accent-soft text-accent" : ""}>
              Compare with live
            </Button>
          )}
          {canEdit && (
            <span className={`contents ${EDIT_ONLY}`} data-edit-entry>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setConfirming("discard")} className="border-crit/60 text-destructive hover:bg-crit-soft">
                Discard draft…
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy || !!blocked || !changes || !drafts.draft}
                title={blocked ?? (!changes ? "Nothing to publish yet." : undefined)}
                onClick={() => setConfirming("publish")}
              >
                Publish…
              </Button>
            </span>
          )}
        </div>
      )}

      {confirming === "discard" && (
        <div role="alertdialog" aria-label="Discard the draft" className="order-last flex basis-full flex-wrap items-center gap-2 rounded-token border border-crit bg-crit-soft p-2 text-xs">
          <p className="grow">
            Discard all {plural(changes, "change")} in this draft and go back to live (version {liveNumber})? This can&apos;t be undone.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (await session.discard()) setConfirming(null);
            }}
            className={danger}
          >
            {drafts.busy === "discarding" ? "Discarding…" : "Discard draft"}
          </button>
          <button type="button" onClick={() => setConfirming(null)} className={button} autoFocus>
            Keep editing
          </button>
        </div>
      )}

      {confirming === "publish" && (
        <div role="alertdialog" aria-label="Publish the draft" className="order-last flex max-h-[45svh] basis-full flex-col gap-2 overflow-y-auto rounded-token border border-accent bg-accent-soft p-2 text-xs">
          {estimates.length ? (
            <>
              <p>
                <strong>
                  {plural(estimates.length, "step")} {estimates.length === 1 ? "holds" : "hold"}{" "}
                  {conflicts ? `unresolved conflicts (${conflicts}) or unconfirmed estimates` : "unconfirmed estimates"}.
                </strong>{" "}
                Settle them in the checklist or the inspector first, or publish and accept them as estimates (recorded in the
                audit log).
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {estimates.map((s) => (
                  <li key={s.id}>
                    <button type="button" onClick={() => onReview(s.id)} className={button}>
                      Review {s.name}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>
              Publish this draft as version {draftNumber}? It becomes the live model that simulation and forecasts use.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !!blocked}
              onClick={async () => {
                const r = await session.publish(estimates.length > 0);
                if (r?.status === "published") setConfirming(null);
              }}
              className={primary}
            >
              {drafts.busy === "publishing"
                ? "Publishing…"
                : estimates.length
                  ? `Publish, accepting ${plural(estimates.length, "estimate")}`
                  : `Publish version ${draftNumber}`}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(null);
                session.dismiss();
              }}
              className={button}
            >
              Cancel
            </button>
          </div>
          {blocked && <p className="text-fg-2">{blocked}</p>}
          {breaks.length > 0 && <BreaksWarning breaks={breaks} />}
        </div>
      )}

      {drafts.notice && (
        <p role="status" className="order-last flex basis-full items-center justify-between gap-2 rounded-token border border-good bg-good-soft px-2 py-1">
          {drafts.notice}
          <button type="button" onClick={() => session.dismiss()} className="underline">
            Dismiss
          </button>
        </p>
      )}
      {drafts.error && (
        <p role="alert" className="order-last flex basis-full items-center justify-between gap-2 rounded-token border border-crit bg-crit-soft px-2 py-1">
          {drafts.error}
          <button type="button" onClick={() => session.dismiss()} className="underline">
            Dismiss
          </button>
        </p>
      )}
    </section>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Every change of the draft against live, each with its own Discard, Restore or Revert. */
export function ChangesPanel({
  diff,
  live,
  bundle,
  editor,
  names,
  onSelect,
}: {
  diff: DraftDiff;
  live: ProcessBundle;
  /** The draft as the editor shows it. */
  bundle: ProcessBundle;
  /** Null when read-only. */
  editor: ProcessEditor | null;
  names: Map<string, string>;
  onSelect: (table: Table, id: string) => void;
}) {
  if (!diff.list.length) return null;
  const endpoints = (c: Change) => {
    if (c.table !== "edges") return "";
    const e = (c.draft ?? c.live)!;
    return `${names.get(e.from_step_id) ?? "a step"} → ${names.get(e.to_step_id) ?? "a step"}`;
  };
  return (
    <section aria-label="Changes in this draft" className="flex flex-col gap-2 rounded-token border border-line bg-panel p-3 text-xs shadow-token">
      <h2 className="text-sm font-bold">Changes in this draft ({diff.list.length})</h2>
      <ul className="flex flex-col gap-1.5">
        {diff.list.map((c) => {
          const name = c.table === "steps" ? (c.draft ?? c.live)!.name : endpoints(c);
          const what =
            c.kind === "added"
              ? c.table === "steps"
                ? "New step"
                : "New connection"
              : c.kind === "removed"
                ? c.table === "steps"
                  ? "Removed step"
                  : "Removed connection"
                : null;
          const details =
            c.kind === "changed"
              ? [
                  ...c.fields
                    .filter((f) => f.field !== "outcome" || !c.fields.some((g) => g.field === "kind"))
                    .map((f) => ({
                      key: f.field,
                      text: `${fieldLabel(f.field)} ${describeValue(f.field, f.live, names)} → ${describeValue(f.field, f.draft, names)}`,
                    })),
                  ...(c.table === "steps" && c.moved ? [{ key: "moved", text: "moved" }] : []),
                ]
              : [];
          const problem = discardProblem(bundle, c);
          const action = c.kind === "added" ? "Discard" : c.kind === "removed" ? "Restore" : "Revert";
          return (
            <li key={`${c.table}:${c.id}`} className="flex items-start justify-between gap-2 border-b border-line pb-1.5 last:border-b-0">
              <button
                type="button"
                disabled={c.kind === "removed"}
                onClick={() => onSelect(c.table, c.id)}
                className="min-w-0 grow text-left disabled:cursor-default"
              >
                <span
                  className={`mr-1 inline-block rounded-full border px-1 text-[10px] font-semibold ${
                    c.kind === "removed" ? "border-crit text-crit" : c.kind === "added" ? "border-dashed border-accent" : "border-accent"
                  }`}
                >
                  {c.kind === "added" ? "new" : c.kind === "removed" ? "removed" : "changed"}
                </span>
                {what && <span className="text-fg-2">{what} </span>}
                <span className={`font-semibold ${c.kind === "removed" ? "line-through" : ""}`}>{name}</span>
                {details.map((d) => (
                  <span key={d.key} className="block text-fg-2">
                    {d.text}
                  </span>
                ))}
              </button>
              {editor && (
                <button
                  type="button"
                  disabled={!!problem}
                  title={problem ?? undefined}
                  aria-label={`${action}: ${what ?? name}${what ? ` ${name}` : ""}`}
                  onClick={() => editor.run((b) => discardChange(live, b, c.table, c.id))}
                  data-edit-entry
                  className={`${button} ${EDIT_ONLY}`}
                >
                  {action}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Draft vs live: the headline KPIs of both runs and the change. */
export function DraftCompare({
  live,
  draft,
  currency,
  liveNumber,
  draftNumber,
}: {
  live: { model: EngineModel; result: SimulationResult | null } | null;
  draft: { model: EngineModel; result: SimulationResult | null } | null;
  currency: string;
  liveNumber: number;
  draftNumber: number;
}) {
  const rows =
    live?.result && draft?.result ? compareRuns({ model: live.model, result: live.result }, { model: draft.model, result: draft.result }, currency) : null;
  return (
    <section aria-label="Draft vs live" className="overflow-x-auto rounded-token border border-line bg-panel p-3 shadow-token">
      <h2 className="mb-2 text-sm font-bold">Draft vs live</h2>
      {!draft ? (
        <p className="text-xs text-fg-2">The draft can&apos;t be simulated yet, so there is nothing to compare.</p>
      ) : !rows ? (
        <p role="status" className="text-xs text-fg-2">
          Simulating both…
        </p>
      ) : (
        <>
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="text-left text-fg-3">
                <th scope="col" className="py-1 pr-3 font-semibold">
                  Measure
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-semibold">
                  Live · version {liveNumber}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-semibold">
                  Draft · version {draftNumber}
                </th>
                <th scope="col" className="py-1 text-right font-semibold">
                  Change
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t border-line">
                  <th scope="row" className="py-1 pr-3 text-left font-normal">
                    {r.label}
                  </th>
                  <td className="py-1 pr-3 text-right">{r.live}</td>
                  <td className="py-1 pr-3 text-right">{r.draft}</td>
                  <td
                    className={`py-1 text-right font-semibold ${r.better === true ? "text-good" : r.better === false ? "text-crit" : "text-fg-2"}`}
                  >
                    {r.delta}
                    {r.better !== null && <span className="sr-only">{r.better ? " (better)" : " (worse)"}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-fg-3">
            Means of {live!.result!.reps} replications each, with the same random seed, so the change comes from the draft&apos;s
            edits.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Saved scenarios this draft would break (issue #16): published, each needs
 * attention, is left out of comparisons, and raises an issue until
 * its changes are re-pointed.
 */
export function BreaksWarning({ breaks }: { breaks: BreakingScenario[] }) {
  return (
    <div role="note" data-publish-breaks className="flex flex-col gap-1 rounded-token border border-crit bg-crit-soft p-2">
      <p>
        <strong>
          Publishing breaks {plural(breaks.length, "saved scenario")}.
        </strong>{" "}
        {breaks.length === 1 ? "It" : "Each"} will need attention: left out of comparisons, with an issue raised, until its changes are
        re-pointed under Scenarios.
      </p>
      <ul className="flex flex-col gap-0.5">
        {breaks.map(({ scenario, broken }) => (
          <li key={scenario.id}>
            <strong>“{scenario.name}”</strong>: {broken.map((b) => b.message).join(" ")}
          </li>
        ))}
      </ul>
    </div>
  );
}
