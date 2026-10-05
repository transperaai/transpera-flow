"use client";

// The step inspector (PRD §4.1): every field of the selected step, each saved
// on its own through the process editor, so each change is undoable and
// re-runs the simulation.

import { useEffect, useRef } from "react";
import {
  EVIDENCE_COLUMNS,
  isOpenAssumption,
  triangularRange,
  type Distribution,
  type EvidenceStamp,
  type ProcessBundle,
  type SourceRow,
  type StepKind,
  type StepRow,
} from "@transpera-flow/db";
import { EvidencePanel } from "@/components/evidence";
import { NumberField, SelectField, TextField, type SelectOption } from "@/components/fields";
import { ProvenanceBadge } from "@/components/provenance-badge";
import {
  KIND_LABELS,
  OUTCOME_LABELS,
  STEP_KINDS,
  kindProblem,
  reworkTargets,
  setDistribution,
  setRangePoint,
  setStepKind,
  updateStep,
  type Phase,
} from "@/lib/editor/commands";
import { POSITION } from "@/lib/drafts/discard";
import type { StepChange } from "@/lib/drafts/diff";
import { describeValue, fieldLabel } from "@/lib/editor/describe";
import { PLACED_REMOVE_NOTE } from "@/lib/editor/commands";
import type { ProcessEditor } from "@/lib/editor/editor";
import { readField, type Edit, type Scalar } from "@/lib/editor/ops";
import type { SaveOutcome, Saver } from "@/lib/fields/field-controller";
import { formatHours } from "@/lib/format";
import { selectableRoles } from "@/lib/roles";

const DIST_OPTIONS: SelectOption[] = [
  { value: "lognormal", label: "Usually about this, sometimes much longer" },
  { value: "triangular", label: "Somewhere between min and max, most often the middle value" },
  { value: "constant", label: "Always the same" },
];

/** Engine defaults for a lognormal duration's spread (packages/engine simulate.ts). */
const DEFAULT_CV: Record<Phase, number> = { work: 0.35, wait: 0.3 };

const sectionClass = "flex flex-col gap-3 border-t border-line pt-3";

