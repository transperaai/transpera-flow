// The Capacity page's view on a bare page, for ../capacity-page-browser.test.ts: the real component with its two simulations in a real
// Web Worker, fed with the engine fixture `capacityModel()` and the Set up data that agrees with it (made-up data). Next's modules are
// stood in for by ../build-harness.ts. Nothing here ships.
//
// `Worker` is replaced by one that starts the bundled script the test hands over as `window.workerScripts`.

import { createRoot } from "react-dom/client";
import { capacitySetupFromModel } from "@transpera-flow/db";
import { calendarMonthStarts } from "@transpera-flow/db/sandbox";
import { capacityModel } from "@transpera-flow/engine";
import { CapacityView } from "@/components/capacity/capacity-view";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    mountCapacity: (options?: { payHidden?: boolean; noTiers?: boolean; missingWords?: boolean; badModel?: boolean }) => void;
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

window.mountCapacity = ({ payHidden, noTiers, missingWords, badModel } = {}) => {
  const model = capacityModel();
  const setup = capacitySetupFromModel(model, { payHidden });
  if (noTiers) setup.services = [];
  if (missingWords) setup.services[0]!.words = null;
  if (badModel) model.changes![0]!.adoption = 3;
  // Every servicing step belongs to its process, which the page links to.
  const stepProcess: Record<string, string> = {};
  for (const [pid, proc] of Object.entries(model.servicingProcesses ?? {})) for (const s of proc.steps) stepProcess[s] = pid;
  const start = "2026-11-02";
  createRoot(document.getElementById("root")!).render(
    <div className="p-4">
      <CapacityView setup={setup} model={model} year={{ model, monthStarts: calendarMonthStarts(start, model.horizonWeeks, model.hoursPerWeek) }} base="/w/example" stepProcess={stepProcess} startDate={start} />
    </div>,
  );
};
