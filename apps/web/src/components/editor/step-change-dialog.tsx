"use client";

// "Automate…" and "Augment…" on a step (D53; changes-into-solutions brief, part B): the fields of one step change, saved into the solution this
// editor was opened on. An automation takes a share of the step's automatable time away (leaving some checking); an augmentation speeds up its
// augmentable time. Adoption, months to full effect, the tiers it applies to and what it costs a month are the change's own. A change that also
// acts on other steps keeps those effects as they are: this form edits what it does to this step.

import { useState } from "react";
import { checkStepChange, type StepChangeInput, type StoredStepChange } from "@transpera-flow/db";
import type { StepChangeEffect } from "@transpera-flow/engine";
import { ChecklistField } from "@/components/fields";
import { HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const num = (s: string): number => (s.trim() === "" ? NaN : Number(s));
const shown = (n: number): string => String(Math.round(n * 1e6) / 1e6);

interface FormValues {
  name: string;
  kind: StepChangeInput["kind"];
  remove: string;
  checking: string;
  factor: string;
  adoption: string;
  ramp: string;
  cost: string;
  tiers: string[];
}

/** The effect a form of this kind makes on a step, from the typed values. */
function formEffect(stepId: string, v: FormValues): StepChangeEffect {
  if (v.kind === "augmentation") return { step: stepId, part: "augmentable", factor: num(v.factor) };
  const minutes = num(v.checking);
  return { step: stepId, part: "automatable", remove: num(v.remove) / 100, ...(Number.isFinite(minutes) && minutes > 0 ? { residualHours: minutes / 60 } : {}) };
}

/** The whole change as typed: this step's effect in the place of the one it replaces, every other effect as it was. */
export function stepChangeFromForm(stepId: string, existing: StoredStepChange | null, v: FormValues): StepChangeInput {
  const mine = formEffect(stepId, v);
  const old = existing?.effects ?? [];
  const at = old.findIndex((e) => e.step === stepId && e.part === mine.part);
  const effects = at < 0 ? [...old, mine] : old.map((e, i) => (i === at ? mine : e));
  return {
    name: v.name,
    kind: v.kind,
    effects,
    adoption: num(v.adoption) / 100,
    ramp_months: num(v.ramp),
    tiers: v.tiers.length ? v.tiers : null,
    cost_monthly: v.cost.trim() === "" ? null : num(v.cost),
  };
}

export function StepChangeDialog({
  stepId,
  stepName,
  kind,
  existing,
  stepIds,
  tiers,
  onSave,
  onRemove,
  onClose,
}: {
  stepId: string;
  stepName: string;
  kind: StepChangeInput["kind"];
  /** The change being edited, or null for a new one. */
  existing: StoredStepChange | null;
  /** The steps of the saved solution (an effect must point at one). */
  stepIds: ReadonlySet<string>;
  tiers: { key: string; name: string }[];
  /** Saves; returns why not, or null when it saved. */
  onSave: (input: StepChangeInput) => Promise<string | null>;
  onRemove?: () => Promise<string | null>;
  onClose: () => void;
}) {
  const automation = kind === "automation";
  const mine = existing?.effects.find((e) => e.step === stepId && e.part === (automation ? "automatable" : "augmentable"));
  const otherEffects = existing ? existing.effects.filter((e) => e !== mine).length : 0;
  const [name, setName] = useState(existing?.name ?? `${automation ? "Automate" : "Augment"} ${stepName}`.slice(0, 200));
  const [remove, setRemove] = useState(mine?.part === "automatable" ? shown(mine.remove * 100) : "80");
  const [checking, setChecking] = useState(mine?.part === "automatable" && mine.residualHours ? shown(mine.residualHours * 60) : "");
  const [factor, setFactor] = useState(mine?.part === "augmentable" ? shown(mine.factor) : "1.5");
  const [adoption, setAdoption] = useState(shown((existing?.adoption ?? 0.8) * 100));
  const [ramp, setRamp] = useState(String(existing?.ramp_months ?? 0));
  const [cost, setCost] = useState(existing?.cost_monthly != null ? String(existing.cost_monthly) : "");
  const [picked, setPicked] = useState<string[]>(existing?.tiers ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const value = stepChangeFromForm(stepId, existing, { name, kind, remove, checking, factor, adoption, ramp, cost, tiers: picked });
    const problem = checkStepChange(value, stepIds);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const refused = await onSave(value);
    setBusy(false);
    if (refused) setError(refused);
  }

  const field = "flex min-w-0 flex-col gap-1";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" data-step-change-dialog>
        <DialogHeader>
          <DialogTitle>
            {existing ? "Edit" : automation ? "Automate" : "Augment"} “{stepName}”
          </DialogTitle>
          <DialogDescription>
            {automation
              ? "Say how much of this step's automatable time goes away. It is saved in this solution, and you see it in the Sandbox by picking the solution."
              : "Say how many times faster the augmentable part of this step gets. It is saved in this solution, and you see it in the Sandbox by picking the solution."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className={field}>
            <HelpLabel label="Name" description="What you call this change in the lists and in the Sandbox." example="Draft the monthly report automatically" />
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} aria-label="Name" data-change-name />
          </div>

          {automation ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className={field}>
                <HelpLabel
                  label="Share removed (%)"
                  description="How much of this step's automatable time the automation takes away. The automatable part is set by the work split further up this panel."
                  example="80 takes four fifths of the automatable time away."
                />
                <Input inputMode="decimal" value={remove} onChange={(e) => setRemove(e.target.value)} aria-label="Share removed, percent" data-change-share />
              </div>
              <div className={field}>
                <HelpLabel label="Minutes of checking left" description="Time a person still spends checking the result each time the step runs. Leave it blank for none." example="2 means a person checks for 2 minutes each time." />
                <Input inputMode="decimal" value={checking} placeholder="0" onChange={(e) => setChecking(e.target.value)} aria-label="Minutes of checking left" data-change-checking />
              </div>
            </div>
          ) : (
            <div className={field}>
              <HelpLabel label="Times faster" description="How many times faster the augmentable part of this step gets. 1 changes nothing." example="2 halves the augmentable time." />
              <Input inputMode="decimal" value={factor} onChange={(e) => setFactor(e.target.value)} aria-label="Times faster" data-change-factor />
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className={field}>
              <HelpLabel label="Adoption (%)" description="The share of the work that uses the change once it is fully in place." example="80 means four jobs in five use it." />
              <Input inputMode="decimal" value={adoption} onChange={(e) => setAdoption(e.target.value)} aria-label="Adoption, percent" data-change-adoption />
            </div>
            <div className={field}>
              <HelpLabel label="Months to full effect" description="How many months it takes to reach full adoption once the solution is in use. 0 means at once." example="3 builds up over three months." />
              <Input inputMode="numeric" value={ramp} onChange={(e) => setRamp(e.target.value)} aria-label="Months to full effect" data-change-ramp />
            </div>
            <div className={field}>
              <HelpLabel label="Costs a month" description="What the change costs to run each month, such as a licence. Leave it blank for nothing." example="400 adds 400 a month to the cost of this version." />
              <Input inputMode="decimal" value={cost} placeholder="Nothing" onChange={(e) => setCost(e.target.value)} aria-label="Cost a month" data-change-cost />
            </div>
          </div>

          <ChecklistField
            label="Tiers it applies to"
            help={{ description: "The client tiers that get the change. Leave every box clear and it applies to all of them.", example: "Tick Tier 3 only, and clients on other tiers are not affected." }}
            value={picked}
            options={tiers.map((t) => ({ id: t.key, label: t.name }))}
            emptyLabel="every tier"
            hint="None ticked: every tier."
            save={async (_base, next) => {
              setPicked([...next]);
              return { status: "saved", value: next };
            }}
          />

          {otherEffects > 0 && (
            <p className="text-xs text-muted-foreground" data-change-other-effects>
              This change also acts on {otherEffects === 1 ? "one other part" : `${otherEffects} other parts`} of the process. {otherEffects === 1 ? "It stays" : "They stay"} as {otherEffects === 1 ? "it is" : "they are"}.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-crit" data-change-error>
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="gap-2">
          {existing && onRemove && (
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const refused = await onRemove();
                setBusy(false);
                if (refused) setError(refused);
              }}
              data-change-remove
            >
              Remove
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={save} data-change-save>
            {existing ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
