// The real Historical data cards (issue #40, C1) on a bare page, for ../csv-import-browser.test.ts: the stage history card, the
// clients and servicing card and the leads and invoices card, with the import wizard's file reading in a real Web Worker, so a test
// can see the read go through it and stop it. Next's modules and Server Actions are stood in for by ../build-harness.ts. Nothing here ships.
//
// The wizard's worker is made with `new Worker(new URL("../../workers/csv-import.worker.ts", import.meta.url), { type: "module" })`.
// The test bundles each worker script and hands it over as `window.importWorkerScripts`; `Worker` is replaced by one that starts the
// bundled script for the file asked for, and notes every message posted to it in `window.importWorkerPosts` (the file and the op).

import { createRoot } from "react-dom/client";
import type { ImportKind } from "@transpera-flow/db/csv-import";
import { CalibrationPanel } from "@/components/calibration/calibration-panel";
import { ClientCalibrationPanel } from "@/components/calibration/client-calibration-panel";
import { OtherImportsPanel } from "@/components/calibration/other-imports-panel";
import { importSamples } from "@/lib/calibration/import-samples";
import { calibrationRows } from "@/lib/calibration/rows";
import { personTimesSetup } from "@/lib/calibration/person-times";
import { clientCalibrationRows, simulationPlan } from "@/lib/calibration/client-rows";
import { SAMPLE_AS_OF } from "@/lib/calibration/client-sample";
import { demoBundle } from "@/lib/sources/demo";

declare global {
  interface Window {
    importWorkerScripts: Record<string, string>;
    /** Each message posted to a worker, in order: its file, and the `op` of the message. */
    importWorkerPosts: { file: string; op: string | null }[];
    /** `personTimes` (#227): hidden (a member), off (an owner or editor with the switch off) or on; Northbeam's people. Default hidden. */
    mountImport: (options?: {
      mode?: "live" | "readonly" | "demo";
      previous?: Partial<Record<ImportKind, Record<string, string>>>;
      samples?: boolean;
      personTimes?: "hidden" | "off" | "on";
    }) => void;
  }
}

const NativeWorker = window.Worker;
window.importWorkerPosts = [];
window.Worker = class extends NativeWorker {
  private readonly file: string;
  constructor(url: string | URL) {
    const file = String(url).split("/").pop()!;
    const script = window.importWorkerScripts[file];
    if (!script) throw new Error(`No bundled worker for ${file}`);
    super(URL.createObjectURL(new Blob([script], { type: "text/javascript" })));
    this.file = file;
  }
  postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
    window.importWorkerPosts.push({ file: this.file, op: typeof message === "object" && message !== null ? ((message as { op?: string }).op ?? null) : null });
    super.postMessage(message, options as StructuredSerializeOptions);
  }
} as typeof Worker;

const bundle = demoBundle();
const processes = [bundle.process, ...(bundle.otherProcesses ?? []).map((p) => p.process)].map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
const rows = clientCalibrationRows(bundle, processes);
const runs = simulationPlan(rows, bundle.process.id).map((item) => ({ processId: item.processId, processName: bundle.process.name, serviceIds: item.serviceIds, bundle }));
const stored = calibrationRows(bundle, null);
const leadSources = stored.leadSources.map((s) => ({ id: s.id, name: s.name, volumeWeek: Number(s.volume_week) }));

const withSwitch = (on: boolean) => ({ ...bundle, workspace: { ...bundle.workspace, settings: { ...bundle.workspace.settings, capacity_factor_enabled: on } } });
const personTimesFor = (state: "hidden" | "off" | "on") =>
  state === "hidden" ? ({ state: "hidden" } as const) : personTimesSetup(withSwitch(state === "on"), stored.steps);

window.mountImport = (options = {}) => {
  const mode = options.mode ?? "live";
  const previous = options.previous ?? {};
  const samples = options.samples ? importSamples() : undefined;
  createRoot(document.getElementById("root")!).render(
    <div className="flex flex-col gap-6">
      <CalibrationPanel
        mode={mode}
        workspaceId="w1"
        base="/w/harness"
        processes={[{ id: bundle.process.id, name: bundle.process.name, kind: bundle.process.kind }]}
        process={{ id: bundle.process.id, name: bundle.process.name, kind: bundle.process.kind }}
        hasDraft={false}
        stored={stored}
        history={[]}
        personTimes={personTimesFor(options.personTimes ?? "hidden")}
        previous={previous}
        sample={samples}
      />
      <ClientCalibrationPanel mode={mode} workspaceId="w1" base="/w/harness" rows={rows} runs={runs} history={[]} defaultAsOf={SAMPLE_AS_OF} previous={previous} sample={samples} />
      <OtherImportsPanel mode={mode} workspaceId="w1" leadSources={leadSources} previous={previous} sample={samples} asOf={Date.parse(SAMPLE_AS_OF)} />
    </div>,
  );
};
