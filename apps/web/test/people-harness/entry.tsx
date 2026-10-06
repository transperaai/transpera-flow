// The People page on a bare page, for ../people-browser.test.ts (B1 2b, issue #30): the whole page component with its
// simulation in a real Web Worker, rendered as a member sees it. Next's modules and Server Actions are stood in for by
// ../build-harness.ts. Nothing here ships.
//
// `Worker` is replaced by one that starts the bundled script the test hands over as `window.workerScripts`.

import { createRoot } from "react-dom/client";
import { larkspurBundle, larkspurPersonIds, type PersonCapacityFactorRow, type ProcessBundle } from "@transpera-flow/db";
import { PeoplePage } from "@/components/people-page";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    /** Every message the page posted to a worker: which worker, and the absence request's `personIds` (undefined when none). */
    /** When true, requests to the simulation worker are kept back (see `releaseSimulations`). */
    holdSimulations?: boolean;
    heldSimulations?: (() => void)[];
    /** Stop holding, and send what was kept back. */
    releaseSimulations: () => void;
    workerRequests?:{ file: string; hasPersonIds: boolean; personIds?: string[] }[];
    /** `own`: whose row the member may see (a Larkspur key such as "jess"), or null for a member linked to no one. */
    mountPeople: (options: {
      viewer: "everyone" | "own" | "unlinked";
      own?: string;
      capacityFactorEnabled?: boolean;
      ownRecord?: "inactive" | "starts-later";
      /** Per-person times (C6) stored in the workspace; a member's bundle holds only their own, as `team_capacity` gives. */
      factors?: PersonCapacityFactorRow[];
    }) => void;
  }
}

const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL) {
    const file = String(url).split("/").pop()!;
    const script = window.workerScripts[file];
    if (!script) throw new Error(`No bundled worker for ${file}`);
    super(URL.createObjectURL(new Blob([script], { type: "text/javascript" })));
    this.file = file;
  }
  private file: string;
  // What the page asks each worker to do, so a test can see (for the absence test) whom the browser is asked to test.
  postMessage(message: unknown, ...rest: unknown[]) {
    const m = message as { personIds?: string[] } | null;
    (window.workerRequests ??= []).push({ file: this.file, hasPersonIds: m !== null && typeof m === "object" && m.personIds !== undefined, personIds: m?.personIds });
    const send = () => (super.postMessage as (...a: unknown[]) => void)(message, ...rest);
    // While a test holds simulations, a run's request waits here until `releaseSimulations()`, so it can look at the page mid-run
    // without racing the worker.
    if (this.file === "simulate.worker.ts" && window.holdSimulations) (window.heldSimulations ??= []).push(send);
    else send();
  }
} as typeof Worker;

window.releaseSimulations = () => {
  window.holdSimulations = false;
  for (const send of window.heldSimulations?.splice(0) ?? []) send();
};

/** What `team_capacity` hands a member: their own name, "Team member N" for everyone else, no pay but their own. */
function asMember(bundle: ProcessBundle, ownPersonId: string | null): ProcessBundle {
  const people = bundle.people.map((p, i) => (p.id === ownPersonId ? p : { ...p, name: `Team member ${i + 1}`, cost_rate: null }));
  return { ...bundle, people, viewer: { seesEveryone: false, ownPersonId } };
}

window.mountPeople = ({ viewer, own, capacityFactorEnabled, ownRecord, factors }) => {
  const larkspur = larkspurBundle();
  // The workspace switch for per-person times (C6, #198).
  const base = capacityFactorEnabled
    ? { ...larkspur, workspace: { ...larkspur.workspace, settings: { ...larkspur.workspace.settings, capacity_factor_enabled: true } } }
    : larkspur;
  const ownId = viewer === "own" ? (larkspurPersonIds[own ?? "jess"] ?? null) : null;
  // A linked member whose record isn't in the run: inactive, or starting after the period begins.
  const people = ownRecord
    ? base.people.map((p) => (p.id === ownId ? { ...p, ...(ownRecord === "inactive" ? { active: false } : { start_date: "2099-01-01" }) } : p))
    : base.people;
  const stored = factors ?? [];
  const bundle: ProcessBundle =
    viewer === "everyone"
      ? { ...base, personCapacityFactors: stored }
      : // `team_capacity` gives a member only their own person's rows ([] when linked to nobody).
        { ...asMember({ ...base, people }, ownId), personCapacityFactors: ownId ? stored.filter((f) => f.person_id === ownId) : [] };
  createRoot(document.getElementById("root")!).render(
    <div className="p-4">
      <PeoplePage bundle={bundle} settingsHref="/w/larkspur/settings" />
    </div>,
  );
};
