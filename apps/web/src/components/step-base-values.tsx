"use client";

// A step's base values for capacity (P4, requirements section 7), laid out as the prototype's step inspector does: how often
// (read from the servicing links), the tier multiplier on time, who (the client's manager), the source of each value, and the
// work split with a line about each part. Every control saves through the process editor, so each change is one undo.
// `readOnly` shows the same values as plain text (a Viewer never reaches the Editor, but the values read the same anywhere).

import { useId, useState } from "react";
import { engineRecurrence, STEP_SOURCE_LABELS, type ProcessBundle, type RecurrenceJson, type StepRow, type StepSourcedValue } from "@transpera-flow/db";
import { recurrenceLabel } from "@transpera-flow/engine";
import { NumberField, SelectField, TextField } from "@/components/fields";
import { Help } from "@/components/help";
import { SplitBar, SplitLegend } from "@/components/split-bar";
import {
  clearStepSplit,
  rebalance,
  setSourceLabel,
  setSplitNote,
  setStepSplit,
  setTierMultiplier,
  setToClientManager,
  SOURCE_OPTIONS,
  SOURCED_VALUE_LABELS,
  SPLIT_LABELS,
  SPLIT_PARTS,
  SPLIT_STEP,
  sourceLabelOf,
  splitPercents,
  type Percents,
} from "@/lib/editor/base-values";
import type { ProcessEditor } from "@/lib/editor/editor";
import type { Edit } from "@/lib/editor/ops";
import type { SaveOutcome, Saver } from "@/lib/fields/field-controller";
import { DEFAULT_TIER_SETUP, type TierSetup } from "@/lib/tier-setup";

const sectionClass = "flex flex-col gap-3 border-t border-line pt-3";
const DRIVER_WORDS: Record<string, string> = { words: "words", links: "links", techHours: "tech hours", meetings: "meetings", builds: "builds", creativeSets: "creative sets", channels: "channels", adhoc: "ad hoc requests" };

/** A recurrence in words, as the Settings page says it. */
function recurrenceWords(r: RecurrenceJson): string {
  const e = engineRecurrence(r);
  return e ? recurrenceLabel(e) : "–";
}

/** "Words ÷ 1,000" for a driver, as the label of what the tier supplies. */
const driverWords = (r: Extract<RecurrenceJson, { driver: string }>): string => `${DRIVER_WORDS[r.driver] ?? r.driver}${r.per && r.per !== 1 ? ` ÷ ${r.per.toLocaleString("en-US")}` : ""}`;

/** The pill that says where a value came from. */
export function SourcePill({ label }: { label: string | null }) {
  const option = SOURCE_OPTIONS.find((o) => o.value === label);
  if (!option) return null;
  const tone = option.value === "measured" ? "border-good bg-good-soft" : option.value === "estimate" ? "border-warn bg-warn-soft" : "border-line bg-panel-2";
  return (
    <span data-source-pill={option.value} className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
      {option.confidence}
    </span>
  );
}

function SourceSelect({ step, value, save, disabled }: { step: StepRow; value: StepSourcedValue; save: (label: string | null) => void; disabled: boolean }) {
  const id = useId();
  const label = sourceLabelOf(step, value);
  return (
    <div className="flex items-center gap-2 text-xs" data-source-for={value}>
      <label htmlFor={id} className="text-fg-2">
        {SOURCED_VALUE_LABELS[value]} came from
      </label>
      <select
        id={id}
        disabled={disabled}
        value={label ?? ""}
        onChange={(e) => save(e.target.value || null)}
        className="rounded-token border border-line bg-panel px-1.5 py-0.5"
      >
        <option value="">Not said</option>
        {STEP_SOURCE_LABELS.map((l) => (
          <option key={l} value={l}>
            {SOURCE_OPTIONS.find((o) => o.value === l)!.label}
          </option>
        ))}
      </select>
      <SourcePill label={label} />
    </div>
  );
}

