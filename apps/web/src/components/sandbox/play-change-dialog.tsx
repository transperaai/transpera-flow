"use client";

// Add or edit one change of the Sandbox's list (capacity build P7, brief section 1): an automation or augmentation, as the engine's effects on parts of
// steps, with its adoption, its ramp, the tiers it applies to, what it costs a month, the issue it fixes and where its numbers came from.

import { useState } from "react";
import { checkCapacityChange, CHANGE_SOURCES, MAX_CHANGE_EFFECTS, type CapacityChangeInput, type CapacityChangeRow } from "@transpera-flow/db";
import type { SourceLabel, StepChangeEffect } from "@transpera-flow/engine";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { PlayProcess } from "./play-types";

export interface IssueOption {
  id: string;
  /** The issue's number in the workspace, shown before its title. */
  number?: number | null;
  title: string;
}

/** An open issue as the picker shows it: "#3 Meeting prep is data hunting". */
export const issueLabel = (i: IssueOption): string => (i.number ? `#${i.number} ${i.title}` : i.title);

const SOURCE_WORDS: Record<SourceLabel, string> = { interview: "An interview", calculator: "The calculator", measured: "Measured", estimate: "An estimate" };

interface EffectRow {
  key: number;
  step: string;
  part: "automatable" | "augmentable";
  /** Percent removed (automatable). */
  remove: string;
  /** Minutes of checking left (automatable). */
  residualMinutes: string;
  /** Times faster (augmentable). */
  factor: string;
}

const toRow = (e: StepChangeEffect, key: number): EffectRow =>
  e.part === "automatable"
    ? { key, step: e.step, part: "automatable", remove: String(Math.round(e.remove * 1000) / 10), residualMinutes: e.residualHours ? String(Math.round(e.residualHours * 600) / 10) : "", factor: "1.5" }
    : { key, step: e.step, part: "augmentable", remove: "80", residualMinutes: "", factor: String(e.factor) };

const num = (s: string): number => (s.trim() === "" ? NaN : Number(s));

function toEffect(r: EffectRow): StepChangeEffect {
  if (r.part === "augmentable") return { step: r.step, part: "augmentable", factor: num(r.factor) };
  const minutes = num(r.residualMinutes);
  return { step: r.step, part: "automatable", remove: num(r.remove) / 100, ...(Number.isFinite(minutes) && minutes > 0 ? { residualHours: minutes / 60 } : {}) };
}

