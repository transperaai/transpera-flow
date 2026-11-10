"use client";

// A decision's side panel (editor brainstorm, item 5): each branch's name, share, where it goes and its optional "Only when…", and
// "+ Add branch". Changing one share re-balances the others in proportion (round 2, item 12), so the shares always add up to 100%.
// The same edits are on the decision's card on the map (a branch's % and its "+" dot). Every change is one undo.

import { useEffect, useRef, useState } from "react";
import type { EdgeRow, ProcessBundle, StepRow } from "@transpera-flow/db";
import { PanelHeading } from "@/components/editor/panel-heading";
import { Help } from "@/components/help";
import { NumberField, TextField } from "@/components/fields";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type { ProcessEditor } from "@/lib/editor/editor";
import { addBranch, branchesOf, removeBranch, setBranchCondition, setBranchName, setBranchShare, setBranchTarget, type BranchResult } from "@/lib/editor/branches";
import { branchName, currentTarget, decodeTarget, goesToMenu } from "@/lib/editor/branch-view";
import type { Edit } from "@/lib/editor/ops";
import type { Saver } from "@/lib/fields/field-controller";

const SAVED = <T,>(value: T) => ({ status: "saved", value }) as const;

export function DecisionPanel({
  bundle,
  editor,
  decision,
  focus,
  onFocusBranch,
}: {
  bundle: ProcessBundle;
  editor: ProcessEditor;
  decision: StepRow;
  /** The branch whose row is in focus (its line or its row on the card was clicked); null for none. */
  focus: string | null;
  /** Put another branch in focus (a branch just added). */
  onFocusBranch: (edgeId: string | null) => void;
}) {
  const branches = branchesOf(bundle, decision.id);
  // What the last edit that couldn't be done said.
  const [note, setNote] = useState<string | null>(null);
  const run = (build: (b: ProcessBundle) => Edit | BranchResult | null): string | null => {
    let said: string | null = null;
    let id: string | null = null;
    editor.run((b) => {
      const r = build(b);
      if (r && "problem" in r) {
        said = r.problem;
        return null;
      }
      if (r && "ops" in r) return r;
      if (r) id = r.id;
      return r ? r.edit : null;
    });
    setNote(said);
    return id;
  };

  return (
    <section aria-label={`Branches of ${decision.name}`} data-decision-panel className="flex flex-col gap-2 border-t border-line pt-3">
      <PanelHeading as="h3">
        Branches
        <Help
          label="Branches"
          description="Each branch is a way the work can go after this question, with the share of items that take it. The shares always add up to 100%: change one and the others make room in proportion to what they had."
          example="“Signs” 60% goes on to Kickoff; “Walks away” 40% ends as Lost."
        />
      </PanelHeading>
      <ul className="flex flex-col gap-2">
        {branches.map((edge, i) => (
          <li key={edge.id}>
            <BranchFields
              bundle={bundle}
              edge={edge}
              index={i}
              count={branches.length}
              focused={focus === edge.id}
              onName={(v) => run((b) => setBranchName(b, edge.id, v))}
              onShare={(v) => run((b) => setBranchShare(b, decision.id, edge.id, v))}
              onCondition={(v) => run((b) => setBranchCondition(b, edge.id, v))}
              onTarget={(value) => {
                const target = decodeTarget(value);
                if (target) run((b) => setBranchTarget(b, edge.id, target));
              }}
              onRemove={() => run((b) => removeBranch(b, edge.id))}
            />
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-add-branch
        className="self-start border-dashed hover:border-edit"
        onClick={() => {
          // A new branch ends the process as Done until it is sent somewhere: "Goes to" changes that.
          const id = run((b) => addBranch(b, decision.id, { end: "done" }));
          if (id) onFocusBranch(id);
        }}
      >
        + Add branch
      </Button>
      <p className="text-xs text-muted-foreground">Change one share and the others make room in proportion, so the shares always add up to 100%.</p>
      {note && (
        <p role="alert" className="rounded-token border border-warn bg-warn-soft px-2 py-1 text-xs">
          {note}
        </p>
      )}
    </section>
  );
}

function BranchFields({
  bundle,
  edge,
  index,
  count,
  focused,
  onName,
  onShare,
  onCondition,
  onTarget,
  onRemove,
}: {
  bundle: ProcessBundle;
  edge: EdgeRow;
  index: number;
  count: number;
  focused: boolean;
  onName: (v: string) => void;
  onShare: (v: number) => void;
  onCondition: (v: string) => void;
  onTarget: (value: string) => void;
  onRemove: () => void;
}) {
  const ref = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView?.({ block: "nearest" });
    ref.current?.querySelector<HTMLElement>("input")?.focus({ preventScroll: true });
  }, [focused]);
  const saver =
    <T extends string | number | null>(apply: (v: T) => void): Saver<T> =>
    async (_base, next) => {
      apply(next);
      return SAVED(next);
    };
  const menu = goesToMenu(bundle, edge);
  const name = branchName(bundle, edge);
  return (
    <fieldset
      ref={ref}
      data-branch={edge.id}
      data-focused={focused || undefined}
      className={`flex flex-col gap-2 rounded-token border bg-bg p-2 ${focused ? "border-edit outline-2 outline-offset-1 outline-edit" : "border-line"}`}
    >
      <legend className="px-1 text-xs font-semibold text-fg-2">Branch {index + 1}</legend>
      <div className="grid grid-cols-[1fr_5.5rem] gap-2">
        <TextField
          label="Name"
          value={edge.label ?? ""}
          optional
          save={saver<string | null>((v) => onName(v ?? ""))}
          hint={edge.label?.trim() ? undefined : `Shown as “${name}” until you name it.`}
          help={{ description: "What this answer is called, shown on the decision and on its line.", example: "“Signs”, “Walks away” or “Needs changes”." }}
        />
        <NumberField
          label="Share"
          value={Math.round(Number(edge.probability) * 100)}
          unit="%"
          min={0}
          max={100}
          step={1}
          disabled={count < 2}
          hint={count < 2 ? "Always 100%" : undefined}
          save={saver<number | null>((v) => v !== null && onShare(v))}
          help={{ description: "The share of items that take this branch. The shares add up to 100%: the other branches grow or shrink in proportion to make room.", example: "60% sign and go on to Kickoff; the other 40% walk away." }}
        />
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium text-fg-2">
        <span className="flex items-center">
          Goes to
          <Help
            label="Goes to"
            description="Where this branch leads. Next step joins it to a step, Go back to sends it to an earlier step so the work is repeated, and End finishes the process as won, lost or done. You can also drag the line on the map."
            example="“Walks away” goes to End (lost); “Needs changes” goes back to “Write proposal”."
          />
        </span>
        <NativeSelect value={currentTarget(bundle, edge)} onChange={(e) => onTarget(e.target.value)} aria-label={`Branch ${index + 1} goes to`}>
          {menu.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </NativeSelect>
      </label>
      <TextField
        label="Only when…"
        value={edge.condition_tag ?? ""}
        optional
        save={saver<string | null>((v) => onCondition(v ?? ""))}
        help={{ description: "An optional note on when this branch applies. It is a label for people reading the map; it does not change the numbers.", example: "“Client is on the Pro plan”." }}
      />
      {count > 1 && (
        <Button type="button" variant="outline" size="xs" data-remove-branch onClick={onRemove} className="self-start">
          Remove this branch
        </Button>
      )}
    </fieldset>
  );
}
