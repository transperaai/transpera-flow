import { CalibrationPanel } from "@/components/calibration/calibration-panel";
import { ClientCalibrationPanel } from "@/components/calibration/client-calibration-panel";
import { ImportsHistory } from "@/components/calibration/imports-history";
import { OtherImportsPanel } from "@/components/calibration/other-imports-panel";
import { Page } from "@/components/shell/page";
import { importSamples } from "@/lib/calibration/import-samples";
import { calibrationRows } from "@/lib/calibration/rows";
import { clientCalibrationRows, simulationPlan } from "@/lib/calibration/client-rows";
import { SAMPLE_AS_OF } from "@/lib/calibration/client-sample";
import { demoBundle } from "@/lib/sources/demo";

/**
 * Settings → Historical data on the demo: Northbeam's pipeline with a sample stage history, deals and time logs to read, its clients
 * with a sample clients file and servicing log (or tickets), and sample leads and invoices. Nothing is saved.
 */
export default function DemoCalibrationPage() {
  const bundle = demoBundle();
  const processes = [bundle.process, ...(bundle.otherProcesses ?? []).map((p) => p.process)].map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
  const rows = clientCalibrationRows(bundle, processes);
  const runs = simulationPlan(rows, bundle.process.id).map((item) => ({ processId: item.processId, processName: bundle.process.name, serviceIds: item.serviceIds, bundle }));
  const samples = importSamples();
  const calibrationStored = calibrationRows(bundle, null);
  const leadSources = calibrationStored.leadSources.map((s) => ({ id: s.id, name: s.name, volumeWeek: Number(s.volume_week) }));
  return (
    <Page
      title="Historical data"
      eyebrow="Company"
      description="Demo mode: import the sample files, check them against Northbeam's model and see what they would change. Nothing is saved."
    >
      <CalibrationPanel
        personTimes={{ state: "hidden" }}
        mode="demo"
        workspaceId={null}
        base={null}
        processes={[{ id: bundle.process.id, name: bundle.process.name, kind: bundle.process.kind }]}
        process={{ id: bundle.process.id, name: bundle.process.name, kind: bundle.process.kind }}
        hasDraft={false}
        stored={calibrationStored}
        history={[]}
        previous={{}}
        sample={samples}
      />
      <ClientCalibrationPanel
        mode="demo"
        workspaceId={null}
        base={null}
        rows={rows}
        runs={runs}
        history={[]}
        defaultAsOf={SAMPLE_AS_OF}
        previous={{}}
        sample={samples}
      />
      <OtherImportsPanel mode="demo" workspaceId={null} leadSources={leadSources} previous={{}} sample={samples} asOf={Date.parse(SAMPLE_AS_OF) + 86_400_000 - 1} />
      <ImportsHistory imports={[]} leadSources={leadSources} />
    </Page>
  );
}
