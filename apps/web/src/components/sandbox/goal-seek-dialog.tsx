"use client";

// "Find a value" (docs/plans/sandbox-p5-brief.md section 9): one target, one lever with a range, searched on top of the scenario on screen.
// The search is `goal-seek.ts` (at most 8 runs: the two ends together, then one at a time on the page's shared pool, without keeping the
// results). Cancel releases every run in flight; closing the dialog does the same. The answer is a sentence, the probes in a table, and (for
// Agency admins and the Owner) "Add as a change" into the working draft. A Viewer gets the answer only: nothing here saves anything.

import { useEffect, useMemo, useRef, useState } from "react";
import type { SandboxChange } from "@transpera-flow/db";
import type { EffectiveChange } from "@transpera-flow/db/sandbox";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { sharedSimPool } from "@/lib/forecast/sim-pool";
import { SANDBOX_HELP } from "@/lib/forecast/help";
import { Cancel, poolRunner, runGoalSeek, type RunContext, type SeekOutcome } from "@/lib/sandbox/analysis-run";
import { maxRunsFor, type Probe } from "@/lib/sandbox/goal-seek";
import { answerSentence, clampRange, goalChange, goalLever, goalLevers, goalNote, monotoneWarning, seekSpecFor, targetSpec, valueWords, type GoalChoice, type GoalTarget } from "@/lib/sandbox/goal-targets";

interface Option {
  id: string;
  name: string;
}

export interface GoalSeekDialogProps {
  /** The bundle, solutions, horizon and start the scenario on screen runs with. */
  run: RunContext;
  /** The scenario on screen's effective changes ([] for No changes). */
  base: readonly EffectiveChange[];
  cutoffs: readonly [number, number, number];
  roles: Option[];
  steps: Option[];
  services: Option[];
  /** The run's months, "YYYY-MM" and "October 2026", for "from a month" and for a profit in one month. */
  months: { value: string; label: string }[];
  currency: string;
  /** Profit targets need costs (Agency admins and the Owner). */
  canSeeMoney: boolean;
  /** "Add as a change" is offered (Agency admins and the Owner on a scenario they can edit). */
  canAdd: boolean;
  /** The change as a prefilled add (lever, target, month, how, value, note). */
  onAdd: (preset: { lever: string; target: string; month?: string; op: SandboxChange["op"]; value: number; note: string }) => void;
  onClose: () => void;
  /** Settings, Levers: kinds hidden from the change dialog are not searched either. */
  hiddenLevers?: readonly string[];
}

const num = (text: string, fallback: number) => {
  const v = Number(text);
  return text.trim() !== "" && Number.isFinite(v) ? v : fallback;
};
const percentText = (v: number) => String(Math.round(v * 1e4) / 100);