export function StepBaseValues({
  bundle,
  step,
  editor,
  stamp,
  tierSetup = DEFAULT_TIER_SETUP,
  readOnly = false,
  settingsHref,
}: {
  bundle: ProcessBundle;
  step: StepRow;
  editor: ProcessEditor;
  stamp: () => { at: string; by?: string | null };
  tierSetup?: TierSetup;
  readOnly?: boolean;
  settingsHref?: string;
}) {
  const servicing = bundle.process.kind === "servicing";
  const run = (build: (b: ProcessBundle) => Edit | null) => editor.run(build);
  const saved = <T extends string | number | boolean | null>(value: T): SaveOutcome<T> => ({ status: "saved", value });
  const hasTiers = servicing || step.tier_multiplier !== null || step.to_client_manager;

  const links = (bundle.servicingLinks ?? []).filter((l) => l.process_id === bundle.process.id);
  const serviceName = (id: string) => bundle.services?.find((s) => s.id === id)?.name ?? "A service";

  const percents = splitPercents(step.split);
  const [drag, setDrag] = useState<Percents | null>(null);
  const shown = drag ?? percents;
  const commitSplit = (p: Percents) => {
    setDrag(null);
    run((b) => setStepSplit(b, step.id, p));
  };

  const tierSave = (tier: string): Saver<number | null> => async (_base, next) => {
    run((b) => setTierMultiplier(b, step.id, tier, next));
    return saved(next);
  };
  const tiers = [...new Set([...tierSetup.keys, ...Object.keys(step.tier_multiplier ?? {})])];

  return (
    <div data-base-values className="flex flex-col gap-3">
      {servicing && (
        <div className={sectionClass} data-how-often>
          <p className="flex items-center text-xs font-semibold text-fg-2">
            How often
            <Help
              label="How often"
              description="How often a client's tier asks for this work. It is set on the link between a service and this process, not on the step; a step that follows a tier deliverable reads its value from Tiers & clients."
              example="Content, per 1,000 words: from the tier's words, so Tier 1 at 4,000 words is four runs a month."
            />
          </p>
          {links.length === 0 ? (
            <p className="text-xs text-fg-2">No service runs this process yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {links.map((l) => {
                const r = l.recurrence as RecurrenceJson;
                if ("driver" in r) {
                  const service = tierSetup.services?.[l.service_id];
                  const values = tierSetup.services
                    ? tierSetup.keys.flatMap((k) => {
                        const own = Object.entries(tierSetup.services!).find(([id, s]) => s.tier === k && links.some((x) => x.service_id === id));
                        const v = own?.[1].deliverables[r.driver as keyof NonNullable<typeof service>["deliverables"]];
                        return v === undefined ? [] : [`${k} ${v}`];
                      })
                    : [];
                  return (
                    <li key={l.id} data-recurrence="driver">
                      <span className="font-semibold">{serviceName(l.service_id)}</span>: from the tier ({driverWords(r)}),{" "}
                      {tierSetup.services && values.length ? values.join(" · ") : "Set in Tiers & clients"}
                    </li>
                  );
                }
                return (
                  <li key={l.id} data-recurrence="fixed">
                    <span className="font-semibold">{serviceName(l.service_id)}</span>: {recurrenceWords(r)}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-[11px] text-fg-3">
            Set on the servicing link in {settingsHref ? <a className="underline" href={settingsHref}>Settings</a> : "Settings"}; the Editor shows it here but does not change it.
          </p>
        </div>
      )}

      {hasTiers && (
        <div className={sectionClass} data-tier-multiplier>
          <p className="flex items-center text-xs font-semibold text-fg-2">
            Tier multiplier on time
            <Help
              label="Tier multiplier on time"
              description="Multiplies this step's time for a client of each tier. Leave a tier blank for 1 (no change). 1.3 means 30% longer."
              example="Pacing for a Tier 1 client takes 1.3 times as long as the base time."
            />
          </p>
          <div className="grid grid-cols-3 gap-2">
            {tiers.map((t) => (
              <NumberField
                key={t}
                label={t}
                value={step.tier_multiplier?.[t] ?? null}
                optional
                min={0}
                max={100}
                step={0.1}
                placeholder="1"
                disabled={readOnly}
                save={tierSave(t)}
              />
            ))}
          </div>
          <SourceSelect step={step} value="tier_multiplier" disabled={readOnly} save={(l) => run((b) => setSourceLabel(b, step.id, "tier_multiplier", l as never, stamp()))} />
        </div>
      )}

      {servicing || step.to_client_manager ? (
        <div className={sectionClass} data-who-manager>
          <SelectField
            label="Goes to"
            help={{
              description: "Send this step to the client's own manager, whoever holds the client, in place of the role's pool. The role above stays as the fallback for a client with no manager.",
              example: "Monthly pacing goes to the client's manager; the Strategist role covers a client who has none.",
            }}
            value={step.to_client_manager ? "manager" : null}
            options={[{ value: "manager", label: "The client's manager" }]}
            noneLabel="The role or pinned person above"
            disabled={readOnly}
            hint={step.to_client_manager && step.role_id === null ? "Give it a role too: it falls back to that role when a client has no manager." : undefined}
            save={async (_base, next) => {
              run((b) => setToClientManager(b, step.id, next === "manager"));
              return saved(next);
            }}
          />
        </div>
      ) : null}

      <div className={sectionClass} data-work-split>
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center text-xs font-semibold text-fg-2">
            Work split (sums to 100%)
            <Help
              label="Work split"
              description="How the step's hands-on time divides: the part that could be automated, the part a tool could speed up, and the part that stays manual. A change acts on the first two; the future time is worked out from these, never typed in."
              example="Pacing: 70% pulling spend and budgets, 20% working out the new budget, 10% deciding and changing it."
            />
          </p>
          {step.split && !readOnly && (
            <button type="button" onClick={() => run((b) => clearStepSplit(b, step.id))} className="text-xs text-fg-2 underline" data-clear-split>
              Clear split
            </button>
          )}
        </div>
        {!step.split && <p className="text-xs text-fg-2">No split entered: the whole time counts as manual. Move a slider to enter one.</p>}
        {SPLIT_PARTS.map((part, i) => (
          <div key={part} className="flex flex-col gap-1" data-split-part={part}>
            <label className="flex flex-col gap-1 text-xs font-semibold">
              <span>
                {SPLIT_LABELS[part]}: <b className="tabular-nums" data-split-value={part}>{shown[i]}%</b>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={SPLIT_STEP}
                value={shown[i]}
                disabled={readOnly}
                aria-label={`${SPLIT_LABELS[part]} share`}
                onChange={(e) => setDrag(rebalance(shown, i as 0 | 1 | 2, Number(e.target.value)))}
                onPointerUp={() => drag && commitSplit(drag)}
                onKeyUp={() => drag && commitSplit(drag)}
                onBlur={() => drag && commitSplit(drag)}
                className="w-full accent-[var(--accent)]"
              />
            </label>
            <TextField
              label={`What the ${SPLIT_LABELS[part].toLowerCase()} part is`}
              value={step.split_notes?.[part] ?? null}
              optional
              disabled={readOnly}
              save={async (_base, next) => {
                run((b) => setSplitNote(b, step.id, part, next));
                return saved(next);
              }}
            />
          </div>
        ))}
        <SplitBar split={{ automatable: shown[0] / 100, augmentable: shown[1] / 100, manual: shown[2] / 100 }} />
        <SplitLegend />
        <SourceSelect step={step} value="split" disabled={readOnly} save={(l) => run((b) => setSourceLabel(b, step.id, "split", l as never, stamp()))} />
      </div>

      <div className={sectionClass} data-time-source>
        <SourceSelect step={step} value="work" disabled={readOnly} save={(l) => run((b) => setSourceLabel(b, step.id, "work", l as never, stamp()))} />
      </div>

      {/* Changes that act on this step are stored by the Sandbox (P7); this slot is left for them. */}
      <div data-slot="changes-on-step" hidden />
    </div>
  );
}
