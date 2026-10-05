import { notFound } from "next/navigation";
import { emptyFirstPrinciples, isBlank } from "@transpera-flow/engine";
import { aiConfigured, loadAiViews } from "@/lib/ai/data";
import { isUnpublished } from "@transpera-flow/db";
import { createProcess } from "@/app/w/[slug]/process-actions";
import { WorkspaceFirstPrinciplesFlow } from "@/components/first-principles/flow-clients";
import type { FlowEditing } from "@/components/first-principles/first-principles-flow";
import { ProcessNav } from "@/components/process-nav";
import { canEditWorkspace } from "@/lib/access-data";
import { loadProcessForEditing, loadWorkspaceIssues } from "@/lib/data";
import { loadProcessFirstPrinciples } from "@/lib/first-principles/data";
import { processRatings } from "@/lib/processes/rows";

/**
 * A process's first-principles flow at `/w/[slug]/p/[processId]/first-principles` (issue #119, A54). Answers belong to
 * a version of the process and are always written to its draft: the page edits the draft if one is open, otherwise it
 * starts from the live version's answers and the first save opens a draft. Viewers read the live version's.
 */
export async function WorkspaceFirstPrinciplesPage({ slug, processId }: { slug: string; processId: string }) {
  const process = await loadProcessForEditing(slug, processId);
  if (!process) notFound();
  const { live, draft, processes } = process;
  const canEdit = await canEditWorkspace(live.workspace.id);
  const unpublished = isUnpublished(live);
  // Editors work on the draft when there is one; everyone else reads live. A process never published has only its draft.
  const bundle = unpublished ? (draft ?? live) : canEdit && draft ? draft : live;
  const fps = await loadProcessFirstPrinciples(live.process.id, [...new Set([bundle.revision.id, live.revision.id])]);
  const stored = fps[bundle.revision.id]!;
  // What AI wrote about the live version (A46): it reviews the published answers, not the draft being typed.
  const aiViews = unpublished ? {} : await loadAiViews([live.revision.id]);
  const liveFp = fps[live.revision.id]!.doc;
  const hasDraft = bundle === draft;

  const editing: FlowEditing = !canEdit
    ? { kind: "readonly" }
    : hasDraft
      ? unpublished
        ? { kind: "first-draft", number: bundle.revision.number }
        : { kind: "draft", number: bundle.revision.number }
      : { kind: "opens-draft", liveNumber: live.revision.number };

  const base = `/w/${slug}`;
  const [issues] = await Promise.all([loadWorkspaceIssues(live.workspace.id)]);
  const hrefs = Object.fromEntries(processes.map((p) => [p.id, `${base}/p/${p.id}`]));
  const ratings = processRatings(processes, issues, [...live.steps, ...(live.otherProcesses ?? []).flatMap((p) => p.steps)]);
  return (
    <WorkspaceFirstPrinciplesFlow
      key={`${live.process.id}:${bundle.revision.id}`}
      workspaceId={live.workspace.id}
      processId={live.process.id}
      bundle={bundle}
      initial={stored.doc ?? emptyFirstPrinciples()}
      // A draft with no row of its own yet starts from the answers before it, and its first save inserts one.
      base={{ version: stored.version, revisionId: hasDraft ? bundle.revision.id : null }}
      canEdit={canEdit}
      editing={editing}
      processHref={`${base}/p/${live.process.id}`}
      processesHref={`${base}/processes`}
      peopleHref={`${base}/people`}
      ai={{
        mode: canEdit ? "live" : "readonly",
        data: { view: aiViews[live.revision.id] ?? null, configured: aiConfigured(), hasFirstPrinciples: liveFp !== null && !isBlank(liveFp), versionNumber: unpublished ? null : live.revision.number },
        canRun: canEdit && !unpublished,
      }}
      processPicker={
        <ProcessNav
          processes={processes}
          current={live.process.id}
          hrefs={hrefs}
          create={canEdit ? createProcess.bind(null, live.workspace.id, slug) : undefined}
          ratings={ratings}
          processesHref={`${base}/processes`}
          companyMapHref={base}
        />
      }
    />
  );
}
