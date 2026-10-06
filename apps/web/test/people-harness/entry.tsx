// The People page on a bare page, for ../people-browser.test.ts (B1 2b, issue #30): the whole page component with its
// simulation in a real Web Worker, rendered as a member sees it. Next's modules and Server Actions are stood in for by
// ../build-harness.ts. Nothing here ships.
//
// `Worker` is replaced by one that starts the bundled script the test hands over as `window.workerScripts`.

import { createRoot } from "react-dom/client";
import { larkspurBundle, larkspurPersonIds, type ProcessBundle } from "@transpera-flow/db";
import { PeoplePage } from "@/components/people-page";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    /** Every message the page posted to a worker: which worker, and the absence request's `personIds` (undefined when none). */
    workerRequests?: { file: string; hasPersonIds: boolean; personIds?: string[] }[];
    /** `own`: whose row the member may see (a Larkspur key such as "jess"), or null for a member linked to no one. */
    mountPeople: (options: { viewer: "everyone" | "own" | "unlinked"; own?: string; capacityFactorEnabled?: boolean }) => void;
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
    (super.postMessage as (...a: unknown[]) => void)(message, ...rest);
  }
} as typeof Worker;

/** What `team_capacity` hands a member: their own name, "Team member N" for everyone else, no pay but their own. */
function asMember(bundle: ProcessBundle, ownPersonId: string | null): ProcessBundle {
  const people = bundle.people.map((p, i) => (p.id === ownPersonId ? p : { ...p, name: `Team member ${i + 1}`, cost_rate: null }));
  return { ...bundle, people, viewer: { seesEveryone: false, ownPersonId } };
}

window.mountPeople = ({ viewer, own, capacityFactorEnabled }) => {
  const larkspur = larkspurBundle();
  // The workspace setting that C6 (#198, parked) would use. Nothing stores a factor, so turning it on must still show nothing.
  const base = capacityFactorEnabled
    ? { ...larkspur, workspace: { ...larkspur.workspace, settings: { ...larkspur.workspace.settings, capacity_factor_enabled: true } } }
    : larkspur;
  const ownId = viewer === "own" ? (larkspurPersonIds[own ?? "jess"] ?? null) : null;
  const bundle = viewer === "everyone" ? base : asMember(base, ownId);
  createRoot(document.getElementById("root")!).render(
    <div className="p-4">
      <PeoplePage bundle={bundle} settingsHref="/w/larkspur/settings" />
    </div>,
  );
};
