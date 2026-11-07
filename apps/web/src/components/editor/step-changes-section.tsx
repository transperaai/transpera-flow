"use client";

// "Automation and augmentation" in a step's panel (D53, part B). On a solution's version a Step offers "Automate…" and "Augment…", and lists the
// changes that act on it, each with Edit; every edit is one save into the solution's `step_changes` (a server action, as the solution's other
// writes). On the live process it points at making a solution first. The Sandbox runs the changes by picking the solution on the company map.

import { useState } from "react";
import { saveStepChange } from "@/app/w/[slug]/solution-actions";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import type { ChangesOnSteps } from "@/components/step-base-values";
import type { ChangeOnStep } from "@/lib/solutions/step-changes";
import { StepChangeDialog } from "./step-change-dialog";
import type { StepChangeEdit, StepChangeInput } from "@transpera-flow/db";

type Open = { kind: StepChangeInput["kind"]; existing: ChangeOnStep | null };

export function StepChangesSection({ stepId, stepName, tiers, data }: { stepId: string; stepName: string; tiers: string[]; data?: ChangesOnSteps }) {
  const [open, setOpen] = useState<Open | null>(null);
  if (!data) return <div data-slot="changes-on-step" hidden />;
  const mine = data.changes.filter((c) => c.steps.includes(stepId));
  const edit = data.edit;
  const inSolution = edit?.stepIds.includes(stepId) ?? false;
  if (!edit && !data.makeSolutionHref && !data.unsavedSolution && !mine.length) return <div data-slot="changes-on-step" hidden />;

  async function send(e: StepChangeEdit): Promise<string | null> {
    if (!edit) return "This solution can't be changed from here.";
    const r = await saveStepChange(edit.workspaceId, edit.solutionId, e);
    if (r.status === "error") return r.message;
    edit.onChanged?.(r.changes);
    setOpen(null);
    return null;
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
              </span>
              {edit && inSolution && (
                <Button type="button" variant="outline" size="sm" onClick={() => setOpen({ kind: c.kind, existing: c })} data-change-edit>
                  Edit
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {edit && inSolution && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen({ kind: "automation", existing: null })} data-change-automate>
            Automate…
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen({ kind: "augmentation", existing: null })} data-change-augment>
            Augment…
          </Button>
        </div>
      )}
      {edit && !inSolution && (
        <p className="text-xs text-muted-foreground" data-change-not-saved>
          This step isn&apos;t in the saved solution yet, so it can&apos;t take an automation. Save the solution with it first.
        </p>
      )}
      {data.makeSolutionHref && (
        <a href={data.makeSolutionHref} className="text-xs font-medium text-accent hover:underline" data-make-solution>
          Make a solution to try an automation
        </a>
      )}
      {data.unsavedSolution && (
        <p className="text-xs text-muted-foreground" data-change-unsaved-solution>
          Save this solution first. Then open it from its page to add an automation or augmentation to a step.
        </p>
      )}
      {mine.length > 0 && (
        <a href={data.sandboxHref} className="text-xs font-medium text-accent hover:underline">
          Try this version in the Sandbox
        </a>
      )}

      {open && edit && (
        <StepChangeDialog
          key={open.existing?.id ?? open.kind}
          stepId={stepId}
          stepName={stepName}
          kind={open.kind}
          existing={open.existing?.value ?? null}
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
