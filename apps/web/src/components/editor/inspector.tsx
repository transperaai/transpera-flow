"use client";

// The Editor's right column (issue #104): the inspector for the selected step (today's Step tab), what a selected
// group adds (first step, ungroup, save as a block), the loose ends the editor can see, and a first-principles reminder.

import { useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { isGroup, type EvidenceStamp, type ProcessBundle, type SourceRow, type StepRow } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { LinkedSources } from "@/components/sources/linking-context";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { NO_SELECTION, type Selection } from "@/components/process-canvas";
import { StepInspector, type DraftInfo } from "@/components/step-inspector";
import { deleteSelection, stepWarnings } from "@/lib/editor/commands";
import type { ProcessEditor } from "@/lib/editor/editor";
import { membersOf, setGroupEntry, ungroup } from "@/lib/editor/groups";
import type { EditorMode } from "@/lib/editor/modes";
import type { BlockTools } from "./use-blocks";

export function Inspector({
  bundle,
  editor,
  selected,
  setSelection,
  inspectFocus,
  onFocused,
  sources,
  stamp,
  sourcesHref,
  mode,
  draft,
  blocks,
  company = false,
}: {
  bundle: ProcessBundle;
  editor: ProcessEditor;
  selected: Selection;
  setSelection: Dispatch<SetStateAction<Selection>>;
  inspectFocus: string | null;
  onFocused: () => void;
  sources: readonly SourceRow[];
  stamp: () => EvidenceStamp;
  sourcesHref?: string;
  mode: EditorMode;
  /** How the draft changes a step against live, as the inspector shows it; null when there is no draft. */
  draft: ((step: StepRow) => DraftInfo) | null;
  /** The block library as the Editor uses it: a selected group can be saved as a block. */
  blocks: BlockTools;
  /** The company map (B11): no loose ends to chase, no first principles, no blocks. */
  company?: boolean;
}) {
  const step = selected.steps.length === 1 && !selected.edges.length ? bundle.steps.find((s) => s.id === selected.steps[0]) : undefined;
  const warnings = useMemo(() => (company ? new Map<string, string>() : stepWarnings(bundle)), [bundle, company]);
  const loose = useMemo(() => bundle.steps.filter((s) => warnings.has(s.id)), [bundle.steps, warnings]);
  return (
    <>
      {step ? (
        <>
          <StepInspector
            key={step.id}
            bundle={bundle}
            step={step}
            editor={editor}
            autoFocus={inspectFocus === step.id}
            onFocused={onFocused}
            onClose={() => setSelection(NO_SELECTION)}
            onDelete={() => {
              editor.run((b) => deleteSelection(b, [step.id], []));
              setSelection(NO_SELECTION);
            }}
            sources={sources}
            stamp={stamp}
            sourcesHref={sourcesHref}
            draft={draft ? draft(step) : null}
          />
          <LinkedSources
            className="flex flex-col gap-1.5 border-t border-line pt-3"
            target={{ kind: "step", processId: step.process_id, stepId: step.id }}
            label={`Step: ${step.name}`}
            empty="None linked"
          />
          {isGroup(step) && <GroupPanel bundle={bundle} editor={editor} group={step} setSelection={setSelection} blocks={blocks} company={company} />}
          {warnings.get(step.id) && <p role="note" className="rounded-token border border-warn bg-warn-soft px-2 py-1.5 text-xs">{warnings.get(step.id)}</p>}
        </>
      ) : (
        <section aria-label="Inspector" className="flex flex-col gap-2">
          <h2 className="text-[11px] font-semibold tracking-wider text-fg-2 uppercase">Inspector</h2>
          <p className="text-xs text-muted-foreground">
            {selected.steps.length > 1
              ? `${selected.steps.length} steps selected. Group them from the left, or press Delete to remove them.`
              : "Select a step or group on the canvas to edit it."}
          </p>
        </section>
      )}

      {loose.length > 0 && (
        <section aria-label="Loose ends" className="flex flex-col gap-1.5">
          <h2 className="flex items-center text-[11px] font-semibold tracking-wider text-fg-2 uppercase">
            Loose ends ({loose.length})
            <Help
              label="Loose ends"
              description="Steps or groups the process can't leave, or whose branches don't add up to 100%. A process with one can't be simulated properly."
              example="A new group with nothing leaving it: drag from its right edge to the step that comes next."
            />
          </h2>
          <ul className="flex flex-col gap-1">
            {loose.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSelection({ steps: [s.id], edges: [] })}
                  className="w-full rounded-token border border-line bg-panel px-2 py-1 text-left text-xs hover:bg-panel-2"
                >
                  <span className="font-semibold">{s.name}</span>
                  <span className="block text-fg-2">{warnings.get(s.id)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {mode !== "block" && !company && (
        <section aria-label="First principles" className="flex flex-col gap-1.5">
          <h2 className="flex items-center text-[11px] font-semibold tracking-wider text-fg-2 uppercase">
            First principles
            <Help
              label="First principles"
              description="Before you add a step, ask whether it needs to exist. Delete what you can, then simplify, then speed it up, and only then automate it."
              example="Before automating an approval email, check whether anyone ever says no to it. If not, delete the step."
            />
          </h2>
          <p className="text-xs">Delete first. Simplify next. Speed up after that. Automate last.</p>
          <p className="text-xs text-muted-foreground">The process&apos;s own first principles will show here.</p>
        </section>
      )}
    </>
  );
}

/** What only a group has: how many steps it holds, where the process enters it, and taking its steps back out. */
function GroupPanel({
  bundle,
  editor,
  group,
  setSelection,
  blocks,
  company,
}: {
  bundle: ProcessBundle;
  editor: ProcessEditor;
  group: StepRow;
  setSelection: Dispatch<SetStateAction<Selection>>;
  blocks: BlockTools;
  company: boolean;
}): ReactNode {
  const members = membersOf(bundle, group.id);
  const [saving, setSaving] = useState(false);
  const entry = members.some((m) => m.id === group.entry_step_id) ? group.entry_step_id! : "";
  return (
    <section aria-label={`Group: ${group.name}`} className="flex flex-col gap-2 border-t border-line pt-3">
      <p className="text-xs text-fg-2">
        {members.length === 0 ? "Nothing inside yet. Select steps beside it and press Group, or add steps with + Step." : `${members.length} ${members.length === 1 ? "step" : "steps"} inside. Groups are open in the Editor so you can edit inside them; use Collapse on the map to close one.`}
      </p>
      {!company && (
      <label className="flex flex-col gap-1 text-xs font-semibold">
        <span className="flex items-center">
          First step
          <Help
            label="First step"
            description="The step inside the group where work starts when something enters it."
            example="In “Sales conversation”, the first step is “Qualify lead”."
          />
        </span>
        <NativeSelect
          value={entry}
          disabled={!members.length}
          onChange={(e) => e.target.value && editor.run((b) => setGroupEntry(b, group.id, e.target.value))}
        >
          {!entry && <option value="">Pick the first step…</option>}
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </NativeSelect>
      </label>
      )}
      {!company && !entry && members.length > 0 && <p className="text-xs text-crit">This group needs a first step before the process can be simulated.</p>}
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (editor.run((b) => ungroup(b, group.id))) setSelection({ steps: members[0] ? [members[0].id] : [], edges: [] });
          }}
        >
          Ungroup
        </Button>
        {!company && (
        <>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!members.length || saving}
          title={members.length ? undefined : "Put at least one step in the group first."}
          onClick={async () => {
            setSaving(true);
            await blocks.saveGroup(group.id);
            setSaving(false);
          }}
        >
          {saving ? "Saving…" : "Save this group as a block"}
        </Button>
        <Help
          label="Save this group as a block"
          description="Saves this group's steps and the connections between them in the block library, named after the group, so you can drop a copy into any process later. The group on the map is left as it is."
          example="Save your “Sales conversation” group, then insert it into the next client's onboarding process."
        />
        </>
        )}
      </div>
      {blocks.note?.kind === "save" && (
        <p role="status" className={`rounded-token border px-2 py-1 text-xs ${blocks.note.tone === "ok" ? "border-good bg-good-soft" : "border-warn bg-warn-soft"}`}>
          {blocks.note.text}
        </p>
      )}
    </section>
  );
}