export function StepInspector({
  bundle,
  step,
  editor,
  autoFocus = false,
  onFocused,
  onClose,
  onDelete,
  draft = null,
  sources = [],
  stamp,
  sourcesHref,
}: {
  bundle: ProcessBundle;
  step: StepRow;
  editor: ProcessEditor;
  /** Put focus in the first field (asked for from the step's menu). */
  autoFocus?: boolean;
  onFocused?: () => void;
  onClose: () => void;
  onDelete: () => void;
  /** In a draft (issue #9): how the draft changed this step against live, and undoing that. */
  draft?: DraftInfo | null;
  /** The workspace's sources, to cite (issue #21). */
  sources?: readonly SourceRow[];
  /** Who and when, for citing and confirming. */
  stamp?: () => EvidenceStamp;
  sourcesHref?: string;
}) {
  const id = step.id;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    onFocused?.();
  }, [autoFocus, onFocused]);
  /**
   * A saver that runs an edit; the editor saves it and reports conflicts
   * itself. With `check`, a field someone else saved while this one was
   * being typed (its stored value is no longer the one editing started from)
   * becomes a keep mine / keep theirs conflict instead of a silent overwrite.
   */
  const via =
    <T extends Scalar>(build: (b: ProcessBundle, value: T) => Edit | null, check?: { field: string; current: T }): Saver<T> =>
    async (base, next) => {
      if (check && !sameish(check.current, base) && !sameish(check.current, next)) {
        editor.raiseConflict({ table: "steps", id, field: check.field, mine: next, theirs: check.current, retry: (b) => build(b, next) });
      } else {
        editor.run((b) => build(b, next));
      }
      return { status: "saved", value: next } as SaveOutcome<T>;
    };
  const field = <T extends Scalar>(name: string) =>
    via<T>((b, v) => updateStep(b, id, { [name]: v }), { field: name, current: readField(step, name) as T });
  // A group (or a step holding a child process) has no numbers of its own: the steps inside it do the work.
  const holder = step.kind === "group" || step.child_process_id !== null;
  const working = step.kind !== "start" && step.kind !== "end" && !holder;
  // A process placed here by a link (B11, B12): named after it. It is taken out with Remove from this map, which leaves the process itself alone.
  const placed = step.child_process_id !== null && step.child_process_id !== undefined;
  const company = bundle.process.is_company === true;

  const kindOptions: SelectOption[] = [...STEP_KINDS, ...(step.kind === "subprocess" || step.kind === "group" ? [step.kind] : [])]
    .filter((k) => k === step.kind || !kindProblem(bundle, id, k))
    .map((k) => ({
    value: k,
    label: KIND_LABELS[k],
  }));
  const roleOptions = selectableRoles(bundle.roles, [step.role_id]).map((r) => ({ value: r.id, label: r.name }));
  const roleNames = new Map(bundle.roles.map((r) => [r.id, r.name]));
  const personOptions = bundle.people
    .filter((p) => p.active || p.id === step.person_id)
    .map((p) => {
      const roles = bundle.personRoles.filter((r) => r.person_id === p.id).map((r) => roleNames.get(r.role_id));
      return { value: p.id, label: roles.length ? `${p.name} (${roles.join(", ")})` : p.name };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const reworkOptions = reworkTargets(bundle, id).map((s) => ({ value: s.id, label: s.name }));

  return (
    <aside
      ref={ref}
      aria-label={`Step: ${step.name}`}
      onKeyDown={(e) => {
        // Escape outside a field closes the inspector and goes back to the step on the map.
        if (e.key !== "Escape" || (e.target as Element).closest("input, select, textarea")) return;
        onClose();
        document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)?.focus();
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-bold">Step</h2>
        <button type="button" onClick={onClose} className="text-fg-2 hover:underline">
          Close
        </button>
      </div>
      {draft?.change && <DraftChanges info={draft} change={draft.change} />}
      {step.assumption && !EVIDENCE_COLUMNS.some((c) => isOpenAssumption(step, c)) && (
        <div role="note" className="flex flex-col gap-1.5 rounded-token border border-warn bg-warn-soft p-2 text-xs">
          <p>
            <strong>Estimate.</strong> This step&apos;s values haven&apos;t been confirmed. Check them, then confirm; a draft
            can&apos;t be published with estimates unless they are accepted as such.
          </p>
          <button
            type="button"
            onClick={() => editor.run((b) => updateStep(b, id, { assumption: false }))}
            className="self-start rounded-token bg-accent px-2 py-0.5 font-semibold text-accent-fg"
          >
            Confirm values
          </button>
        </div>
      )}
      <TextField
        label="Name"
        value={step.name}
        disabled={placed}
        hint={placed ? "Named after its process. Rename the process on its own page." : undefined}
        save={field<string | null>("name")}
        help={{ description: "What this step is called on the map and in the analysis.", example: "“Discovery call” or “Send proposal”." }}
      />
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label="Kind"
          help={{
            description: "What sort of step it is: work someone does, a wait, a decision with branches, or a box that groups other steps.",
            example: "A “Client decision” is a Decision with two branches: signs, or walks away.",
          }}
          value={step.kind}
          options={kindOptions}
          disabled={placed}
          save={via<string | null>((b, v) => (v ? setStepKind(b, id, v as StepKind) : null))}
        />
        {step.kind === "end" && (
          <SelectField
            label="Outcome"
            help={{ description: "How the process finishes here: Won, Lost or simply Done. Wins and losses are what the headline numbers count.", example: "The end step after “Contract signed” is Won." }}
            value={step.outcome}
            options={Object.entries(OUTCOME_LABELS).map(([value, label]) => ({ value, label }))}
            save={via<string | null>((b, v) => (v ? updateStep(b, id, { outcome: v }) : null))}
          />
        )}
      </div>

      {holder && (
        <p className="rounded-token border border-line bg-panel-2 px-2 py-1.5 text-xs text-fg-2">
          {step.kind === "group"
            ? "A group is a box of steps. It has no hours, role or rework of its own: the steps inside it do the work, and the numbers are the same whether it is open or closed on the map."
            : placed && company
              ? "This card is a process placed on the company map. Moving it, or joining it to another with a handoff line, changes only this map: the process itself is never edited here. Open its page to change it."
              : "This step is a link to another process, with its own page and versions. The numbers are those of its steps, and changes to it show here. The process itself is never edited here."}
        </p>
      )}

      {working && (
        <>
          <div className={sectionClass}>
            <SelectField
              label="Who does it"
              help={{
                description: "The role that does this step. Its people are busy while they work on it, so a role with too few people becomes the bottleneck.",
                example: "“Strategist” has 3 people. If every lead needs a strategist, they all queue for those 3.",
              }}
              value={step.role_id} options={roleOptions} noneLabel="No role" save={field("role_id")} />
            {personOptions.length > 0 && (
              <SelectField
                label="Pinned person"
                help={{ description: "Use this when only one named person can do the step. Leave it on “Anyone in the role” if any of them can.", example: "Only Maya can sign off audits, so pin “Audit & proposal” to Maya." }}
                value={step.person_id}
                options={personOptions}
                noneLabel="Anyone in the role"
                save={field("person_id")}
                hint="Only this person works the step."
              />
            )}
          </div>
          <Duration phase="work" title="Hands-on time" step={step} via={via} field={field} />
          <Duration phase="wait" title="Wait" step={step} via={via} field={field} />
          <div className={sectionClass}>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="Rework %"
                help={{ description: "How often work has to be done again.", example: "8 out of every 100 proposals have to be redone." }}
                value={Number(step.rework_rate)}
                scale={100}
                unit="%"
                min={0}
                max={100}
                step={1}
                save={field("rework_rate")}
              />
              <SelectField
                label="Goes back to"
                help={{ description: "Rework goes back to this step when work has to be redone. “This step” means it is simply repeated.", example: "A rejected proposal goes back to “Write proposal”, not to the start." }}
                value={step.rework_to_step_id}
                options={reworkOptions}
                noneLabel="This step"
                save={field("rework_to_step_id")}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="Promised time"
                help={{ description: "The time you promise to get this step done within, such as in a client agreement. It is kept here for reference; the numbers don't use it yet.", example: "24 h to reply to a new enquiry." }}
                value={nullableNumber(step.sla_hours)}
                optional
                unit="h"
                min={0}
                save={field("sla_hours")}
              />
              <NumberField
                label="Work already in progress"
                help={{ description: "How many items are sitting at this step right now. Fill it in on any step and the simulation starts from today's real queues instead of an empty process.", example: "7 proposals are waiting for review today, so enter 7." }}
                value={nullableNumber(step.current_wip)}
                optional
                min={0}
                step={1}
                placeholder="Not entered"
                save={wholeNumber(field("current_wip"))}
                hint={step.current_wip !== null && <ProvenanceBadge step={step} column="current_wip" />}
              />
            </div>
            <p className="text-xs text-fg-3">
              Work already in progress is what sits at this step now. Where to send rework and the promised time are
              saved but don&apos;t change the numbers yet.
            </p>
            <TextField
              label="Tool"
              help={{ description: "The software or channel used for this step, for your own reference.", example: "Xero, Google Docs or Zoom." }}
              value={step.tool}
              optional
              save={field("tool")}
            />
          </div>
          <div className={sectionClass}>
            <p className="text-xs font-semibold text-fg-2">Analysis rules</p>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="Expected wait"
                value={nullableNumber(step.expected_wait_hours)}
                optional
                unit="h"
                min={0}
                placeholder="Default"
                save={field("expected_wait_hours")}
                help={{
                  description:
                    "How long an item can sit in the queue for a person here before it counts as waiting too long. Left blank, the workspace default applies: 1 working day for sales steps, 2 for client work.",
                  example: "4 h at Reply to the lead: a lead that waits 12 h for a reply is waiting 3 times too long.",
                }}
              />
              <NumberField
                label="Lost per day of waiting"
                value={nullableNumber(step.lost_per_day_waiting)}
                optional
                scale={100}
                unit="%"
                min={0}
                max={100}
                step={1}
                placeholder="None"
                save={field("lost_per_day_waiting")}
                help={{
                  description:
                    "The share of items that go cold for each working day they wait here. It turns waiting time into money in the insights. Left blank, waiting shows as time only.",
                  example: "5% a day at Reply to the lead: a lead left 3 days has lost about 15% of its chance of signing.",
                }}
              />
            </div>
            <NumberField
              label="Work lost benchmark"
              value={nullableNumber(step.dropoff_benchmark)}
              optional
              scale={100}
              unit="%"
              min={0}
              max={100}
              step={1}
              placeholder="Not rated"
              save={field("dropoff_benchmark")}
              help={{
                description:
                  "The share of the work leaving this step that you would accept losing here, such as leads that don't go any further. If the simulation loses more than this, the step is flagged. Left blank, the step isn't checked.",
                example: "30% at Check fit: losing 45% of leads here is 1.5 times the benchmark, so it is flagged as Bad.",
              }}
            />
          </div>
        </>
      )}

      {/* Only a top-level pipeline has a time target: a servicing process runs to its tasks' SLAs, and a child
          process is timed as part of the pipeline that holds it. */}
      {step.kind === "start" && bundle.process.kind === "pipeline" && !bundle.process.parent_process_id && (
        <div className={sectionClass}>
          <NumberField
            label="Time target"
            value={nullableNumber(step.target_cycle_hours)}
            optional
            unit="h"
            min={0.1}
            step={1}
            placeholder="Not rated"
            save={field("target_cycle_hours")}
            help={{
              description:
                "How long an item should take from here to the end of the process, in working hours. If the simulation takes longer than this, the process is flagged as too slow. Left blank, the process isn't checked.",
              example: "120 h (about 3 working weeks): if leads take 190 h on average to become clients, that is 1.6 times the target, so it is Operational risk.",
            }}
          />
        </div>
      )}

      {working && (
        <EvidencePanel step={step} editor={editor} sources={sources} stamp={stamp ?? (() => ({ at: new Date().toISOString() }))} sourcesHref={sourcesHref} />
      )}

      <div className={sectionClass}>
        <TextField
          label="Notes"
          help={{ description: "Anything worth remembering about this step. It does not change the numbers.", example: "“Only runs for clients on the Pro plan.”" }}
          value={step.notes}
          optional
          multiline
          save={field("notes")}
        />
        {placed ? (
          <>
            <button type="button" onClick={onDelete} aria-describedby="placed-delete-note" data-remove-from-map className="self-start rounded-token border border-line px-2.5 py-1 hover:bg-panel-2">
              Remove from this map
            </button>
            <p id="placed-delete-note" className="text-xs text-muted-foreground">
              {PLACED_REMOVE_NOTE}
            </p>
          </>
        ) : (
          <button type="button" onClick={onDelete} className="self-start rounded-token border border-crit px-2.5 py-1 text-crit hover:bg-crit-soft">
            Delete step
          </button>
        )}
      </div>
    </aside>
  );
}

export interface DraftInfo {
  change: StepChange | undefined;
  /** Names of steps, roles and people, live and draft, for describing values. */
  names: Map<string, string>;
  /** Put one field (or `position`) back as it is live. */
  onRevert: (field: string) => void;
  /** Put the whole step back as it is live (or remove it, if it is new). */
  onDiscard: () => void;
}

/** What the draft changed on this step, old → new, each with Revert. */
function DraftChanges({ info, change }: { info: DraftInfo; change: StepChange }) {
  const buttonClass = "rounded-token border border-line bg-panel px-1.5 py-0.5 font-semibold hover:bg-panel-2";
  if (change.kind === "added") {
    return (
      <div className="flex items-center justify-between gap-2 rounded-token border border-dashed border-accent bg-accent-soft p-2 text-xs">
        <p>New in this draft.</p>
        <button type="button" onClick={info.onDiscard} className={buttonClass}>
          Discard step
        </button>
      </div>
    );
  }
  if (change.kind !== "changed") return null;
  // Kind and outcome revert together, so they are listed together.
  const fields = change.fields.filter((f) => f.field !== "outcome" || !change.fields.some((g) => g.field === "kind"));
  return (
    <section aria-label="Changed in this draft" className="flex flex-col gap-1.5 rounded-token border border-accent bg-accent-soft p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold">Changed in this draft</p>
        <button type="button" onClick={info.onDiscard} className={buttonClass}>
          Revert all
        </button>
      </div>
      <ul className="flex flex-col gap-1">
        {fields.map((f) => (
          <li key={f.field} className="flex items-center justify-between gap-2">
            <span>
              {fieldLabel(f.field)}: <s className="text-fg-3">{describeValue(f.field, f.live, info.names)}</s>{" "}
              <span aria-label="changed to">→</span> <strong>{describeValue(f.field, f.draft, info.names)}</strong>
            </span>
            <button type="button" onClick={() => info.onRevert(f.field)} className={buttonClass} aria-label={`Revert ${fieldLabel(f.field)}`}>
              Revert
            </button>
          </li>
        ))}
        {change.moved && (
          <li className="flex items-center justify-between gap-2">
            <span>Moved on the map</span>
            <button type="button" onClick={() => info.onRevert(POSITION)} className={buttonClass} aria-label="Revert position">
              Revert
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

const nullableNumber = (v: number | null) => (v === null ? null : Number(v));

/** Equal as the inspector shows values: numbers to the precision it displays, blank text as none. */
function sameish(a: Scalar, b: Scalar): boolean {
  const blank = (v: Scalar) => v === null || v === "";
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  if (typeof a === "number" || typeof b === "number") return Math.abs(Number(a) - Number(b)) < 1e-6;
  return a === b;
}

/** Refuse fractions before they reach the saver. */
const wholeNumber =
  (save: Saver<number | null>): Saver<number | null> =>
  async (base, next) =>
    next !== null && !Number.isInteger(next) ? { status: "error", message: "Enter a whole number." } : save(base, next);

function Duration({
  phase,
  title,
  step,
  via,
  field,
}: {
  phase: Phase;
  title: string;
  step: StepRow;
  via: <T extends Scalar>(build: (b: ProcessBundle, value: T) => Edit | null, check?: { field: string; current: T }) => Saver<T>;
  field: <T extends Scalar>(name: string) => Saver<T>;
}) {
  const dist = step[`${phase}_dist`];
  const mean = Number(step[`${phase}_hours`]);
  const params = step[`${phase}_params`] ?? {};
  const range = triangularRange(params, mean);
  const point = (p: "min" | "mode" | "max") =>
    via<number | null>((b, v) => (v === null ? null : setRangePoint(b, step.id, phase, p, v)), {
      field: `${phase}_params.${p}`,
      current: range[p],
    });
  return (
    <fieldset className={sectionClass}>
      <legend className="sr-only">{title}</legend>
      <p className="text-xs font-semibold text-fg">{title}</p>
      <SelectField
        label="Time pattern"
        help={{
          description: "How the time behaves from one run to the next. Pick “Usually about this, sometimes much longer” for most steps, the “between min and max” one when you know the quickest, usual and slowest, and “Always the same” for a fixed time.",
          example: "A discovery call usually takes an hour but can run to three: pick the “between min and max” pattern with 0.5, 1 and 3 hours.",
        }}
        value={dist}
        options={DIST_OPTIONS}
        save={via<string | null>((b, v) => (v ? setDistribution(b, step.id, phase, v as Distribution) : null))}
      />
      {dist === "triangular" ? (
        <>
          <div className="grid grid-cols-3 gap-2">
            <NumberField label="Min" help={{ description: "The quickest this has ever gone.", example: "0.5 h for a very short call." }} value={range.min} unit="h" min={0} save={point("min")} />
            <NumberField label="Most likely" help={{ description: "The time it usually takes.", example: "1 h for a typical call." }} value={range.mode} unit="h" min={0} save={point("mode")} />
            <NumberField label="Max" help={{ description: "The longest it has taken, on a bad day.", example: "3 h when the client keeps asking questions." }} value={range.max} unit="h" min={0} save={point("max")} />
          </div>
          <p className="text-xs text-fg-3">
            Average {formatHours(mean)}, from the range. The simulation samples between min and max.
          </p>
        </>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Average"
            help={{
              description: phase === "work" ? "The average hands-on time: how long someone actually works on it each time." : "The average time the item waits after the work, with nobody working on it.",
              example: phase === "work" ? "1.5 h to write a proposal." : "24 h waiting for the client to reply.",
            }}
            value={mean}
            unit="h"
            min={0}
            save={field(`${phase}_hours`)}
          />
          {dist === "lognormal" && (
            <NumberField
              label="How much it varies"
              help={{ description: "How far the time moves around the average. 0 means it is always the same; 0.35 is a typical step; higher means some runs take much longer.", example: "A steady admin task is about 0.2. A client reply that is sometimes instant and sometimes a week is about 1." }}
              value={nullableNumber((params.cv as number | null | undefined) ?? null)}
              optional
              min={0}
              max={5}
              step={0.05}
              placeholder={`${DEFAULT_CV[phase]} (usual)`}
              save={field(`${phase}_params.cv`)}
            />
          )}
        </div>
      )}
    </fieldset>
  );
}
