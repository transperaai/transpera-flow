"use client";

// "Automation and augmentation" in a step's panel (D53, part B). On a solution's version a Step offers "Automate…" and "Augment…", and lists the
// changes that act on it, each with Edit; every edit goes into the solution's list of changes (part of the solution being edited, saved with it by Save solution). On the live process it points at making a solution first. The Sandbox runs the changes by picking the solution on the company map.

import { useState } from "react";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import type { ChangesOnSteps } from "@/components/step-base-values";
import type { Percents } from "@/lib/editor/base-values";
import { changeWarning, zeroPartWarning, type ChangeOnStep } from "@/lib/solutions/step-changes";
import { StepChangeDialog } from "./step-change-dialog";
import type { StepChangeEdit, StepChangeInput } from "@transpera-flow/db";

type Open = { kind: StepChangeInput["kind"]; existing: ChangeOnStep | null };

export function StepChangesSection({ stepId, stepName, tiers, split, data }: { stepId: string; stepName: string; tiers: string[]; split: Percents; data?: ChangesOnSteps }) {
  const [open, setOpen] = useState<Open | null>(null);
  if (!data) return <div data-slot="changes-on-step" hidden />;
  const mine = data.changes.filter((c) => c.steps.includes(stepId));
  const edit = data.edit;
  if (!edit && !data.makeSolutionHref && !mine.length) return <div data-slot="changes-on-step" hidden />;

  async function send(e: StepChangeEdit): Promise<string | null> {
    if (!edit) return "This solution can't be changed from here.";
    const problem = edit.apply(e);
    if (!problem) setOpen(null);
    return problem;
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3 text-sm" data-slot="changes-on-step">
      <h4 className="flex items-center text-xs font-semibold tracking-wide text-fg-3 uppercase">
        Automation and augmentation
        <Help
          label="Automation and augmentation"
          description="A change to this step's time that belongs to a solution: take some of its automatable time away, or speed up its augmentable time. You see it in the Sandbox by picking the solution on the company map."
          example="Automate the pacing check, so most of its hands-on time goes."
        />
      </h4>

      {mine.length > 0 && (
        <ul className="flex flex-col gap-1">
          {mine.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2" data-change-on-step={c.id}>
              <span className="min-w-0 break-words">
                {c.name} <span className="text-xs text-muted-foreground">({c.kind})</span>
                {changeWarning(c.value, stepId, split) && (
                  <span className="block text-xs text-warn" data-change-warning>
                    {changeWarning(c.value, stepId, split)}
                  </span>
                )}
              </span>
              {edit && (
                <Button type="button" variant="outline" size="sm" onClick={() => setOpen({ kind: c.kind, existing: c })} data-change-edit>
                  Edit
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {edit && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen({ kind: "automation", existing: null })} data-change-automate>
            Automate…
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen({ kind: "augmentation", existing: null })} data-change-augment>
            Augment…
          </Button>
        </div>
      )}
      {data.makeSolutionHref && (
        <a href={data.makeSolutionHref} className="text-xs font-medium text-accent hover:underline" data-make-solution>
          Make a solution to try an automation
        </a>
      )}
      {open && edit && (
        <StepChangeDialog
          key={open.existing?.id ?? open.kind}
          stepId={stepId}
          stepName={stepName}
          kind={open.kind}
          existing={open.existing?.value ?? null}
          warning={zeroPartWarning(open.kind === "automation" ? "automatable" : "augmentable", split)}
          stepIds={new Set(edit.stepIds)}
          tiers={tiers.map((t) => ({ key: t, name: t }))}
          onSave={(change) => send({ op: "save", key: open.existing?.id ?? null, change })}
          onRemove={open.existing ? () => send({ op: "remove", key: open.existing!.id }) : undefined}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
