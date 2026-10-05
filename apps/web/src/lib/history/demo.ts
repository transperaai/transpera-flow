// The demo's process history (issue #105): the Northbeam sample has one revision, so earlier versions are made
// from it by giving the busiest steps longer times, the way a process that has since been tightened up would have
// looked. Each version's changes are worked out from the steps that differ, as the database does for a real publish.

import { bundleForProcess, type ProcessBundle, type StepRow } from "@transpera-flow/db";
import { demoBundle } from "@/lib/sources/demo";
import type { AuthorKind, RevisionChanges, VersionMeta } from "./versions";

interface DemoVersion {
  number: number;
  publishedAt: string;
  authorKind: AuthorKind;
  authorName: string | null;
  /** Work-time factors for the process's three longest steps (work plus waiting) (1 is as it is today). */
  factors: [number, number, number];
}

// Oldest first. The last is the live version, the process as the sample has it.
const VERSIONS: DemoVersion[] = [
  { number: 1, publishedAt: "2026-07-14T09:30:00Z", authorKind: "user", authorName: "Priya Shah", factors: [1.7, 1.4, 1.2] },
  { number: 2, publishedAt: "2026-08-11T14:05:00Z", authorKind: "user", authorName: "Maya Collins", factors: [1.4, 1.2, 1.1] },
  { number: 3, publishedAt: "2026-09-02T10:15:00Z", authorKind: "mcp", authorName: null, factors: [1.1, 1.1, 1.05] },
  { number: 4, publishedAt: "2026-09-29T16:40:00Z", authorKind: "user", authorName: "Priya Shah", factors: [1, 1, 1] },
];

const revisionId = (n: number) => `d0000000-0000-4000-8000-00000000000${n}`;

/** The process's longest steps, which the older versions give more time to. */
function longestSteps(steps: readonly StepRow[]): string[] {
  return [...steps]
    .filter((s) => s.work_hours + s.wait_hours > 0)
    .sort((a, b) => b.work_hours + b.wait_hours - (a.work_hours + a.wait_hours) || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((s) => s.id);
}

function atVersion(bundle: ProcessBundle, v: DemoVersion): ProcessBundle {
  const longest = longestSteps(bundle.steps);
  return {
    ...bundle,
    revision: { ...bundle.revision, id: revisionId(v.number), number: v.number, status: v.number === VERSIONS.length ? "published" : "superseded" },
    steps: bundle.steps.map((s) => {
      const i = longest.indexOf(s.id);
      const f = i < 0 ? 1 : v.factors[i]!;
      return i < 0 ? s : { ...s, work_hours: Math.round(s.work_hours * f * 10) / 10, wait_hours: Math.round(s.wait_hours * f * 10) / 10 };
    }),
  };
}

/** The demo process's versions (newest first), or null if the sample has no such process. */
export function demoHistory(processId: string): { versions: VersionMeta[]; processName: string; kind: "pipeline" | "servicing" } | null {
  const base = bundleForProcess(demoBundle(), processId);
  if (!base) return null;
  const bundles = VERSIONS.map((v) => atVersion(base, v));
  const versions = VERSIONS.map((v, i): VersionMeta => {
    const now = bundles[i]!;
    const before = i > 0 ? bundles[i - 1]! : null;
    const changed = before ? now.steps.filter((s, k) => s.work_hours !== before.steps[k]!.work_hours || s.wait_hours !== before.steps[k]!.wait_hours).length : 0;
    const changes: RevisionChanges | null = before ? { steps: { added: 0, removed: 0, changed }, edges: { added: 0, removed: 0, changed: 0 } } : null;
    return { revisionId: revisionId(v.number), number: v.number, live: v.number === VERSIONS.length, publishedAt: v.publishedAt, authorKind: v.authorKind, authorName: v.authorName, changes };
  });
  return { versions: versions.reverse(), processName: base.process.name, kind: base.process.kind };
}

/** The number of the demo's live version. */
export const DEMO_LIVE_VERSION = VERSIONS.length;

/** The demo process as an earlier version (`?version=N` on its page), or null if `n` isn't an earlier version. */
export function demoBundleAtVersion(base: ProcessBundle, n: number): ProcessBundle | null {
  const v = VERSIONS.find((x) => x.number === n);
  return v && n < DEMO_LIVE_VERSION ? atVersion(base, v) : null;
}
