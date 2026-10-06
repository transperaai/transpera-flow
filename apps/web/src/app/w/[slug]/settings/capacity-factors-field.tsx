"use client";

import { useState, useTransition } from "react";
import { NumberField } from "@/components/fields";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import type { PersonDetail, WorkspaceSettingsData } from "@/lib/data";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { FACTOR_HELP, factorWords } from "@/lib/people";
import { savePersonCapacityFactor } from "./actions";

// Per-person times for one person (C6, #198): one optional "Every step" time and one optional time per step they can do, in the
// order of the process's steps (never sorted by value). Shown only when the workspace switch is on. Never ranked, never compared
// across people, never in a table column.

/** The steps a person can do: their skills if they have any, otherwise the steps of their roles, in `data.steps` order. */
export function stepsFor(person: PersonDetail, data: WorkspaceSettingsData): WorkspaceSettingsData["steps"] {
  const skills = new Set(data.personSkills.filter((s) => s.person_id === person.id).map((s) => s.step_id));
  const roles = new Set(data.personRoles.filter((r) => r.person_id === person.id).map((r) => r.role_id));
  return data.steps.filter((s) => (skills.size > 0 ? skills.has(s.id) : s.role_id !== null && roles.has(s.role_id)));
}

/** One factor: the number field, with how it reads in words after the value. */
function FactorField({
  personId,
  stepId,
  label,
  value,
  placeholder,
  disabled,
  help,
}: {
  personId: string;
  stepId: string | null;
  label: string;
  value: number | null;
  placeholder: string;
  disabled: boolean;
  help: { description: string; example: string };
}) {
  const [now, setNow] = useState<number | null>(value);
  const save = async (base: number | null, next: number | null): Promise<SaveOutcome<number | null>> => {
    const outcome = await savePersonCapacityFactor(personId, stepId, base, next);
    if (outcome.status === "saved") setNow(outcome.value);
    return outcome;
  };
  return (
    <NumberField
      label={label}
      value={value}
      save={save}
      optional
      min={0.5}
      max={2}
      step={0.05}
      placeholder={placeholder}
      disabled={disabled}
      hint={now === null ? undefined : <span data-factor-words>{factorWords(now)}</span>}
      help={help}
    />
  );
}

export function CapacityFactors({ person, data }: { person: PersonDetail; data: WorkspaceSettingsData }) {
  const disabled = !data.canEdit;
  const steps = stepsFor(person, data);
  const mine = data.personCapacityFactors.filter((f) => f.person_id === person.id);
  const factorOf = (stepId: string | null) => mine.find((f) => f.step_id === stepId)?.factor ?? null;
  const every = factorOf(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [removing, startRemoving] = useTransition();
  const [error, setError] = useState<string>();

  const doable = new Set(steps.map((s) => s.id));
  const stepName = new Map(data.steps.map((s) => [s.id, s.name]));
  const stale = mine.filter((f) => f.step_id !== null && !doable.has(f.step_id) && !removed.has(f.step_id));
  const hasDefault = every !== null;

  return (
    <fieldset data-capacity-factors-editor>
      <legend className="mb-1 flex items-center text-xs font-medium text-fg-2">
        Time on each step
        <Help label="Time on each step" {...FACTOR_HELP} />
      </legend>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FactorField
          personId={person.id}
          stepId={null}
          label="Every step"
          value={every}
          placeholder="1 (normal)"
          disabled={disabled}
          help={{
            description: "This person's time on every step they do, unless a step below says otherwise.",
            example: "0.9: about 10% faster on everything.",
          }}
        />
        {steps.map((s) => (
          <FactorField
            key={s.id}
            personId={person.id}
            stepId={s.id}
            label={s.name}
            value={factorOf(s.id)}
            placeholder={hasDefault ? "Same as every step" : "1 (normal)"}
            disabled={disabled}
            help={{
              description: `${s.name}: this person's time on this step compared with the role's normal time.`,
              example: `0.8: 20% faster on ${s.name}.`,
            }}
          />
        ))}
      </div>
      {steps.length === 0 && <p className="mt-2 text-fg-3">No steps in a live process for their roles yet, so only &quot;Every step&quot; applies.</p>}
      {stale.length > 0 && (
        <div className="mt-3" data-factors-not-used>
          <p className="flex items-center text-xs font-medium text-fg-2">
            Not used now
            <Help
              label="Not used now"
              description="Times saved for a step this person can no longer do, or that is no longer in a live process. They are kept but the simulation ignores them. Remove the ones you don't need."
              example="Maya's time on Kickoff stays here if she is taken off Kickoff."
            />
          </p>
          <ul className="flex flex-col gap-1">
            {stale.map((f) => (
              <li key={f.step_id} className="flex flex-wrap items-center gap-x-3">
                <span>{stepName.get(f.step_id!) ?? "A step no longer in a live process"}</span>
                <span className="tabular-nums">{f.factor}</span>
                {!disabled && (
                  <Button
                    variant="link"
                    size="xs"
                    className="h-auto p-0 text-muted-foreground underline hover:text-destructive"
                    type="button"
                    disabled={removing}
                    onClick={() =>
                      startRemoving(async () => {
                        const r = await savePersonCapacityFactor(person.id, f.step_id, f.factor, null);
                        if (r.status === "saved" || r.status === "not_found") {
                          setRemoved((prev) => new Set(prev).add(f.step_id!));
                          setError(undefined);
                        } else if (r.status === "conflict") setError("Someone changed that time. Reload to see it.");
                        else setError(r.message);
                      })
                    }
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-crit">
          {error}
        </p>
      )}
    </fieldset>
  );
}
