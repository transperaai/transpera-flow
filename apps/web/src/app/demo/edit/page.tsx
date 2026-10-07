import { notFound } from "next/navigation";
import { bundleForProcess, northbeamIssues } from "@transpera-flow/db";
import { EditorPhoneGate } from "@/components/editor/editor-phone-gate";
import { EditorView } from "@/components/editor/editor-view";
import { withDemoGroups } from "@/lib/demo/nested";
import { exitHref, parseEditorMode, parseHorizon, parseIssueParam } from "@/lib/editor/modes";
import { issueAboutProcess, solutionIssueOf } from "@/lib/solutions/area";
import { demoBundle, demoSources } from "@/lib/sources/demo";
import { ideaSeed } from "@/lib/suggestions/idea";
import { demoProposals } from "@/lib/suggestions/demo";

/**
 * The Editor on the Northbeam sample, no database needed (issue #104). `?process=<id>` opens a servicing process and
 * `?nested=1` the sample with two groups, as the map does. Edits live in this tab only.
 */
export default async function DemoEditPage(props: PageProps<"/demo/edit">) {
  const search = await props.searchParams;
  const { process, nested } = search;
  const pipeline = nested === "1" ? withDemoGroups(demoBundle()) : demoBundle();
  const bundle = typeof process === "string" ? bundleForProcess(pipeline, process) : pipeline;
  if (!bundle) notFound();
  const editorMode = parseEditorMode(search.mode);
  const issueId = editorMode === "solution" ? parseIssueParam(search.issue) : null;
  const issueRow = issueId ? northbeamIssues().find((i) => i.id === issueId) : undefined;
  // "Build it" on a sample idea (A52): its steps are placed in the solution's copy.
  const ideaId = issueRow ? parseIssueParam(search.idea) : null;
  const ideaRow = ideaId ? demoProposals().find((p) => p.id === ideaId && p.kind === "solution_idea") : undefined;
  const idea = ideaRow && ideaRow.issue_id === issueRow?.id ? ideaSeed(ideaRow, bundle.roles) : null;
  const back = `/demo/p/${bundle.process.id}${nested === "1" ? "?nested=1" : ""}`;
  const exit = exitHref(search.from, back);
  return (
    <EditorPhoneGate backHref={exit}>
    <EditorView
      key={bundle.process.id}
      live={bundle}
      draft={null}
      mode="demo"
      editorMode={editorMode}
      idea={idea}
      issue={issueRow && issueAboutProcess(issueRow, bundle.process.id) ? solutionIssueOf(issueRow, bundle.process.id, bundle.steps) : null}
      sources={demoSources()}
      sourcesHref="/demo/sources"
      historyHref="/demo/history"
      exitHref={exit}
      horizonMonths={parseHorizon(search.horizon)}
    />
    </EditorPhoneGate>
  );
}
