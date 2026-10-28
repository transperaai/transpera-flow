"use client";

// The change list of the scenario on screen (docs/plans/sandbox-p1-brief.md §4): the changes it builds on first (read-only, tagged
// "from <parent>"), then its own, each with edit and remove for those who may. Changes that need attention, and changes dated after
// the horizon, are listed apart and in words. A Viewer sees the list read-only.

import { Plus } from "lucide-react";
import Link from "next/link";
import { leverHidden, sandboxLever, type SandboxChange } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SANDBOX_HELP } from "@/lib/forecast/help";
import { EDIT_ONLY } from "@/lib/phone";
import { describeChange, whenOf, type DescribeContext } from "@/lib/sandbox/describe";
import type { EffectiveChange } from "@/lib/sandbox/effective";
import type { ChangeProblem } from "@/lib/sandbox/run";

export interface ChangeListProps {
  ctx: DescribeContext;
  changes: EffectiveChange[];
  problems: ChangeProblem[];
  /** Ids of changes dated at or after the horizon. */
  later: string[];
  /** The kinds hidden in Settings, Levers: a saved change of one still applies and says so. */
  hiddenKinds: readonly string[];
  /** Why a lever would not move the result in this model, or null. */
  appliesReason: (leverId: string) => string | null;
  /** The same for one change (a type on a model that keeps its clients as one pool). */
  changeReason?: (c: SandboxChange) => string | null;
  leversHref: string | null;
  canEdit: boolean;
  /** Something to edit (a scenario, saved or new, is on screen). */
  hasScenario: boolean;
  /** The Sandbox has saved scenarios, or the admin can start one: wording of the empty state. */
  hasSaved: boolean;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onNew: () => void;
}

export function ChangeList(p: ChangeListProps) {
  const problemOf = new Map(p.problems.map((x) => [x.changeId, x]));
  const laterSet = new Set(p.later);
  const attention = p.changes.filter((e) => problemOf.get(e.change.id) && !problemOf.get(e.change.id)!.note);
  const afterHorizon = p.changes.filter((e) => laterSet.has(e.change.id));

  if (!p.hasScenario) {
    return (
      <Card className="px-4 py-3 text-sm text-muted-foreground" data-changes-empty="none">
        {p.canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <span>{p.hasSaved ? "You're looking at your live model: no changes." : "No scenarios yet. Start one to try a change: a hire, a price change, a solution going live."}</span>
            <Button variant="outline" onClick={p.onNew} className={EDIT_ONLY} data-edit-entry>
              <Plus aria-hidden /> New scenario
            </Button>
          </div>
        ) : p.hasSaved ? (
          "You're looking at your live model: no changes. Pick a saved scenario to run it."
        ) : (
          "No saved scenarios yet. An Agency admin can save one for you to run."
        )}
      </Card>
    );
  }

  return (
    <section className="flex flex-col gap-2" data-change-list>
      <h3 className="flex items-center text-sm font-medium">
        Changes
        <Help {...SANDBOX_HELP.changes} />
      </h3>
      {p.changes.length === 0 ? (
        <Card className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm text-muted-foreground" data-changes-empty="scenario">
          {p.canEdit ? (
            <>
              No changes yet
              <Button variant="outline" onClick={p.onAdd} className={EDIT_ONLY} data-edit-entry>
                <Plus aria-hidden /> Add change
              </Button>
            </>
          ) : (
            "This scenario has no changes"
          )}
        </Card>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {p.changes.map((e) => {
            const c = e.change;
            const lever = sandboxLever(c.lever);
            const problem = problemOf.get(c.id);
            const hidden = lever ? leverHidden(lever, p.hiddenKinds) : false;
            const reason = lever ? (p.appliesReason(lever.id) ?? p.changeReason?.(c) ?? null) : null;
            return (
              <li key={c.id} data-change={c.id} data-inherited={e.inherited || undefined}>
                <Card className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className={e.inherited ? "text-muted-foreground" : undefined}>{describeChange(c, p.ctx)}</span>{" "}
                    <span className="text-muted-foreground">{whenOf(c) ?? "the whole run"}</span>
                    {e.inherited ? <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">from {e.scenarioName}</span> : null}
                    {hidden ? (
                      <span className="ml-2 text-xs text-muted-foreground" data-change-hidden>
                        hidden in{" "}
                        {p.leversHref ? (
                          <Link href={p.leversHref} className="underline">
                            Settings, Levers
                          </Link>
                        ) : (
                          "Settings, Levers"
                        )}
                        <Help {...SANDBOX_HELP.hidden} />
                      </span>
                    ) : null}
                    {problem ? <span className={problem.note ? "ml-2 block text-xs text-muted-foreground" : "ml-2 block text-xs text-destructive"}>{problem.message}</span> : null}
                    {reason && !problem ? <span className="ml-2 block text-xs text-muted-foreground">Does nothing in this model: {reason}</span> : null}
                  </span>
                  {p.canEdit && !e.inherited ? (
                    <span className={`flex gap-1 ${EDIT_ONLY}`} data-edit-entry>
                      <Button variant="ghost" size="sm" onClick={() => p.onEdit(c.id)} aria-label={`Edit: ${describeChange(c, p.ctx)}`}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => p.onRemove(c.id)} aria-label={`Remove: ${describeChange(c, p.ctx)}`}>
                        Remove
                      </Button>
                    </span>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {attention.length ? (
        <p className="text-sm" data-needs-attention>
          <b className="font-medium">Needs attention:</b> {attention.map((e) => `${describeChange(e.change, p.ctx)} (${problemOf.get(e.change.id)!.message})`).join("; ")}. These are skipped in the run.
        </p>
      ) : null}
      {afterHorizon.length ? (
        <p className="text-sm text-muted-foreground" data-after-horizon>
          After this horizon: {afterHorizon.map((e) => `${describeChange(e.change, p.ctx)} (${whenOf(e.change)})`).join("; ")}.
        </p>
      ) : null}
    </section>
  );
}
