import { CalibrationPanel } from "@/components/calibration/calibration-panel";
import { ClientCalibrationPanel } from "@/components/calibration/client-calibration-panel";
import { Page } from "@/components/shell/page";
import { calibrationRows } from "@/lib/calibration/rows";
import { clientCalibrationRows, simulationPlan } from "@/lib/calibration/client-rows";
import { SAMPLE_AS_OF, northbeamSampleClients, northbeamSampleServicingLog } from "@/lib/calibration/client-sample";
import { northbeamSampleLog } from "@/lib/calibration/sample";
import { demoBundle } from "@/lib/sources/demo";

/**
 * Settings → Historical data on the demo: Northbeam's pipeline with a sample step log to read, and its clients with a sample
 * clients file and servicing log. Nothing is saved.
 */
export default function DemoCalibrationPage() {
  const bundle = demoBundle();
  const processes = [bundle.process, ...(bundle.otherProcesses ?? []).map((p) => p.process)].map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
  const rows = clientCalibrationRows(bundle, processes);
  const runs = simulationPlan(rows, bundle.process.id).map((item) => ({ processId: item.processId, processName: bundle.process.name, serviceIds: item.serviceIds, bundle }));
  return (
    <Page
      title="Historical data"
      eyebrow="Company"
      description="Demo mode: read the sample files against Northbeam's model and see what they would change. Nothing is saved."
    >
      <CalibrationPanel
        mode="demo"
        workspaceId={null}
        base={null}
        processes={[{ id: bundle.process.id, name: bundle.process.name, kind: bundle.process.kind }]}
        process={{ id: bundle.process.id, name: bundle.process.name, kind: bundle.process.kind }}
        hasDraft={false}
        stored={calibrationRows(bundle, null)}
        history={[]}
        sample={{ name: "northbeam-pipeline-sample.csv", text: northbeamSampleLog() }}
      />
      <ClientCalibrationPanel
        mode="demo"
        workspaceId={null}
        base={null}
        rows={rows}
        runs={runs}
        history={[]}
        defaultAsOf={SAMPLE_AS_OF}
        sample={{
          clients: { name: "northbeam-clients-sample.csv", text: northbeamSampleClients() },
          log: { name: "northbeam-servicing-sample.csv", text: northbeamSampleServicingLog() },
        }}
      />
    </Page>
  );
}
