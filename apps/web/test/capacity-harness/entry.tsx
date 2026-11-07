// The Capacity page's view on a bare page, for ../capacity-page-browser.test.ts: the real component with its simulation in a real
// Web Worker, fed with the engine fixture `capacityModel()` and the Set up data that agrees with it (made-up data). Next's modules are
// stood in for by ../build-harness.ts. Nothing here ships.
//
// `Worker` is replaced by one that starts the bundled script the test hands over as `window.workerScripts`.

import { createRoot } from "react-dom/client";
import { capacitySetupFromModel, DEFAULT_PURPOSES } from "@transpera-flow/db";
import { capacityModel } from "@transpera-flow/engine";
import { CapacityView } from "@/components/capacity/capacity-view";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    mountCapacity: (options?: { payHidden?: boolean; noTiers?: boolean; missingWords?: boolean; badModel?: boolean; tierTotal?: "over" | "unassigned" }) => void;
  }
}

const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL) {
    const file = String(url).split("/").pop()!;
    const script = window.workerScripts[file];
    if (!script) throw new Error(`No bundled worker for ${file}`);
    super(URL.createObjectURL(new Blob([script], { type: "text/javascript" })));
  }
} as typeof Worker;

window.mountCapacity = ({ payHidden, noTiers, missingWords, badModel, tierTotal } = {}) => {
  const model = capacityModel();
  // The engine fixture labels steps with free text; steps made in the app carry the workspace's purpose keys, so the time-to-serve bars name them.
  const keys = DEFAULT_PURPOSES.map((p) => p.key);
  model.steps = model.steps.map((st, i) => ({ ...st, purpose: keys[i % 4]! }));
  const setup = capacitySetupFromModel(model, { payHidden });
  if (noTiers) setup.services = [];
  if (missingWords) setup.services[0]!.words = null;
  // Q13: a typed total of 0 is below whatever the first tier service holds; 5000 is above it.
  if (tierTotal) setup.services[0]!.client_total = tierTotal === "over" ? 0 : 5000;
  if (badModel) model.changes![0]!.adoption = 3;
  // Every servicing step belongs to its process, which the page links to.
  const stepProcess: Record<string, string> = {};
  for (const [pid, proc] of Object.entries(model.servicingProcesses ?? {})) for (const s of proc.steps) stepProcess[s] = pid;
  createRoot(document.getElementById("root")!).render(
    <div className="p-4">
      <CapacityView setup={setup} model={model} base="/w/example" stepProcess={stepProcess} />
    </div>,
  );
};
