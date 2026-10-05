import { CalibrationPanel } from "@/components/calibration/calibration-panel";
import { Page } from "@/components/shell/page";
import { calibrationRows } from "@/lib/calibration/rows";
import { northbeamSampleLog } from "@/lib/calibration/sample";
import { demoBundle } from "@/lib/sources/demo";

/** Settings → Historical data on the demo: Northbeam's pipeline with a sample log to read. Nothing is saved. */
export default function DemoCalibrationPage() {
  const bundle = demoBundle();
  return (
    <Page
      title="Historical data"
      eyebrow="Company"
      description="Demo mode: read the sample log against Northbeam's pipeline and see what it would change. Nothing is saved."
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
    </Page>
  );
}