export function PlayChangeDialog({
  existing,
  processes,
  tiers,
  issues,
  onSave,
  onRemove,
  onClose,
}: {
  existing: CapacityChangeRow | null;
  processes: PlayProcess[];
  tiers: { key: string; name: string }[];
  issues: IssueOption[];
  /** Saves; returns why not, or null when it saved (the dialog closes). */
  onSave: (input: CapacityChangeInput) => Promise<string | null>;
  onRemove?: () => Promise<string | null>;
  onClose: () => void;
}) {
  const steps = processes.flatMap((p) => p.steps.map((s) => ({ id: s.id, label: processes.length > 1 ? `${p.name}: ${s.name}` : s.name })));
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<CapacityChangeInput["kind"]>(existing?.kind ?? "automation");
  const [rows, setRows] = useState<EffectRow[]>(() => (existing ? existing.effects.map(toRow) : [{ key: 1, step: steps[0]?.id ?? "", part: "automatable", remove: "80", residualMinutes: "", factor: "1.5" }]));
  const [adoption, setAdoption] = useState(String(Math.round((existing?.adoption ?? 0.8) * 100)));
  const [ramp, setRamp] = useState(String(existing?.ramp_months ?? 0));
  const [picked, setPicked] = useState<string[]>(existing?.tiers ?? []);
  const [cost, setCost] = useState(existing?.cost_monthly != null ? String(existing.cost_monthly) : "");
  const [issue, setIssue] = useState(existing?.issue_id ?? "");
  const [source, setSource] = useState<SourceLabel>(existing?.source ?? "estimate");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nextKey, setNextKey] = useState(100);

  const input = (): CapacityChangeInput => ({
    name,
    kind,
    effects: rows.map(toEffect),
    adoption: num(adoption) / 100,
    ramp_months: num(ramp),
    tiers: picked.length ? picked : null,
    cost_monthly: cost.trim() === "" ? null : num(cost),
    issue_id: issue || null,
    source,
  });

  async function save() {
    const value = input();
    const problem = checkCapacityChange(value, new Set(steps.map((s) => s.id)));
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const refused = await onSave(value);
    setBusy(false);
    if (refused) setError(refused);
  }

  const patch = (key: number, p: Partial<EffectRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const field = "flex min-w-0 flex-col gap-1 text-xs text-muted-foreground";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-change-dialog>
        <DialogHeader>
          <DialogTitle>{existing ? "Edit this change" : "Add a change"}</DialogTitle>
          <DialogDescription>An automation or augmentation acts on the parts of a step&apos;s time that can be automated or augmented, so it follows the step&apos;s own numbers.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
            <label className={field}>
              Name
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} data-change-name />
            </label>
            <label className={field}>
              Kind
              <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="automation">Automation</option>
                <option value="augmentation">Augmentation</option>
              </NativeSelect>
            </label>
          </div>

          <fieldset className="grid gap-2" data-change-effects>
            <legend className="text-xs font-medium">What it does to each step</legend>
            {rows.map((r) => (
              <div key={r.key} className="grid gap-2 rounded-token border border-line p-2 sm:grid-cols-[1fr_9rem_6rem_6rem_auto] sm:items-end" data-effect>
                <label className={field}>
                  Step
                  <NativeSelect value={r.step} onChange={(e) => patch(r.key, { step: e.target.value })} aria-label="Step">
                    {steps.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className={field}>
                  Part
                  <NativeSelect value={r.part} onChange={(e) => patch(r.key, { part: e.target.value as EffectRow["part"] })} aria-label="Part">
                    <option value="automatable">Automatable part</option>
                    <option value="augmentable">Augmentable part</option>
                  </NativeSelect>
                </label>
                {r.part === "automatable" ? (
                  <>
                    <label className={field}>
                      Removes %
                      <Input inputMode="decimal" value={r.remove} onChange={(e) => patch(r.key, { remove: e.target.value })} aria-label="Share removed, percent" />
                    </label>
                    <label className={field}>
                      Checking min
                      <Input inputMode="decimal" value={r.residualMinutes} placeholder="0" onChange={(e) => patch(r.key, { residualMinutes: e.target.value })} aria-label="Minutes of checking left" />
                    </label>
                  </>
                ) : (
                  <label className={`${field} sm:col-span-2`}>
                    Times faster
                    <Input inputMode="decimal" value={r.factor} onChange={(e) => patch(r.key, { factor: e.target.value })} aria-label="Times faster" />
                  </label>
                )}
                <Button type="button" variant="ghost" size="sm" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} disabled={rows.length < 2} aria-label="Remove this effect">
                  ✕
                </Button>
              </div>
            ))}
            {rows.length < MAX_CHANGE_EFFECTS && (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRows((rs) => [...rs, { key: nextKey, step: steps[0]?.id ?? "", part: "automatable", remove: "80", residualMinutes: "", factor: "1.5" }]);
                    setNextKey(nextKey + 1);
                  }}
                >
                  + Add an effect
                </Button>
              </div>
            )}
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className={field}>
              Adoption %
              <Input inputMode="decimal" value={adoption} onChange={(e) => setAdoption(e.target.value)} aria-label="Adoption, percent" />
            </label>
            <label className={field}>
              Months to full effect
              <Input inputMode="numeric" value={ramp} onChange={(e) => setRamp(e.target.value)} aria-label="Months to full effect" />
            </label>
            <label className={field}>
              Costs a month
              <Input inputMode="decimal" value={cost} placeholder="Nothing" onChange={(e) => setCost(e.target.value)} aria-label="Cost a month" />
            </label>
          </div>

          <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <legend className="mb-1 text-xs font-medium">Tiers it applies to</legend>
            {tiers.map((t) => (
              <label key={t.key} className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={picked.includes(t.key)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, t.key] : p.filter((k) => k !== t.key)))} />
                {t.name}
              </label>
            ))}
            <span className="text-xs text-muted-foreground">{picked.length ? "" : "None ticked: every tier."}</span>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className={field}>
              The issue it fixes
              <NativeSelect value={issue} onChange={(e) => setIssue(e.target.value)} aria-label="Issue it fixes">
                <option value="">None</option>
                {issues.map((i) => (
                  <option key={i.id} value={i.id}>
                    {issueLabel(i)}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className={field}>
              Where the numbers came from
              <NativeSelect value={source} onChange={(e) => setSource(e.target.value as SourceLabel)}>
                {CHANGE_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_WORDS[s]}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </div>
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
