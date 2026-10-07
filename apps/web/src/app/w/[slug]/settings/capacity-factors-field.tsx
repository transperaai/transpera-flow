"use client";

import { useState, useTransition } from "react";
import { NumberField } from "@/components/fields";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import type { PersonDetail, WorkspaceSettingsData } from "@/lib/data";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { FACTOR_HELP, factorWords, stepsPersonCanDo } from "@/lib/people";
import { savePersonCapacityFactor } from "./actions";

// Per-person times for one person (C6, #198): one optional "Every step" time and one optional time per step they can do, in the
// order of the process's steps (never sorted by value). Shown only when the workspace switch is on. Never ranked, never compared
// across people, never in a table column.

/** The steps a person can do: their skills if they have any, otherwise the steps of their roles, in `data.steps` order. */
export function stepsFor(person: PersonDetail, data: WorkspaceSettingsData): WorkspaceSettingsData["steps"] {
  return stepsPersonCanDo(person.id, data.steps, data.personSkills, data.personRoles);
}

/** How many visits a measured time rests on (0 when not recorded); null when the time was entered (#227). */
const measuredOf = (f: { source: string; items?: number | null } | undefined): number | null => (f && f.source === "measured" ? Number(f.items ?? 0) : null);

/** Saves one time (the Server Action; a test stands in for it). */
export type SaveFactor = typeof savePersonCapacityFactor;

/** One factor: the number field, with how it reads in words after the value. `now` is the value the editor last knew stored. */
function FactorField({
  personId,
  stepId,
  label,
  value,
  measured,
  now,
  onStored,
  saveFactor,
  placeholder,
  disabled,
  help,
}: {
  personId: string;
  stepId: string | null;
  label: string;
  value: number | null;
  /** The stored time was measured from a log (#227): how many visits it rests on (0 when not recorded), else null. A hand edit makes it entered. */
  measured: number | null;
  now: number | null;
  /** The stored value changed: after a save, or when someone else's change showed up as a conflict. */
  onStored: (v: number | null) => void;
  saveFactor: SaveFactor;
  placeholder: string;
  disabled: boolean;
  help: { description: string; example: string };
}) {
  // Editing a measured time by hand turns it `entered` (the database does that), so the line goes.
  const [measuredNow, setMeasuredNow] = useState(measured);
  const save = async (base: number | null, next: number | null): Promise<SaveOutcome<number | null>> => {
    const outcome = await saveFactor(personId, stepId, base, next);
    if (outcome.status === "saved") {
      onStored(outcome.value);
      setMeasuredNow(null);
    } else if (outcome.status === "conflict") {
      onStored(outcome.theirs);
      setMeasuredNow(null);
    }
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
      hint={
        now === null ? undefined : (
          <>
            <span data-factor-words>{factorWords(now)}</span>
            {measuredNow !== null && (
              <span data-factor-measured className="block text-muted-foreground">
                {measuredNow > 0 ? `Measured from ${measuredNow} visits` : "Measured from a log"}
              </span>
            )}
          </>
        )
      }
      help={help}
    />
  );
}

export function CapacityFactors({ person, data, saveFactor = savePersonCapacityFactor }: { person: PersonDetail; data: WorkspaceSettingsData; saveFactor?: SaveFactor }) {
  const disabled = !data.canEdit;
  const steps = stepsFor(person, data);
  const mine = data.personCapacityFactors.filter((f) => f.person_id === person.id);
  // What is stored, as this editor last knew it: kept here (not only in each field) so the other fields' placeholders and the
  // words after each value follow a save or a conflict without a reload.
  const [stored, setStored] = useState<Record<string, number | null>>(() => Object.fromEntries(mine.map((f) => [f.step_id ?? "every", f.factor])));
  const factorOf = (stepId: string | null) => stored[stepId ?? "every"] ?? null;
  const setOne = (stepId: string | null) => (v: number | null) => setStored((prev) => ({ ...prev, [stepId ?? "every"]: v }));
  const every = factorOf(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [removing, startRemoving] = useTransition();
  const [error, setError] = useState<string>();

  const doable = new Set(steps.map((s) => s.id));
  const stepName = new Map(data.steps.map((s) => [s.id, s.name]));
  const stale = mine.filter((f) => f.step_id !== null && !doable.has(f.step_id) && !removed.has(f.step_id)).map((f) => ({ ...f, factor: factorOf(f.step_id) ?? f.factor }));
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
          value={mine.find((f) => f.step_id === null)?.factor ?? null}
          measured={measuredOf(mine.find((f) => f.step_id === null))}
          now={every}
          onStored={setOne(null)}
          saveFactor={saveFactor}
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
            value={mine.find((f) => f.step_id === s.id)?.factor ?? null}
            measured={measuredOf(mine.find((f) => f.step_id === s.id))}
            now={factorOf(s.id)}
            onStored={setOne(s.id)}
            saveFactor={saveFactor}
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
                        const r = await saveFactor(person.id, f.step_id, f.factor, null);
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