export function GoalSeekDialog(p: GoalSeekDialogProps) {
  const [kind, setKind] = useState<GoalTarget["kind"]>("busy");
  const [roleId, setRoleId] = useState("");
  const [busyText, setBusyText] = useState(percentText(p.cutoffs[1]));
  const [nines, setNines] = useState(false);
  const [churnText, setChurnText] = useState("3");
  const [profitText, setProfitText] = useState("0");
  const [profitMonth, setProfitMonth] = useState("");
  const levers = useMemo(() => goalLevers(p.hiddenLevers), [p.hiddenLevers]);
  const [leverId, setLeverId] = useState<GoalChoice["lever"]["id"]>(levers[0]?.id ?? "D5");
  const [targetId, setTargetId] = useState("");
  const [from, setFrom] = useState("");
  const lever = goalLever(leverId)!;
  const [loText, setLoText] = useState(String(lever.lo));
  const [hiText, setHiText] = useState(String(lever.hi));

  const [status, setStatus] = useState<"idle" | "running" | "done" | "cancelled" | "error">("idle");
  const [probes, setProbes] = useState<Probe[]>([]);
  const [outcome, setOutcome] = useState<SeekOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<Cancel | null>(null);
  // What the search on screen was asked (the form can change under the answer).
  const [used, setUsed] = useState<{ choice: GoalChoice; target: ReturnType<typeof targetSpec>; targetName: string | null; measureName: string } | null>(null);

  // Closing the dialog (or leaving the page) stops every run it started.
  useEffect(() => () => cancel.current?.cancel(), []);

  const choice: GoalChoice = useMemo(() => {
    const { lo, hi } = clampRange(lever, num(loText, lever.lo), num(hiText, lever.hi));
    return { lever, targetId, from: from || null, lo, hi };
  }, [lever, loText, hiText, targetId, from]);
  const aboutRuns = maxRunsFor({ lo: choice.lo, hi: choice.hi, step: lever.step, whole: lever.whole });

  const targetOf = (): GoalTarget => {
    if (kind === "busy") {
      const role = p.roles.find((r) => r.id === roleId);
      return { kind: "busy", roleId: roleId || null, roleName: role?.name ?? null, limit: num(busyText, p.cutoffs[1] * 100) / 100, nines };
    }
    if (kind === "churn") return { kind: "churn", limit: num(churnText, 3) / 100 };
    const month = profitMonth ? p.months.findIndex((m) => m.value === profitMonth) : -1;
    return { kind: "profit", threshold: num(profitText, 0), month: month >= 0 ? month : null, monthName: month >= 0 ? p.months[month]!.label : null, low: nines };
  };
  const optionsFor = (): { options: Option[]; none: string | null } => {
    switch (lever.target) {
      case "role":
        return { options: p.roles, none: "The busiest role" };
      case "role_or_none":
        return { options: p.roles, none: "All roles" };
      case "step":
        return { options: p.steps, none: "The heaviest step" };
      case "service_or_none":
        return { options: p.services, none: "All services" };
      default:
        return { options: [], none: null };
    }
  };
  const pickLever = (id: string) => {
    const next = goalLever(id)!;
    setLeverId(next.id);
    setTargetId("");
    setLoText(String(next.lo));
    setHiText(String(next.hi));
  };

  const start = async () => {
    const target = targetOf();
    const ts = targetSpec(target, p.currency);
    const targetName = p.roles.find((r) => r.id === targetId)?.name ?? p.steps.find((s) => s.id === targetId)?.name ?? p.services.find((s) => s.id === targetId)?.name ?? null;
    const measureName = kind === "busy" ? "How busy a role gets" : kind === "churn" ? "Monthly churn" : "Profit";
    const c = choice;
    setUsed({ choice: c, target: ts, targetName, measureName });
    const job = new Cancel();
    cancel.current?.cancel();
    cancel.current = job;
    setStatus("running");
    setProbes([]);
    setOutcome(null);
    setError(null);
    try {
      const out = await runGoalSeek(seekSpecFor(c, ts), poolRunner(sharedSimPool(), p.run), p.base, (x) => goalChange(c, x), (r) => (r.result.monthly ? ts.measure(r.result.monthly) : null), job, (_probe, state) => setProbes([...state.probes].sort((a, b) => a.x - b.x)));
      if (job.cancelled) return;
      setOutcome(out);
      setStatus(out.finished ? "done" : "cancelled");
    } catch (e) {
      if (!job.cancelled) {
        setError(e instanceof Error ? e.message : "The search couldn't run.");
        setStatus("error");
      }
    }
  };
  const stop = () => {
    cancel.current?.cancel();
    setStatus("cancelled");
  };

  const sentence = outcome && used ? answerSentence(outcome.answer, used.choice, used.target, used.targetName) : null;
  const warning = outcome && used ? monotoneWarning(outcome.answer, used.choice, used.measureName, used.targetName) : null;
  const canAddAnswer = p.canAdd && outcome && used && outcome.answer.kind === "boundary";
  const add = () => {
    if (!outcome || !used || outcome.answer.kind !== "boundary" || !sentence) return;
    const change = goalChange(used.choice, outcome.answer.x);
    p.onAdd({ lever: change.lever, target: change.target ?? "", ...(change.from ? { month: change.from } : {}), op: change.op, value: change.value, note: goalNote(sentence, new Date().toISOString().slice(0, 10)) });
    p.onClose();
  };
  const { options, none } = optionsFor();
  const running = status === "running";

  return (
    <Dialog open onOpenChange={(open) => !open && p.onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-2xl" data-goal-seek>
        <DialogHeader>
          <DialogTitle className="flex items-center">
            Find a value
            <Help {...SANDBOX_HELP.goalSeek} />
          </DialogTitle>
          <DialogDescription>Pick a target and one lever. It finds the smallest change that meets the target, on top of the scenario on screen. Nothing is saved.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Target
            <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as GoalTarget["kind"])} disabled={running} data-goal-kind>
              <option value="busy">How busy roles get</option>
              <option value="churn">Monthly churn</option>
              {p.canSeeMoney ? <option value="profit">Profit</option> : null}
            </NativeSelect>
          </label>
          {kind === "busy" ? (
            <>
              <label className="flex flex-col gap-1 text-sm font-medium">
                Roles
                <NativeSelect value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={running} data-goal-role>
                  <option value="">Every role</option>
                  {p.roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">
                At most this busy, in every month (%)
                <Input inputMode="decimal" value={busyText} onChange={(e) => setBusyText(e.target.value)} disabled={running} data-goal-limit />
              </label>
            </>
          ) : null}
          {kind === "churn" ? (
            <label className="flex flex-col gap-1 text-sm font-medium">
              At most this much churn a month (%)
              <Input inputMode="decimal" value={churnText} onChange={(e) => setChurnText(e.target.value)} disabled={running} data-goal-limit />
            </label>
          ) : null}
          {kind === "profit" ? (
            <>
              <label className="flex flex-col gap-1 text-sm font-medium">
                At least this profit ({p.currency})
                <Input inputMode="decimal" value={profitText} onChange={(e) => setProfitText(e.target.value)} disabled={running} data-goal-limit />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">
                Over
                <NativeSelect value={profitMonth} onChange={(e) => setProfitMonth(e.target.value)} disabled={running}>
                  <option value="">The whole run</option>
                  {p.months.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            </>
          ) : null}
          {kind === "busy" || (kind === "profit" && profitMonth) ? (
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" checked={nines} onChange={(e) => setNines(e.target.checked)} disabled={running} data-goal-nines />
              {kind === "busy" ? "In 9 of 10 runs, not just on average" : "In 9 of 10 runs, not just on average (a bad month)"}
            </label>
          ) : null}

          <label className="flex flex-col gap-1 text-sm font-medium">
            Lever
            <NativeSelect value={leverId} onChange={(e) => pickLever(e.target.value)} disabled={running} data-goal-lever>
              {levers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </NativeSelect>
          </label>
          {none !== null ? (
            <label className="flex flex-col gap-1 text-sm font-medium">
              Applies to
              <NativeSelect value={targetId} onChange={(e) => setTargetId(e.target.value)} disabled={running} data-goal-target>
                <option value="">{none}</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-sm font-medium">
            When
            <NativeSelect value={from} onChange={(e) => setFrom(e.target.value)} disabled={running} data-goal-from>
              <option value="">The whole run</option>
              {p.months.slice(1).map((m) => (
                <option key={m.value} value={m.value}>
                  From {m.label}
                </option>
              ))}
            </NativeSelect>
          </label>
          <div className="flex gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium">
              Lowest {lever.op === "add" ? "(people)" : lever.id === "B5" ? "(fraction, 0.1 is 10%)" : "(× today)"}
              <Input inputMode="decimal" value={loText} onChange={(e) => setLoText(e.target.value)} disabled={running} data-goal-lo />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium">
              Highest
              <Input inputMode="decimal" value={hiText} onChange={(e) => setHiText(e.target.value)} disabled={running} data-goal-hi />
            </label>
          </div>
        </div>

        <p className="text-xs text-muted-foreground" aria-live="polite" data-goal-status>
          {running
            ? `Run ${Math.min(probes.length + 1, aboutRuns)} of at most ${aboutRuns}…`
            : status === "cancelled"
              ? "Cancelled. Nothing was changed."
              : status === "error"
                ? `The search couldn't run: ${error}`
                : `About ${aboutRuns} runs over ${choice.lo} to ${choice.hi}, each a full run of the scenario.`}
        </p>

        {sentence ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm" data-goal-answer={outcome?.answer.kind}>
            <p className="font-medium">{sentence}</p>
            {warning ? (
              <p className="text-muted-foreground" role="note" data-goal-warning>
                {warning}
              </p>
            ) : null}
          </div>
        ) : null}

        {probes.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs tabular-nums" data-goal-probes>
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Tried
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Result
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Meets the target
                  </th>
                </tr>
              </thead>
              <tbody>
                {probes.map((pr) => (
                  <tr key={pr.x} className="border-t border-line">
                    <th scope="row" className="py-1 pr-3 text-left font-normal">
                      {used ? valueWords(used.choice, pr.x, used.targetName) : pr.x}
                    </th>
                    <td className="py-1 pr-3">{pr.value === null ? "no number" : used ? used.target.show(pr.value) : pr.value}</td>
                    <td className="py-1">{pr.meets ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <DialogFooter>
          {running ? (
            <Button variant="outline" onClick={stop} data-goal-cancel>
              Cancel
            </Button>
          ) : (
            <Button variant="outline" onClick={p.onClose}>
              Close
            </Button>
          )}
          {canAddAnswer ? (
            <Button variant="outline" onClick={add} data-goal-add>
              Add as a change
            </Button>
          ) : null}
          <Button onClick={start} disabled={running || levers.length === 0} title={levers.length === 0 ? "Settings, Levers hides every lever goal seek can move." : undefined} data-goal-start>
            {status === "idle" ? "Start" : "Search again"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
