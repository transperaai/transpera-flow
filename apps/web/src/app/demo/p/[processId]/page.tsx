import { notFound } from "next/navigation";
import { bundleForProcess, northbeamIssues, northbeamScenarios, processesOf } from "@transpera-flow/db";
import { Info } from "lucide-react";
import { ProcessNav } from "@/components/process-nav";
import { ProcessPage } from "@/components/process-page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { demoAiView } from "@/lib/ai/demo";
import { processRatings, trailOf } from "@/lib/processes/rows";
import { DEMO_LIVE_VERSION, demoBundleAtVersion, demoHistory } from "@/lib/history/demo";
import { authorLabel } from "@/lib/history/versions";
import { demoProposals } from "@/lib/suggestions/demo";
import { parseVersion } from "@/lib/process-version";
import { withDemoGroups } from "@/lib/demo/nested";
import { demoBundle, demoSources } from "@/lib/sources/demo";

/**
 * One of the Northbeam sample's processes on the map, from the seed fixtures, no database needed (the Overview at
 * `/demo` links here, as does Processes). A servicing process (issue #19) simulates beside the pipeline.
 * `?nested=1` draws the pipeline with two groups of steps, to try opening and closing them (issue #102).
 */
export default async function DemoProcessPage(props: PageProps<"/demo/p/[processId]">) {
  const { processId } = await props.params;
  const { nested, version } = await props.searchParams;
  // Sources disagree on audit time (a conflict) and kickoff time is an assumption, so the checklist and the publish check can be tried.
  const pipeline = nested === "1" ? withDemoGroups(demoBundle()) : demoBundle();
  const live = bundleForProcess(pipeline, processId);
  if (!live) notFound();
  // `?version=N` shows an earlier version, read only (the earlier versions are made from the sample: lib/history/demo.ts).
  const earlier = parseVersion(version) ? demoBundleAtVersion(live, parseVersion(version)!) : null;
  const bundle = earlier ?? live;
  const processes = processesOf(pipeline).map((p) => ({ id: p.id, name: p.name, kind: p.kind, live: true, draft: false, parentId: p.parent_process_id }));
  const hrefs = Object.fromEntries(processes.map((p) => [p.id, `/demo/p/${p.id}`]));
  const byId = new Map(processes.map((p) => [p.id, { id: p.id, name: p.name, parentId: p.parentId }]));
  const latest = demoHistory(bundle.process.id)?.versions[0] ?? null;
  const ratings = processRatings(processes, northbeamIssues(), [...pipeline.steps, ...(pipeline.otherProcesses ?? []).flatMap((p) => p.steps)]);
  return (
    <ProcessPage
      key={bundle.process.id}
      bundle={bundle}
      viewingVersion={earlier ? earlier.revision.number : null}
      liveVersion={DEMO_LIVE_VERSION}
      mode={earlier ? "readonly" : "demo"}
      scenarios={northbeamScenarios()}
      issues={northbeamIssues()}
      sources={demoSources()}
      rating={ratings[bundle.process.id] ?? null}
      editHref={`/demo/edit?process=${bundle.process.id}${nested === "1" ? "&nested=1" : ""}`}
      historyHref={`/demo/p/${bundle.process.id}/history`}
      solutions={{ data: { solutions: [], links: [] }, base: "/demo" }}
      ideaIssueIds={demoProposals().flatMap((p) => (p.kind === "solution_idea" && p.status === "pending" && p.issue_id ? [p.issue_id] : []))}
      aboutInfo={{
        trail: trailOf({ id: bundle.process.id, parentId: bundle.process.parent_process_id }, byId).map((t) => t.name),
        hasDraft: false,
        lastChange: latest ? { at: latest.publishedAt, by: authorLabel(latest) } : null,
      }}
      firstPrinciples={{ doc: null, href: `/demo/p/${bundle.process.id}/first-principles` }}
      // Written in advance: the demo never calls an AI. Only the pipeline has text.
      ai={{ view: earlier ? null : demoAiView(bundle.process.id), configured: true, hasFirstPrinciples: true, versionNumber: earlier ? earlier.revision.number : DEMO_LIVE_VERSION }}
      inside={processes.filter((p) => p.parentId === bundle.process.id).map((p) => ({ id: p.id, name: p.name, href: hrefs[p.id]! }))}
      processPicker={<ProcessNav processes={processes} current={bundle.process.id} hrefs={hrefs} ratings={ratings} processesHref="/demo/processes" companyMapHref="/demo" />}
      notice={
        <Alert role="note">
          <Info />
          <AlertDescription className="text-xs leading-relaxed">
            <p>
              Demo mode: sample data from the seed fixtures, not a database. This page is for reading: press Open in Editor to change the
              process in a draft you can simulate against live, publish or discard. Log issues here to try them out.
              Everything stays in this tab and is gone when you reload.
            </p>
          </AlertDescription>
        </Alert>
      }
    />
  );
}
