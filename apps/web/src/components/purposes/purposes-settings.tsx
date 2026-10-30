"use client";

// Settings -> Purposes (sandbox G, phase 4): the categories a step's "What it achieves" is chosen from. Renaming, describing and moving
// change the Sandbox's labels and order everywhere without a re-run (the engine only knows the keys). Five categories are fixed (renamed and
// moved, never deleted): the Automatic rules, rework and client hours need them. Saved whole, checked against the list as it was loaded.

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  DEFAULT_PURPOSES,
  FIXED_PURPOSES,
  MAX_PURPOSES,
  MAX_PURPOSE_DESCRIPTION,
  MAX_PURPOSE_NAME,
  newPurposeKey,
  parsePurposes,
  type PurposeCategory,
} from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Page } from "@/components/shell/page";
import { PhoneReadOnly } from "@/components/shell/phone-read-only";
import { ConfirmDialog } from "@/components/sandbox/scenario-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { purposeColor } from "@/components/sandbox/time-chart";
import type { PurposesOutcome } from "@/app/w/[slug]/settings/actions";
import { EDIT_ONLY } from "@/lib/phone";

export type PurposesMode = "live" | "readonly";

type Confirm = { title: string; description: string; confirm: string; onConfirm: () => void } | null;
type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string } | { kind: "conflict"; theirs: PurposeCategory[] | null };

const isFixed = (key: string) => (FIXED_PURPOSES as readonly string[]).includes(key);
const same = (a: readonly PurposeCategory[], b: readonly PurposeCategory[]) => JSON.stringify(a) === JSON.stringify(b);

