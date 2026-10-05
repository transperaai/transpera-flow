import { notFound } from "next/navigation";
import { northbeamIssues, processesOf } from "@transpera-flow/db";
import { HistoryPage } from "@/components/history/history-page";
import { ProcessNav } from "@/components/process-nav";
import { demoHistory } from "@/lib/history/demo";
import { processRatings } from "@/lib/processes/rows";
import { demoBundle } from "@/lib/sources/demo";
import { demoDuplicate, demoRestore } from "./actions";

/**
 * A Northbeam process's History on the demo, no database needed (issue #105). The sample has one revision, so
 * the earlier versions are made from it (lib/history/demo.ts). Restore and Duplicate are shown and explain that
 * nothing is kept here.
 */
export default async function DemoHistoryPage(props: PageProps<"/demo/p/[processId]/history">) {
  const { processId } = await props.params;
  const history = demoHistory(processId);
  if (!history) notFound();
  const pipeline = demoBundle();
  const processes = processesOf(pipeline).map((p) => ({ id: p.id, name: p.name, kind: p.kind, live: true, draft: false, parentId: p.parent_process_id }));
  const steps = [...pipeline.steps, ...(pipeline.otherProcesses ?? []).flatMap((p) => p.steps)];
  return (
    <HistoryPage
      nav={
        <ProcessNav
          processes={processes}
          current={processId}
          hrefs={Object.fromEntries(processes.map((p) => [p.id, `/demo/p/${p.id}/history`]))}
          ratings={processRatings(processes, northbeamIssues(), steps)}
          processesHref="/demo/processes"
          companyMapHref="/demo"
        />
      }
      processName={history.processName}
      versions={history.versions}
      viewBase={`/demo/p/${processId}`}
      actions={{ restore: demoRestore, duplicate: demoDuplicate }}
      links={{ edit: `/demo/edit?process=${processId}`, newProcessEdit: "/demo/edit" }}
      note="Demo mode: sample data. The earlier versions are made up from the sample, and nothing here is kept."
    />
  );
}
