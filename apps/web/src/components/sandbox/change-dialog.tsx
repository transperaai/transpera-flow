"use client";

// Add or edit one change of a Sandbox scenario (docs/plans/sandbox-p1-brief.md §4). One dialog for every lever, for adding and
// editing: the lever (by group, offered and shown kinds only, greyed with its reason when it would do nothing in this model), what it
// points at, how (set, multiply or add) and the value in the registry's range, and when (the whole run, or from a month; a Monday
// for leave). Months are the run's own; no earlier month is offered.

import { useState } from "react";
import { HIRE_FTE, sandboxLever, sqlTargetClass, type SandboxChange, type SandboxLever } from "@transpera-flow/db";

type PatchOp = SandboxChange["op"];
import { HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { formatNumber } from "@/lib/format";
import { SANDBOX_HELP } from "@/lib/forecast/help";
import { mondayOnOrBefore } from "@/lib/forecast/positions";
import { greyedLevers, listWords } from "@/lib/sandbox/greyed";
import { longDate, weekdayDate } from "@/lib/sandbox/lane";
import { MAX_TRAFFIC_PERCENT, othersTotal, shareToWeight, weightToShare } from "@/lib/sandbox/traffic";

/** `preset`: an add that starts on a lever, target and month (the "Try a hire" link under "With this scenario"). */
export type ChangeTarget = { mode: "add"; preset?: { lever: string; target: string; month?: string } } | { mode: "edit"; change: SandboxChange };

export interface NamedOption {
  id: string;
  name: string;
}

export interface SolutionOption extends NamedOption {
  processName: string;
  /** Whether the run's company model includes this solution's process. */
  inModel: boolean;
  leverChanges: number;
  /** True when the solution was made from a version of its process other than the live one. */
  older: boolean;
}

const GROUPS: Record<SandboxLever["group"], string> = { A: "Market and sales", B: "Clients", C: "Money", D: "People", E: "Process", X: "Kept from before" };

export interface ChangeDialogProps {
  target: ChangeTarget;
  /** The levers to offer (offered, kind not hidden); an edited change's own lever is added if missing. */
  levers: readonly SandboxLever[];
  appliesReason: (leverId: string) => string | null;
  roles: NamedOption[];
  people: NamedOption[];
  steps: NamedOption[];
  services: NamedOption[];
  /** Lead sources (A1 can point at one) and the churn drivers (B4): built-ins by key, your own as `custom:<id>`. */
  leadSources?: NamedOption[];
  drivers?: NamedOption[];
  solutions: SolutionOption[];
  /** The run's months: "YYYY-MM" as the value, "October 2026" as the label. */
  months: { value: string; label: string }[];
  /** The month a new change starts in, and the Monday a new leave starts on. */
  defaultMonth: string;
  defaultMonday: string;
  currency: string;
  /** What a lever stands at today for the target picked ("about 30 opportunities a month"), from the live model the runs use; null: nothing to say. */
  today: (leverId: string, targetId: string | null) => string | null;
  /** The live model's traffic weight per service type: what the "Traffic by type" percentages are shares of. */
  mix: Readonly<Record<string, number>>;
  /** A message when the change (as it would be saved) can't be part of the scenario, else null. */
  validate: (change: SandboxChange) => string | null;
  onSubmit: (change: SandboxChange) => void;
  onRemove: () => void;
  onClose: () => void;
}

const OP_WORD: Record<PatchOp, string> = { set: "Set to", multiply: "Multiply by", add: "Add" };

export function ChangeDialog(props: ChangeDialogProps) {
  const { target, appliesReason, roles, people, steps, services, leadSources = [], drivers = [], solutions, months, defaultMonth, defaultMonday, today, mix, validate, onSubmit, onRemove, onClose } = props;
  const editing = target.mode === "edit" ? target.change : null;
  const editedLever = editing ? sandboxLever(editing.lever) : undefined;
  const levers = editedLever && !props.levers.some((l) => l.id === editedLever.id) ? [editedLever, ...props.levers] : props.levers;
  const preset = target.mode === "add" && target.preset && levers.some((l) => l.id === target.preset!.lever) ? target.preset : null;
  const firstUsable = levers.find((l) => !appliesReason(l.id))?.id ?? levers[0]?.id ?? "A1";
  const [leverId, setLeverId] = useState<string>(editing?.lever ?? preset?.lever ?? firstUsable);
  const lever = sandboxLever(leverId) ?? levers[0]!;
  const offeredOps = (l: SandboxLever): PatchOp[] => {
    const ops = (Object.keys(l.range) as PatchOp[]).filter((o) => l.ops.includes(o));
    return ops.length ? ops : [...l.ops];
  };
  const [op, setOp] = useState<PatchOp>(editing?.op ?? offeredOps(lever)[0]!);
  // A multiplier is a plain number; only a set or an add is shown in the lever's display unit (a month, not a week).
  const scaleOf = (o: PatchOp) => (o === "multiply" ? 1 : (lever.displayScale ?? 1));
  const scale = scaleOf(op);
  // Traffic by type is typed as a percentage of all traffic; the stored weight is worked out against the other types (./traffic.ts).
  const trafficEdit = editing && editing.lever === "A6" && editing.op === "set" && editing.target ? Math.round(weightToShare(editing.value, othersTotal(mix, editing.target)) * 1000) / 10 : null;
  const initialValue = editing && editing.lever === lever.id ? String(trafficEdit ?? Math.round(editing.value * scaleOf(editing.op) * 1e6) / 1e6) : lever.id === "D1" ? "1" : lever.id === "E6" ? "1" : lever.id === "D3" ? "2" : lever.id === "D2" ? "0" : "";
  const [valueText, setValueText] = useState(initialValue);
  const [targetId, setTargetId] = useState<string>(editing?.target ?? preset?.target ?? "");
  const [hireName, setHireName] = useState(editing?.params?.name ?? "");
  // Phase 3 extras: a fee range's ends (A5), when a fee applies (B2), and a driver's chance and months (B4).
  const [lowText, setLowText] = useState(editing?.params?.low !== undefined ? String(editing.params.low) : "");
  const [highText, setHighText] = useState(editing?.params?.high !== undefined ? String(editing.params.high) : "");
  const [who, setWho] = useState<"new" | "all">(editing?.params?.who ?? "new");
  const [chanceText, setChanceText] = useState(editing?.params?.chance !== undefined ? String(Math.round(editing.params.chance * 1e4) / 100) : "");
  const [monthsText, setMonthsText] = useState(editing?.params?.months !== undefined ? String(editing.params.months) : "");
  const [timed, setTimed] = useState<boolean>(editing ? editing.from !== undefined : preset?.month !== undefined);
  const [month, setMonth] = useState(editing?.from && editing.from.length === 7 ? editing.from : (preset?.month ?? defaultMonth).slice(0, 7));
  const [monday, setMonday] = useState(editing?.from && editing.from.length === 10 ? editing.from : defaultMonday);
  const [error, setError] = useState<string | null>(null);

  const cls = sqlTargetClass(lever);
  const options: NamedOption[] =
    lever.target === "role" || lever.target === "role_or_none"
      ? roles
      : lever.target === "person"
        ? people
        : lever.target === "step"
          ? steps
          : lever.target === "service" || lever.target === "service_or_none"
            ? services
            : lever.target === "lead_source_or_none"
              ? leadSources
              : lever.target === "driver"
                ? drivers
                : lever.target === "solution"
                  ? solutions.filter((s) => s.inModel || s.id === targetId)
                  : [];
  // These can point at one thing or at all of it (an empty target); fees still need a type when there are types.
  const allowAll = ["A1", "B1", "B3", "B5", "D6"].includes(lever.id);
  const selectors = lever.selector ? [{ id: lever.selector, name: lever.selector === "@busiest" ? "The busiest role" : "The heaviest step" }] : [];
  const needsTarget = cls !== "none" && !(cls === "id_or_none" && (allowAll ? options.length === 0 : services.length === 0));
  const effectiveTarget = needsTarget ? (allowAll ? targetId : targetId || options[0]?.id || "") : "";
  const mustBeTimed = !lever.wholeRun;
  const canTime = lever.timed !== false;
  const isMonday = lever.timing === "monday";
  const monthOptions = months.some((m) => m.value === month) ? months : [{ value: month, label: longDate(`${month}-01`).replace(/^\d+ /, "") }, ...months];
  const snapped = /^\d{4}-\d{2}-\d{2}$/.test(monday) && !Number.isNaN(Date.parse(`${monday}T00:00:00Z`)) ? mondayOnOrBefore(monday) : null;
  const solution = lever.id === "E6" ? solutions.find((s) => s.id === effectiveTarget) : undefined;

  const traffic = lever.id === "A6" && op === "set";
  const range = lever.range[op];
  const shownMin = traffic ? 0 : range ? range.min * scale : undefined;
  const shownMax = traffic ? MAX_TRAFFIC_PERCENT : range ? range.max * scale : undefined;
  const todayText = today(lever.id, needsTarget ? effectiveTarget || null : null);
  const fixedValue = lever.id === "D2" || lever.id === "E6";
  const kindWord = lever.id === "D1" ? "FTE" : lever.id === "D3" ? "weeks" : traffic ? "% of all opportunities" : lever.unit === "per_week" ? "a month" : lever.unit === "share" && lever.id !== "A6" && op !== "multiply" ? "as a fraction, 0.1 is 10%" : "";

  const pickLever = (id: string) => {
    const next = sandboxLever(id)!;
    setLeverId(id);
    setOp(offeredOps(next)[0]!);
    setTargetId("");
    setValueText(id === "D1" || id === "E6" ? "1" : id === "D3" ? "2" : id === "D2" ? "0" : "");
    if (next.wholeRun === false) setTimed(true);
    if (next.timed === false) setTimed(false);
    setError(null);
  };

  const build = (): { change: SandboxChange } | { error: string } => {
    const id = editing?.id ?? crypto.randomUUID();
    if (needsTarget && !effectiveTarget && !allowAll) return { error: `Pick what to change.` };
    const n = fixedValue ? (lever.id === "E6" ? 1 : 0) : Number(valueText);
    if (!fixedValue && (!valueText.trim() || !Number.isFinite(n))) return { error: "Enter a value." };
    let stored = Math.round((n / scale) * 1e6) / 1e6;
    if (traffic && !fixedValue) {
      if (n < 0 || n > MAX_TRAFFIC_PERCENT) return { error: `Use a share from 0% to ${MAX_TRAFFIC_PERCENT}%.` };
      const weight = shareToWeight(n / 100, othersTotal(mix, effectiveTarget));
      if (weight === null) return { error: "The other types have no traffic to share, so this type would stay at 100%." };
      if (range && weight > range.max) return { error: "That share is too high next to the other types' traffic. Try a lower one." };
      stored = weight;
    } else if (!fixedValue) {
      if (lever.id === "D1") {
        if (stored < HIRE_FTE.accepted.min || stored > HIRE_FTE.accepted.max) return { error: "FTE must be between 0.1 and 2." };
      } else if (lever.id === "D3") {
        if (!Number.isInteger(stored) || stored < 1 || stored > 52) return { error: "Leave lasts 1 to 52 whole weeks." };
      } else if (lever.id === "D9") {
        // The database takes whole months only (is_sandbox_change), so say it here rather than at Save.
        if (!Number.isInteger(stored) || stored < 0 || stored > 6) return { error: "A hiring delay is 0 to 6 whole months." };
      } else if (range && (stored < range.min - 1e-9 || stored > range.max + 1e-9)) {
        return { error: `Use a value between ${formatNumber(range.min * scale, 3)} and ${formatNumber(range.max * scale, 3)}.` };
      }
    }
    let from: string | undefined;
    if (mustBeTimed || (canTime && timed)) {
      if (isMonday) {
        if (!snapped) return { error: "Pick the date the leave starts." };
        from = snapped;
      } else from = month;
    }
    const typed = hireName.trim();
    if (lever.id === "D1" && typed.length > 120) return { error: "A name can have up to 120 characters." };
    let params: SandboxChange["params"];
    if (lever.id === "D1" && typed) params = { name: typed };
    if (lever.id === "A5") {
      const low = Number(lowText);
      const high = Number(highText);
      if (!lowText.trim() || !highText.trim() || !Number.isFinite(low) || !Number.isFinite(high)) return { error: "Enter the lowest and the highest fee." };
      if (low < 0 || low > stored || stored > high) return { error: "The lowest fee can't be more than the likely one, and the highest can't be less." };
      params = { low, high };
    }
    if (lever.id === "B2" && who === "all") params = { who: "all" };
    if (lever.id === "B4") {
      const p: NonNullable<SandboxChange["params"]> = {};
      if (chanceText.trim()) {
        const chance = Number(chanceText) / 100;
        if (!Number.isFinite(chance) || chance < 0 || chance > 1) return { error: "A chance is between 0% and 100%." };
        p.chance = Math.round(chance * 1e6) / 1e6;
      }
      if (monthsText.trim()) {
        const months = Number(monthsText);
        if (!Number.isInteger(months) || months < 1 || months > 24) return { error: "A hit lasts 1 to 24 whole months." };
        p.months = months;
      }
      if (Object.keys(p).length) params = p;
    }
    const change: SandboxChange = {
      id,
      lever: lever.id,
      target: needsTarget && effectiveTarget ? effectiveTarget : null,
      op: fixedValue || lever.id === "D1" || lever.id === "D3" ? "set" : op,
      value: stored,
      ...(from ? { from } : {}),
      ...(params ? { params } : {}),
    };
    return { change };
  };

  const submit = () => {
    const built = build();
    if ("error" in built) return setError(built.error);
    const problem = validate(built.change);
    if (problem) return setError(problem);
    onSubmit(built.change);
  };

  // The greyed levers can't be picked, so their reasons are listed under the list (the chosen lever's own reason is above).
  const greyed = greyedLevers(
    levers.filter((l) => l.id !== lever.id),
    appliesReason,
  );
  const grouped = (Object.keys(GROUPS) as SandboxLever["group"][]).map((g) => ({ g, items: levers.filter((l) => l.group === g) })).filter((x) => x.items.length);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-change-dialog={lever.id}
        // Start on the first field, not on the (i) beside its label (which would open its help).
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLElement>("select, input")?.focus();
        }}
      >
        <form
          className="contents"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? "Change this change" : "Add a change"}</DialogTitle>
            <DialogDescription>{lever.description}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-0.5">
              <HelpLabel {...SANDBOX_HELP.lever} />
              <NativeSelect aria-label="What to change" value={leverId} onChange={(e) => pickLever(e.target.value)} disabled={editing !== null}>
                {grouped.map(({ g, items }) => (
                  <optgroup key={g} label={GROUPS[g]}>
                    {items.map((l) => {
                      const reason = appliesReason(l.id);
                      return (
                        <option key={l.id} value={l.id} disabled={reason !== null && l.id !== leverId}>
                          {l.label}
                          {reason ? ` (does nothing here)` : ""}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </NativeSelect>
              {appliesReason(lever.id) ? <span className="text-xs text-muted-foreground">{appliesReason(lever.id)}</span> : null}
              {greyed.length ? (
                <span className="flex flex-col text-xs text-muted-foreground" data-greyed-levers>
                  {greyed.map((g) => (
                    <span key={g.reason}>
                      {listWords(g.labels)} {g.labels.length === 1 ? "is" : "are"} greyed out: {g.reason}
                    </span>
                  ))}
                </span>
              ) : null}
            </label>

            {needsTarget ? (
              <label className="flex flex-col gap-0.5">
                <HelpLabel {...(lever.id === "D1" ? SANDBOX_HELP.hireRole : lever.id === "D3" || lever.id === "D2" ? SANDBOX_HELP.leavePerson : lever.id === "E6" ? SANDBOX_HELP.solutionPick : SANDBOX_HELP.target)} />
                <NativeSelect aria-label="On" value={effectiveTarget} onChange={(e) => setTargetId(e.target.value)}>
                  {allowAll ? <option value="">{lever.id === "A1" ? "All opportunities" : lever.id === "D6" ? "Everyone" : "All types"}</option> : null}
                  {selectors.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                  {options.map((o) => (
                    <option key={o.id} value={o.id} disabled={"inModel" in o && !(o as SolutionOption).inModel && o.id !== effectiveTarget}>
                      {o.name}
                      {"inModel" in o && !(o as SolutionOption).inModel ? " (not part of the run)" : ""}
                    </option>
                  ))}
                  {editing?.target && !selectors.some((s) => s.id === editing.target) && !options.some((o) => o.id === editing.target) ? <option value={editing.target}>(something that is gone)</option> : null}
                </NativeSelect>
                {solution && solution.leverChanges > 0 ? (
                  <span className="text-xs text-muted-foreground">Its {solution.leverChanges} lever change{solution.leverChanges === 1 ? "" : "s"} apply from the month it goes live.</span>
                ) : null}
                {solution?.older ? <span className="text-xs text-muted-foreground">Made from an older version of {solution.processName}; the run uses the solution&apos;s map as saved.</span> : null}
              </label>
            ) : null}

            {todayText ? (
              <p className="text-xs text-muted-foreground" data-today>
                Today: {todayText}
              </p>
            ) : null}

            {!fixedValue ? (
              <div className="flex flex-wrap items-end gap-3">
                {lever.id !== "D1" && lever.id !== "D3" && offeredOps(lever).length + (editing && !offeredOps(lever).includes(editing.op) ? 1 : 0) > 1 ? (
                  <label className="flex flex-col gap-0.5">
                    <HelpLabel {...SANDBOX_HELP.how} />
                    <NativeSelect aria-label="How" value={op} onChange={(e) => setOp(e.target.value as PatchOp)}>
                      {[...new Set([...offeredOps(lever), ...(editing && editing.lever === lever.id ? [editing.op] : [])])].map((o) => (
                        <option key={o} value={o}>
                          {OP_WORD[o]}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                ) : null}
                <label className="flex min-w-[8rem] flex-1 flex-col gap-0.5">
                  <HelpLabel {...(lever.id === "D1" ? SANDBOX_HELP.hireFte : lever.id === "D3" ? SANDBOX_HELP.leaveFor : { label: traffic ? "Share (%)" : "Value", description: `The value, ${kindWord || "in the units shown"}. ${shownMin !== undefined ? `From ${formatNumber(shownMin, 3)} to ${formatNumber(shownMax!, 3)}.` : ""}`, example: "Multiply by 0.6 for 40% less." })} />
                  <Input
                    aria-label={lever.id === "D1" ? "FTE" : lever.id === "D3" ? "For (weeks)" : traffic ? "Share (%)" : "Value"}
                    type="number"
                    inputMode="decimal"
                    step={traffic ? 0.1 : (range?.step ?? "any")}
                    min={lever.id === "D1" ? HIRE_FTE.offered.min : shownMin}
                    max={lever.id === "D1" ? HIRE_FTE.offered.max : shownMax}
                    value={valueText}
                    onChange={(e) => setValueText(e.target.value)}
                  />
                  {kindWord || shownMin !== undefined ? (
                    <span className="text-xs text-muted-foreground">
                      {lever.id === "D1" ? "0.1 to 1.5 (up to 2 is accepted)" : shownMin !== undefined ? `${formatNumber(shownMin, 3)} to ${formatNumber(shownMax!, 3)}` : ""}
                      {kindWord && lever.id !== "D1" ? ` ${kindWord}` : ""}
                    </span>
                  ) : null}
                </label>
              </div>
            ) : null}

            {lever.id === "D1" ? (
              <label className="flex flex-col gap-0.5">
                <HelpLabel {...SANDBOX_HELP.hireName} />
                <Input aria-label="Name" value={hireName} maxLength={120} placeholder={`New ${roles.find((r) => r.id === effectiveTarget)?.name ?? "hire"}`} onChange={(e) => setHireName(e.target.value)} />
              </label>
            ) : null}

            {lever.id === "A5" ? (
              <div className="flex flex-wrap gap-3" data-fee-range>
                <label className="flex min-w-[8rem] flex-1 flex-col gap-0.5">
                  <HelpLabel label="Lowest fee" description="The least a new client of this type pays." example="3,000 when most clients pay about 4,000." />
                  <Input aria-label="Lowest fee" type="number" inputMode="decimal" min={0} value={lowText} onChange={(e) => setLowText(e.target.value)} />
                </label>
                <label className="flex min-w-[8rem] flex-1 flex-col gap-0.5">
                  <HelpLabel label="Highest fee" description="The most a new client of this type pays." example="6,000 for the occasional large client." />
                  <Input aria-label="Highest fee" type="number" inputMode="decimal" min={0} value={highText} onChange={(e) => setHighText(e.target.value)} />
                </label>
                <span className="basis-full text-xs text-muted-foreground">The value above is the likely fee. Each new client&apos;s fee is drawn between the lowest and highest, most often near the likely one. Clients you already have keep theirs.</span>
              </div>
            ) : null}

            {lever.id === "B2" ? (
              <label className="flex flex-col gap-0.5">
                <HelpLabel label="Who pays it" description="New clients only, or every client including the ones you already have. A rise that should carry its churn is a Price rise." example="New and existing clients: today's clients pay the new fee too." />
                <NativeSelect aria-label="Who pays it" value={who} onChange={(e) => setWho(e.target.value as "new" | "all")}>
                  <option value="new">New clients</option>
                  <option value="all">New and existing clients</option>
                </NativeSelect>
                {who === "all" ? <span className="text-xs text-muted-foreground">This has no churn effect. For a rise that loses clients, use Price rise.</span> : null}
              </label>
            ) : null}

            {lever.id === "B4" ? (
              <div className="flex flex-wrap gap-3" data-driver-chance>
                <label className="flex min-w-[8rem] flex-1 flex-col gap-0.5">
                  <HelpLabel label="Chance a month" description="The chance this cause hits a client in a month. Leave it blank to use what the engine measures (or the usual default for causes you enter)." example="5 means one client in twenty is hit each month." />
                  <Input aria-label="Chance a month (%)" type="number" inputMode="decimal" min={0} max={100} placeholder="measured" value={chanceText} onChange={(e) => setChanceText(e.target.value)} />
                </label>
                <label className="flex min-w-[8rem] flex-1 flex-col gap-0.5">
                  <HelpLabel label="For (months)" description="How long a hit lasts. A second hit while one lasts only extends it." example="3 months is the usual." />
                  <Input aria-label="For (months)" type="number" inputMode="numeric" min={1} max={24} placeholder="3" value={monthsText} onChange={(e) => setMonthsText(e.target.value)} />
                </label>
                <span className="basis-full text-xs text-muted-foreground">
                  {effectiveTarget === "price"
                    ? "The value above is how much a 10% rise raises a hit client's chance of leaving, in percent (a 20% rise counts double). The chance is the share of clients who notice a rise. Turns the cause on."
                    : "The value above is how much a hit raises that client's chance of leaving, in percent. Turns the cause on."}
                </span>
              </div>
            ) : null}

            {lever.id === "B5" ? (
              <p className="text-xs text-muted-foreground" data-price-rise-note>
                A rise reaches existing and new clients, and counts the clients it loses (the Price changes driver is switched on in this run and in the run without the rise it is compared with). The result shows what it gains, what it loses and what it nets.
              </p>
            ) : null}

            {canTime ? (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-0.5">
                  <HelpLabel {...SANDBOX_HELP.when} />
                </legend>
                {mustBeTimed ? null : (
                  <div className="flex flex-wrap gap-4 text-sm">
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name="when" checked={!timed} onChange={() => setTimed(false)} /> Whole run
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name="when" checked={timed} onChange={() => setTimed(true)} /> From a month
                    </label>
                  </div>
                )}
                {mustBeTimed || timed ? (
                  isMonday ? (
                    <label className="flex flex-col gap-0.5">
                      <Input aria-label="From" type="date" value={monday} onChange={(e) => setMonday(e.target.value)} />
                      {snapped ? <span className="text-xs text-muted-foreground">{weekdayDate(snapped)}</span> : null}
                    </label>
                  ) : (
                    <NativeSelect aria-label="From month" value={month} onChange={(e) => setMonth(e.target.value)}>
                      {monthOptions.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </NativeSelect>
                  )
                ) : null}
              </fieldset>
            ) : (
              <p className="text-xs text-muted-foreground">This change applies to the whole run: it is where the run starts.</p>
            )}
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive" data-change-dialog-error>
              {error}
            </p>
          ) : null}

          <DialogFooter>
            {editing ? (
              <Button type="button" variant="destructive" className="sm:mr-auto" onClick={onRemove}>
                Remove
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={levers.length === 0}>
              {editing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

