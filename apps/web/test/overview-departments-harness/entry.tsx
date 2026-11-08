// The Overview's department figures (Money: the whole business and the department tiles; People: busiest people and where the time goes) on a bare page, for ../overview-departments-browser.test.ts: the real component with its simulation in
// a real Web Worker, fed with the engine fixture `capacityModel()` and the Set up data that agrees with it (made-up data; the example
// workspace is the same agency). Next's modules are stood in for by ../build-harness.ts. Nothing here ships.
//
// `Worker` is replaced by one that starts the bundled script the test hands over as `window.workerScripts`, and notes every message
// posted to it in `window.workerPosts` (one per run asked for).

import { createRoot, type Root } from "react-dom/client";
import { capacitySetupFromModel, type CapacitySetup } from "@transpera-flow/db";
import { capacityModel, type EngineModel } from "@transpera-flow/engine";
import { BusiestPeople } from "@/components/overview/busiest-people";
import { DepartmentAlerts, DepartmentTiles, StartChecklist, useDepartmentFigures, WholeBusinessHero } from "@/components/overview/department-cards";
import { WhereTimeGoes } from "@/components/overview/where-time-goes";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    workerPosts: string[];
    mountDepartments: (options?: { payHidden?: boolean; noTiers?: boolean; noSalaries?: boolean; dlerIncludesLeadership?: boolean }) => void;
    unmountDepartments: () => void;
  }
}

const NativeWorker = window.Worker;
window.workerPosts = [];
window.Worker = class extends NativeWorker {
  private readonly file: string;
  constructor(url: string | URL) {
    const file = String(url).split("/").pop()!;
    const script = window.workerScripts[file];
    if (!script) throw new Error(`No bundled worker for ${file}`);
    super(URL.createObjectURL(new Blob([script], { type: "text/javascript" })));
    this.file = file;
  }
  postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
    window.workerPosts.push(this.file);
    super.postMessage(message, options as StructuredSerializeOptions);
  }
} as typeof Worker;

let root: Root | null = null;

/** The pieces as the Overview lays them out in its Money and People sections. */
function Departments({ setup, model }: { setup: CapacitySetup; model: EngineModel }) {
  const figures = useDepartmentFigures({ setup, model });
  if (!figures.rows.length) return <StartChecklist setup={setup} base="/w/example" />;
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4" data-overview-section="money">
        <DepartmentAlerts failure={figures.failure} />
        <WholeBusinessHero setup={setup} base="/w/example" />
        <DepartmentTiles figures={figures} base="/w/example" currency={setup.currency} />
      </section>
      <section className="grid gap-6 lg:grid-cols-2" data-overview-section="people">
        <BusiestPeople people={figures.people} failed={!!figures.failure} capacityHref="/w/example/capacity" />
        <WhereTimeGoes rows={figures.rows} failed={!!figures.failure} />
      </section>
    </div>
  );
}

window.mountDepartments = ({ payHidden, noTiers, noSalaries, dlerIncludesLeadership } = {}) => {
  const model = capacityModel();
  const setup = capacitySetupFromModel(model, { payHidden, ...(dlerIncludesLeadership === undefined ? {} : { dlerIncludesLeadership }) });
  if (noTiers) setup.services = [];
  if (noSalaries) for (const p of setup.people) p.salary_monthly = null;
  root = createRoot(document.getElementById("root")!);
  root.render(
    <div className="p-4">
      <Departments setup={setup} model={model} />
    </div>,
  );
};
window.unmountDepartments = () => root?.unmount();
