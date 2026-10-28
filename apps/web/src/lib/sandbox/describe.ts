// A change in words (docs/plans/sandbox-p1-brief.md §4): "Opportunities ×1.25", "New PPC specialist starts", "Fees → £4,600".
// Pure: no React. The change list, the timeline lane and the compare view all use it.

import { sandboxLever, type ProcessBundle, type SandboxChange, type SandboxLever, type SolutionRow } from "@transpera-flow/db";
import { formatNumber, formatPercent, formatWholeCurrency } from "@/lib/format";
import { personName, viewerOf } from "@/lib/viewer";
import { hireNames, monthWord } from "./run";
import { othersTotal, percentText, weightToShare } from "./traffic";

/** What names a change's target: the bundle's roles, people (as the viewer's bundle names them), steps, services; and the solutions. */
export interface DescribeContext {
  bundle: Pick<ProcessBundle, "roles" | "people" | "steps" | "services" | "otherProcesses" | "workspace" | "viewer">;
  solutions: readonly Pick<SolutionRow, "id" | "name">[];
  /** Every change in the list the hire numbering runs over. */
  changes: readonly SandboxChange[];
  /** The live model's traffic weight per service type (id to `mix_share`): what a "Traffic by type" percentage is a share of. Else the bundle's active services. */
  mix?: Readonly<Record<string, number>>;
}

/**
 * A value in the lever's own terms: stored units for a multiplier, the displayed unit (a month, a percent) otherwise. Money is whole and
 * never compacted: the change list is rendered on the server too, and compact notation differs between Node's and browsers' ICU
 * ("£15.0K" / "£15k"), which broke hydration on any scenario with a fee or overheads change.
 */
export function formatChangeValue(lever: SandboxLever, op: SandboxChange["op"], value: number, currency = "GBP"): string {
  if (op === "multiply") return `×${formatNumber(value, 2)}`;
  const shown = value * (lever.displayScale ?? 1);
  const text =
    lever.unit === "share" && lever.id !== "A6"
      ? `${formatNumber(shown * 100, 1)}%`
      : lever.unit === "money"
        ? formatWholeCurrency(shown, currency)
        : lever.unit === "hours"
          ? `${formatNumber(shown, 1)} h`
          : lever.unit === "per_week"
            ? `${formatNumber(shown, 0)} a month`
            : lever.unit === "weeks"
              ? `${formatNumber(shown, 0)} weeks`
              : lever.unit === "fte"
                ? `${formatNumber(shown, 2)} FTE`
                : formatNumber(shown, 2);
  if (op === "add") return `${value >= 0 ? "+" : "−"}${text.replace(/^-/, "")}`;
  return `→ ${text}`;
}

/** The name of what a change points at. */
export function targetName(c: SandboxChange, ctx: DescribeContext): string | null {
  const lever = sandboxLever(c.lever);
  if (!lever || c.target === null) return null;
  const t = c.target;
  if (t === "@busiest") return "the busiest role";
  if (t === "@heaviest") return "the heaviest step";
  const b = ctx.bundle;
  switch (lever.target) {
    case "role":
      return b.roles.find((r) => r.id === t)?.name ?? "a role that is gone";
    case "person": {
      // Other people are named as the viewer may see them ("A team member" for a Viewer who cannot).
      const found = b.people.find((p) => p.id === t);
      return found ? personName(viewerOf(b), t, found.name) : "someone who is gone";
    }
    case "step":
      return [...b.steps, ...(b.otherProcesses ?? []).flatMap((p) => p.steps)].find((s) => s.id === t)?.name ?? "a step that is gone";
    case "service":
    case "service_or_none":
      return b.services.find((s) => s.id === t)?.name ?? "a service that is gone";
    case "solution":
      return ctx.solutions.find((s) => s.id === t)?.name ?? "a solution that is gone";
    case "health_rule":
      return t.replace("_", " ");
    default:
      return null;
  }
}

/** "1 Mar 2027" style month or date for a change's `from`. */
export function whenOf(c: SandboxChange): string | null {
  if (!c.from) return null;
  if (c.from.length === 7) return `from ${monthWord(c.from)}`;
  const [y, m, d] = c.from.split("-").map(Number) as [number, number, number];
  return `from ${d} ${monthWord(`${y}-${String(m).padStart(2, "0")}`).slice(0, 3)} ${y}`;
}

/** One change as a sentence (no date: `whenOf` has that). */
export function describeChange(c: SandboxChange, ctx: DescribeContext): string {
  const lever = sandboxLever(c.lever);
  if (!lever) return "An unknown change";
  const currency = ctx.bundle.workspace.settings.currency;
  const name = targetName(c, ctx);
  switch (c.lever) {
    case "D1":
      return `${hireNames(ctx.bundle, ctx.changes).get(c.id) ?? "New hire"} starts${c.value !== 1 ? ` (${formatNumber(c.value, 2)} FTE)` : ""}`;
    case "D2":
      return `${name} leaves`;
    case "D3":
      return `${name} on leave for ${formatNumber(c.value, 0)} week${c.value === 1 ? "" : "s"}`;
    case "E6":
      return `${name} goes live`;
    case "A6": {
      // A traffic change is a share of all opportunities: the stored weight against the other types' weights today.
      if (c.op === "set" && c.target) {
        const mix = ctx.mix ?? Object.fromEntries(ctx.bundle.services.filter((s) => s.active).map((s) => [s.id, Number(s.mix_share)]));
        return `${lever.label}, ${name} → ${percentText(weightToShare(c.value, othersTotal(mix, c.target)))}`;
      }
      return `${lever.label}, ${name} ${formatChangeValue(lever, c.op, c.value, currency)}`;
    }
    default: {
      const subject = name && lever.target !== "none" ? `${lever.label}, ${name}` : lever.label;
      return `${subject} ${formatChangeValue(lever, c.op, c.value, currency)}`;
    }
  }
}

export { formatPercent };
