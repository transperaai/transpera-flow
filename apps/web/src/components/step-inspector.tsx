"use client";

// The step inspector (PRD §4.1): every field of the selected step, each saved
// on its own through the process editor, so each change is undoable and
// re-runs the simulation.

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  EVIDENCE_COLUMNS,
  isOpenAssumption,
  resolveBundlePurposes,
  triangularRange,
  UPKEEP_PURPOSE,
  workspacePurposes,
  type EvidenceStamp,
  type ProcessBundle,
  type PurposeCategory,
  type StepKind,
  type StepRow,
} from "@transpera-flow/db";
import { Button } from "@/components/ui/button";
import { DecisionPanel } from "@/components/editor/decision-panel";
import { NewPurpose, type PurposeAdder } from "@/components/editor/new-purpose";
import { TYPE_CHOICES, TYPE_LABELS } from "@/lib/editor/node-types";
import { StepBaseValues } from "@/components/step-base-values";
import type { TierSetup } from "@/lib/tier-setup";
import { NumberField, SelectField, TextField, ToggleField, type SelectOption } from "@/components/fields";
import {
  OUTCOME_LABELS,
  kindProblem,
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
import { type Edit, type Scalar } from "@/lib/editor/ops";
import type { SaveOutcome, Saver } from "@/lib/fields/field-controller";
import { formatHours } from "@/lib/format";
import { selectableRoles } from "@/lib/roles";

/** The workspace's purposes as the Editor sees them now (it can add one), and how to add one (absent: this person can't). */
export interface PurposeTools {
  list: PurposeCategory[];
  /** The bundle's workspace settings with `list` in them, so a purpose added a moment ago is known to the step. */
  settings: ProcessBundle["workspace"]["settings"];
  adder: PurposeAdder | null;
}

/** "What it achieves" (sandbox phase 4): the workspace's categories, or Automatic with the name it resolves to and why. "+ New purpose…" adds one (editor brainstorm, item 1). */
function PurposeField({ bundle, step, save, purposes }: { bundle: ProcessBundle; step: StepRow; save: Saver<string | null>; purposes: PurposeTools }) {
  const categories = purposes.list;
  const resolved = useMemo(() => resolveBundlePurposes({ ...bundle, workspace: { ...bundle.workspace, settings: purposes.settings } }).get(step.id), [bundle, purposes.settings, step.id]);
  const nameOf = new Map(categories.map((c) => [c.key, c.name]));
  const automatic = resolved ? (nameOf.get(resolved.key) ?? resolved.key) : "";
  const hint =
    step.purpose !== null && step.purpose !== undefined
      ? resolved?.source === "deleted_category"
        ? "Its category was deleted: Automatic is used. Pick another."
        : null
      : resolved?.source === "process_kind"
        ? bundle.process.kind === "servicing"
          ? "Client work process"
          : resolved.key === "client_job"
            ? "After the sale in a sales pipeline"
            : "Sales pipeline process, up to and including the sale decision"
        : null;
  return (
    <div className="flex flex-col gap-1.5">
      <SelectField
        label="What it achieves"
        help={{
          description:
            "What this step's hands-on time achieves. The Sandbox adds up working time by these, so you can see how much goes on the client's job, on winning work, on fixing, and on steps that could go. Rework on any step always counts as Fixing.",
          example: "“Send weekly status email” is Coordination; “Write the monthly report” moves the client's job forward.",
        }}
        value={step.purpose ?? null}
        options={categories.filter((c) => c.key !== UPKEEP_PURPOSE).map((c) => ({ value: c.key, label: c.name }))}
        noneLabel={`Automatic: ${automatic}`}
        save={save}
        hint={hint}
      />
      {purposes.adder && <NewPurpose adder={purposes.adder} onAdded={(key) => void save(step.purpose ?? null, key)} />}
    </div>
  );
}

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
  stamp,
  tierSetup,
  settingsHref,
  readOnly = false,
  purposes,
  branchFocus = null,
  onFocusBranch,
  holderCard,
}: {
  bundle: ProcessBundle;
  step: StepRow;
  editor: ProcessEditor;
  /** The workspace's tiers and what each tier's service gets, for the base values (capacity P4). */
  tierSetup?: TierSetup;
  settingsHref?: string;
  /** Show the base values as they are without letting anyone change them. */
  readOnly?: boolean;
  /** Put focus in the first field (asked for from the step's menu). */
  autoFocus?: boolean;
  onFocused?: () => void;
  onClose: () => void;
  onDelete: () => void;
  /** In a draft (issue #9): how the draft changed this step against live, and undoing that. */
  draft?: DraftInfo | null;
  /** Who and when, for confirming. */
  stamp?: () => EvidenceStamp;
  /** The workspace's purposes and how to add one. Without it "What it achieves" uses the bundle's. */
  purposes?: PurposeTools;
  /** A decision: the branch whose fields are in focus, and how to move the focus. */
  branchFocus?: string | null;
  onFocusBranch?: (edgeId: string | null) => void;
  /** A step that holds a linked process: the card that says so and offers "Turn into steps" (the Editor's own). */
  holderCard?: ReactNode;
}) {
  const id = step.id;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    onFocused?.();
  }, [autoFocus, onFocused]);
  /** A saver that runs an edit; the editor saves it and reports conflicts itself (the database refuses a stale base, ADR 0001). */
  const via =
    <T extends Scalar>(build: (b: ProcessBundle, value: T) => Edit | null): Saver<T> =>
    async (_base, next) => {
      editor.run((b) => build(b, next));
      return { status: "saved", value: next } as SaveOutcome<T>;
    };
  const field = <T extends Scalar>(name: string) => via<T>((b, v) => updateStep(b, id, { [name]: v }));
  // A group (or a step holding a child process) has no numbers of its own: the steps inside it do the work.
  const holder = step.kind === "group" || step.child_process_id !== null;
  // A decision is its question and its branches, a wait is how long it takes, and the Start is fixed: only a step has the rest.
  const decision = step.kind === "decision" && !holder;
  const wait = step.kind === "wait" && !holder;
  const working = step.kind !== "start" && step.kind !== "end" && !holder && !decision;
  const stepOnly = working && !wait;
  const ownPurposes = useMemo<PurposeTools>(() => {
    const settings = bundle.workspace.settings;
    return { list: workspacePurposes(settings), settings, adder: null };
  }, [bundle.workspace.settings]);
  // A process placed here by a link (B11, B12): named after it. It is taken out with Remove from this map, which leaves the process itself alone.
  const placed = step.child_process_id !== null && step.child_process_id !== undefined;
  const company = bundle.process.is_company === true;

  const kindOptions: SelectOption[] = [...TYPE_CHOICES, ...(step.kind === "subprocess" || step.kind === "group" ? [step.kind] : [])]
    .filter((k) => k === step.kind || !kindProblem(bundle, id, k))
    .map((k) => ({
      value: k,
      label: TYPE_LABELS[k],
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
        <h2 className="text-base font-bold">{TYPE_LABELS[step.kind]}</h2>
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
          <Button type="button" size="xs" onClick={() => editor.run((b) => updateStep(b, id, { assumption: false }))} className="self-start">
            Confirm values
          </Button>
        </div>
      )}
      {decision ? (
        <TextField
          label="Question"
          value={step.name}
          save={field<string | null>("name")}
          help={{ description: "The question this decision asks. Its branches, below, are the possible answers.", example: "“Does the client sign?”" }}
        />
      ) : (
        <TextField
          label="Name"
          value={step.name}
          disabled={placed}
          hint={placed ? "Named after its process. Rename the process on its own page." : undefined}
          save={field<string | null>("name")}
          help={{ description: "What this step is called on the map and in the analysis.", example: "“Discovery call” or “Send proposal”." }}
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        {step.kind === "start" ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg-2">Type</span>
            <p data-fixed-type className="flex h-8 items-center text-sm">
              Start
            </p>
            <p className="text-xs text-muted-foreground">Every process has one start, and it stays.</p>
          </div>
        ) : (
          <SelectField
            label="Type"
            help={{
              description: "What sort of node it is: a step someone does, a wait where time passes and nobody works, a decision where the work splits, or an end. To loop back to an earlier step, use a decision's “Goes to” menu.",
              example: "A “Client decision” is a Decision with two branches: signs, or walks away.",
            }}
            value={step.kind}
            options={kindOptions}
            disabled={placed}
            save={via<string | null>((b, v) => (v ? setStepKind(b, id, v as StepKind) : null))}
          />
        )}
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

      {holder && holderCard && !(placed && company) && step.kind !== "group" ? (
        holderCard
      ) : holder ? (
        <p className="rounded-token border border-line bg-panel-2 px-2 py-1.5 text-xs text-fg-2">
          {step.kind === "group"
            ? "A group is a box of steps. It has no hours, role or rework of its own: the steps inside it do the work, and the numbers are the same whether it is open or closed on the map."
            : placed && company
              ? "This card is a process placed on the company map. The process itself is never edited here. Having it on the map is what the Sandbox simulates, and joining a pipeline to another with a handoff line sends each won client on into it. Open its page to change the process."
              : "This step is a link to another process, with its own page and versions. The numbers are those of its steps, and changes to it show here. The process itself is never edited here."}
        </p>
      ) : null}

      {decision && onFocusBranch && <DecisionPanel bundle={bundle} editor={editor} decision={step} focus={branchFocus} onFocusBranch={onFocusBranch} />}

      {wait && (
        <div className={sectionClass}>
          <Duration phase="wait" title="How long" step={step} via={via} field={field} />
        </div>
      )}

      {stepOnly && (
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
          <StepBaseValues
            bundle={bundle}
            step={step}
            editor={editor}
            stamp={stamp ?? (() => ({ at: new Date().toISOString() }))}
            tierSetup={tierSetup}
            readOnly={readOnly}
            settingsHref={settingsHref}
          />
          <div className={sectionClass}>
            <NumberField
              label="Done again"
              help={{
                description: "Use this for a step that is sometimes redone. When work goes back to an earlier step, add a decision with a “Go back to…” branch instead.",
                example: "8 out of every 100 proposals have to be written again, so enter 8.",
              }}
              value={Number(step.rework_rate)}
              scale={100}
              unit="% of the time"
              min={0}
              max={100}
              step={1}
              save={field("rework_rate")}
            />
            <TextField
              label="Tool"
              help={{ description: "The software or channel used for this step, for your own reference.", example: "Xero, Google Docs or Zoom." }}
              value={step.tool}
              optional
              save={field("tool")}
            />
            <PurposeField bundle={bundle} step={step} save={field("purpose")} purposes={purposes ?? ownPurposes} />
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
            <Button type="button" variant="outline" size="sm" onClick={onDelete} aria-describedby="placed-delete-note" data-remove-from-map className="self-start">
              Remove from this map
            </Button>
            <p id="placed-delete-note" className="text-xs text-muted-foreground">
              {PLACED_REMOVE_NOTE}
            </p>
          </>
        ) : step.kind === "start" ? (
          <p className="text-xs text-muted-foreground">The start can&apos;t be deleted.</p>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={onDelete} className="self-start border-crit text-crit hover:bg-crit-soft hover:text-crit">
            {decision ? "Delete decision" : wait ? "Delete wait" : "Delete step"}
          </Button>
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
  if (change.kind === "added") {
    return (
      <div className="flex items-center justify-between gap-2 rounded-token border border-dashed border-accent bg-accent-soft p-2 text-xs">
        <p>New in this draft.</p>
        <Button type="button" variant="outline" size="xs" onClick={info.onDiscard}>
          Discard step
        </Button>
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
        <Button type="button" variant="outline" size="xs" onClick={info.onDiscard}>
          Revert all
        </Button>
      </div>
      <ul className="flex flex-col gap-1">
        {fields.map((f) => (
          <li key={f.field} className="flex items-center justify-between gap-2">
            <span>
              {fieldLabel(f.field)}: <s className="text-fg-3">{describeValue(f.field, f.live, info.names)}</s>{" "}
              <span aria-label="changed to">→</span> <strong>{describeValue(f.field, f.draft, info.names)}</strong>
            </span>
            <Button type="button" variant="outline" size="xs" onClick={() => info.onRevert(f.field)} aria-label={`Revert ${fieldLabel(f.field)}`}>
              Revert
            </Button>
          </li>
        ))}
        {change.moved && (
          <li className="flex items-center justify-between gap-2">
            <span>Moved on the map</span>
            <Button type="button" variant="outline" size="xs" onClick={() => info.onRevert(POSITION)} aria-label="Revert position">
              Revert
            </Button>
          </li>
        )}
      </ul>
    </section>
  );
}

const nullableNumber = (v: number | null) => (v === null ? null : Number(v));

/**
 * A time, entered one way (brainstorm round 2, item 10): "[ ] h usually", and a tick box "It varies" that opens Quickest / Usually / Longest.
 * Unticked runs as "about this, sometimes longer" with the engine's usual spread (lognormal); ticked runs as the range (triangular). A step stored
 * as "always the same" or with its own spread keeps running as it is until someone changes it here.
 */
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
  via: <T extends Scalar>(build: (b: ProcessBundle, value: T) => Edit | null) => Saver<T>;
  field: <T extends Scalar>(name: string) => Saver<T>;
}) {
  const dist = step[`${phase}_dist`];
  const mean = Number(step[`${phase}_hours`]);
  const params = step[`${phase}_params`] ?? {};
  const range = triangularRange(params, mean);
  const varies = dist === "triangular";
  const point = (p: "min" | "mode" | "max") =>
    via<number | null>((b, v) => (v === null ? null : setRangePoint(b, step.id, phase, p, v)));
  // Ticking turns the time into a range around it; unticking keeps the usual time and goes back to "about this, sometimes longer".
  const vary = via<boolean>((b, on) => (on ? setDistribution(b, step.id, phase, "triangular") : updateStep(b, step.id, { [`${phase}_dist`]: "lognormal", [`${phase}_hours`]: Math.round(range.mode * 1000) / 1000 })));
  const usual =
    phase === "work"
      ? { description: "How long someone usually works on it, each time it is done.", example: "1.5 h to write a proposal." }
      : { description: "How long the item usually sits after the work, with nobody working on it: waiting for a client, a sign-off or a supplier.", example: "24 h for the client to reply." };
  return (
    <fieldset className={sectionClass} data-duration={phase}>
      <legend className="sr-only">{title}</legend>
      <p className="text-xs font-semibold text-fg">{title}</p>
      {varies ? (
        <div className="grid grid-cols-3 gap-2">
          <NumberField label="Quickest" help={{ description: "The quickest it goes, on a good day.", example: "0.5 h for a very short call." }} value={range.min} unit="h" min={0} save={point("min")} />
          <NumberField label="Usually" help={{ description: usual.description, example: usual.example }} value={range.mode} unit="h" min={0} save={point("mode")} />
          <NumberField label="Longest" help={{ description: "The longest it takes, on a bad day.", example: "3 h when the client keeps asking questions." }} value={range.max} unit="h" min={0} save={point("max")} />
        </div>
      ) : (
        <NumberField label="Usually" help={{ description: usual.description, example: usual.example }} value={mean} unit="h" min={0} save={field(`${phase}_hours`)} />
      )}
      <ToggleField
        label="It varies"
        help={{
          description: "Tick it when the time changes a lot from one time to the next, and say the quickest, the usual and the longest. Left unticked, the simulation takes the usual time and lets it run a little longer now and then, as most work does.",
          example: "A discovery call is usually 1 h, but 0.5 h at best and 3 h at worst: tick It varies and enter 0.5, 1 and 3.",
        }}
        value={varies}
        onLabel="Quickest, usually and longest"
        offLabel="About the usual time"
        save={vary}
      />
      {varies && (
        <p className="text-xs text-fg-3">
          Average {formatHours(mean)}. The simulation picks a time between the quickest and the longest, most often near the usual.
        </p>
      )}
      {dist === "constant" && <p className="text-xs text-fg-3">This time is set to always be exactly the same. Tick It varies to give it a range.</p>}
    </fieldset>
  );
}