export function PurposesSettings({
  mode,
  workspaceId,
  stored,
  initial,
  use,
  save,
  children,
}: {
  mode: PurposesMode;
  workspaceId: string;
  /** What is stored (null: the workspace has none and uses the defaults): the base of a save. */
  stored: PurposeCategory[] | null;
  /** The list to show: the stored one, or the defaults. */
  initial: PurposeCategory[];
  /** Steps (live and draft versions) that chose each category, by key. */
  use: Record<string, number>;
  save: (workspaceId: string, base: PurposeCategory[] | null, value: unknown) => Promise<PurposesOutcome>;
  children?: ReactNode;
}) {
  const canEdit = mode === "live";
  const [list, setList] = useState<PurposeCategory[]>(initial);
  const [base, setBase] = useState<PurposeCategory[] | null>(stored);
  const [saved, setSaved] = useState<PurposeCategory[]>(initial);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [confirm, setConfirm] = useState<Confirm>(null);
  const dirty = !same(list, saved);
  const problem = useMemo(() => {
    const p = parsePurposes(list);
    return p.ok ? null : p.error;
  }, [list]);

  const edit = (i: number, patch: Partial<PurposeCategory>) => {
    setStatus({ kind: "idle" });
    setList((l) => l.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  };
  const move = (i: number, by: -1 | 1) => {
    setStatus({ kind: "idle" });
    setList((l) => {
      const j = i + by;
      if (j < 0 || j >= l.length) return l;
      const next = [...l];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  };
  const add = () => {
    setStatus({ kind: "idle" });
    setList((l) => {
      const key = newPurposeKey(l.map((c) => c.key));
      let name = "New category";
      for (let n = 2; l.some((c) => c.name.trim().toLowerCase() === name.toLowerCase()); n++) name = `New category ${n}`;
      return [...l, { key, name, description: "" }];
    });
  };
  const remove = (i: number) => {
    const c = list[i]!;
    const n = use[c.key] ?? 0;
    setConfirm({
      title: `Delete “${c.name}”?`,
      description:
        n > 0
          ? `${n} ${n === 1 ? "step has" : "steps have"} chosen it. They are not changed: they fall back to Automatic (the first principles, then the process) until you pick another.`
          : "No step has chosen it.",
      confirm: "Delete",
      onConfirm: () => {
        setStatus({ kind: "idle" });
        setList((l) => l.filter((x) => x.key !== c.key));
        setConfirm(null);
      },
    });
  };
  const reset = () => {
    // Added categories that steps have chosen would be lost: say so.
    const lost = list.filter((c) => !DEFAULT_PURPOSES.some((d) => d.key === c.key));
    const n = lost.reduce((a, c) => a + (use[c.key] ?? 0), 0);
    setConfirm({
      title: "Reset to the defaults?",
      description: `The seven default categories, in their order, with their names. ${lost.length ? `${lost.length === 1 ? "A category you added is" : `${lost.length} categories you added are`} removed${n ? `, and the ${n} ${n === 1 ? "step" : "steps"} that chose ${lost.length === 1 ? "it" : "them"} fall back to Automatic` : ""}. ` : ""}Nothing is saved until you press Save.`,
      confirm: "Reset",
      onConfirm: () => {
        setStatus({ kind: "idle" });
        setList(DEFAULT_PURPOSES.map((c) => ({ ...c })));
        setConfirm(null);
      },
    });
  };

  const submit = async (against: PurposeCategory[] | null) => {
    setStatus({ kind: "saving" });
    try {
      const out = await save(workspaceId, against, list);
      if (out.status === "saved") {
        setBase(out.purposes);
        setSaved(out.purposes);
        setList(out.purposes);
        setStatus({ kind: "saved" });
      } else if (out.status === "conflict") setStatus({ kind: "conflict", theirs: out.theirs });
      else if (out.status === "not_found") setStatus({ kind: "error", message: "This workspace isn't there, or you can't change it." });
      else setStatus({ kind: "error", message: out.message });
    } catch {
      setStatus({ kind: "error", message: "Couldn't save. Check your connection and try again." });
    }
  };

  return (
    <Page
      title="Purposes"
      eyebrow="Settings"
      description="What the work of each step achieves. A step's purpose is set in the editor; Automatic uses the first principles (a step listed to delete is “Could be removed”) and then the process: sales pipelines are Winning work up to and including the step that decides the sale, and everything after it, and client work, move the client's job forward."
      actions={
        <>
          <span role="status" aria-live="polite" className="text-xs text-muted-foreground" data-save-status>
            {status.kind === "saving" ? "Saving…" : status.kind === "saved" ? "Saved" : dirty && canEdit ? "Not saved yet" : ""}
          </span>
          <Button variant="outline" size="sm" className={EDIT_ONLY} data-edit-entry disabled={!canEdit || same(list, DEFAULT_PURPOSES as PurposeCategory[])} onClick={reset}>
            Reset to the defaults
          </Button>
          <Button size="sm" className={EDIT_ONLY} data-edit-entry disabled={!canEdit || !dirty || problem !== null || status.kind === "saving"} onClick={() => void submit(base)}>
            Save
          </Button>
        </>
      }
    >
      <PhoneReadOnly>
        {mode === "readonly" && (
          <p role="note" className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            Only Agency admins and the Owner can change the categories. You can see them here.
          </p>
        )}
        {status.kind === "error" && (
          <p role="alert" className="rounded-lg border border-crit bg-crit-soft px-3 py-2 text-sm">
            {status.message}
          </p>
        )}
        {status.kind === "conflict" && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-warn bg-warn-soft px-3 py-2 text-sm" data-purposes-conflict>
            <span>Someone else changed the categories while you were editing. Theirs now:</span>
            <ol className="list-decimal pl-5">
              {(status.theirs ?? DEFAULT_PURPOSES).map((c) => (
                <li key={c.key}>{c.name}</li>
              ))}
            </ol>
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const theirs = status.theirs ?? DEFAULT_PURPOSES.map((c) => ({ ...c }));
                  setBase(status.theirs);
                  setSaved(theirs);
                  setList(theirs);
                  setStatus({ kind: "idle" });
                }}
              >
                Keep theirs
              </Button>
              <Button size="sm" onClick={() => void submit(status.theirs)}>
                Overwrite with mine
              </Button>
            </span>
          </div>
        )}
        {canEdit && problem && dirty && (
          <p role="note" className="text-sm text-crit" data-purposes-problem>
            {problem}
          </p>
        )}
        <ol className="flex flex-col gap-2" data-purposes-list>
          {list.map((c, i) => {
            const n = use[c.key] ?? 0;
            return (
              <li key={c.key}>
                <Card className="gap-2 px-4 py-3" data-purpose={c.key}>
                  <div className="flex items-start gap-3">
                    <i aria-hidden className="mt-2.5 size-3 shrink-0 rounded-sm border border-line" style={{ background: purposeColor(c.key) }} />
                    <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(10rem,1fr)_2fr]">
                      <label className="flex flex-col gap-1 text-xs font-medium text-fg-2">
                        Name
                        <Input
                          value={c.name}
                          maxLength={MAX_PURPOSE_NAME + 20}
                          disabled={!canEdit}
                          aria-label={`Name of category ${i + 1}`}
                          onChange={(e) => edit(i, { name: e.target.value })}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-medium text-fg-2">
                        Description
                        <Input
                          value={c.description}
                          maxLength={MAX_PURPOSE_DESCRIPTION + 20}
                          disabled={!canEdit}
                          aria-label={`Description of ${c.name || `category ${i + 1}`}`}
                          onChange={(e) => edit(i, { description: e.target.value })}
                        />
                      </label>
                    </div>
                    <div className={`flex shrink-0 items-center gap-1 pt-5 ${EDIT_ONLY}`}>
                      <Button variant="ghost" size="icon-sm" disabled={!canEdit || i === 0} aria-label={`Move ${c.name} up`} onClick={() => move(i, -1)}>
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon-sm" disabled={!canEdit || i === list.length - 1} aria-label={`Move ${c.name} down`} onClick={() => move(i, 1)}>
                        <ArrowDown aria-hidden />
                      </Button>
                      {!isFixed(c.key) && (
                        <Button variant="ghost" size="icon-sm" disabled={!canEdit} aria-label={`Delete ${c.name}`} onClick={() => remove(i)}>
                          <Trash2 aria-hidden />
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="pl-6 text-xs text-muted-foreground">
                    {isFixed(c.key) ? "Can be renamed and moved, not deleted. " : ""}
                    {n > 0 ? `Chosen by ${n} ${n === 1 ? "step" : "steps"}.` : "No step has chosen it."}
                  </p>
                </Card>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className={EDIT_ONLY} data-edit-entry disabled={!canEdit || list.length >= MAX_PURPOSES} onClick={add}>
            <Plus aria-hidden />
            Add a category
          </Button>
          <span className="flex items-center text-xs text-muted-foreground">
            {list.length} of {MAX_PURPOSES}
            <Help
              label="Categories"
              description="The order here is the order in the Sandbox's charts and tables, with Idle last. Renaming changes the label everywhere; the steps that chose a category keep it. “Client upkeep” is for the hours each role gives every client a week, which are not steps, so a step can't choose it."
              example="Rename “Winning work” to “Sales” and the Sandbox says Sales at once."
            />
          </span>
        </div>
        {children}
      </PhoneReadOnly>
      {confirm ? <ConfirmDialog title={confirm.title} description={confirm.description} confirm={confirm.confirm} cancel="Cancel" destructive onConfirm={confirm.onConfirm} onCancel={() => setConfirm(null)} /> : null}
    </Page>
  );
}
