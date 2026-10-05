import Link from "next/link";
import { notFound } from "next/navigation";
import { HistoryPage } from "@/components/history/history-page";
import { ProcessNav } from "@/components/process-nav";
import { canEditWorkspace } from "@/lib/access-data";
import { isId } from "@/lib/editor/validate";
import { loadHistory } from "@/lib/history/data";
import { loadProcessesPage } from "@/lib/processes/data";
import { duplicateVersion, restoreVersion } from "./actions";

/**
 * A process's History (issue #105): every published version with who made it and what changed, and for editors Restore
 * and Duplicate. View opens the process page at that version, read only.
 */
export default async function ProcessHistoryPage(props: PageProps<"/w/[slug]/p/[processId]/history">) {
  const { slug, processId } = await props.params;
  if (!isId(processId)) notFound();
  const history = await loadHistory(slug, processId);
  if (!history) notFound();
  const { workspace, process, processes } = history;
  const [canEdit, rows] = await Promise.all([canEditWorkspace(workspace.id), loadProcessesPage(workspace.id)]);
  const base = `/w/${slug}`;
  const here = `${base}/p/${process.id}`;
  return (
    <HistoryPage
      company={history.company}
      nav={
        history.company ? (
          <nav aria-label="Breadcrumb" className="flex items-center gap-x-1 text-xs text-muted-foreground">
            <Link href={base} className="hover:text-accent hover:underline">
              Overview
            </Link>
            <span aria-hidden>/</span>
            <span className="font-medium text-fg">Company map</span>
          </nav>
        ) : (
        <ProcessNav
          processes={processes}
          current={process.id}
          hrefs={Object.fromEntries(processes.map((p) => [p.id, `${base}/p/${p.id}/history`]))}
          ratings={Object.fromEntries(rows.map((r) => [r.id, r.rating]))}
          processesHref={`${base}/processes`}
          companyMapHref={base}
        />
        )
      }
      processName={process.name}
      versions={history.versions}
      // The company map is drawn on the Overview; a process is shown on its own page.
      viewBase={history.company ? base : here}
      // An archived process is read only until it is restored (issue #182): the database refuses both anyway.
      actions={canEdit && !history.archived ? { restore: restoreVersion.bind(null, process.id), duplicate: duplicateVersion.bind(null, process.id) } : undefined}
      links={{ edit: `${here}/edit`, newProcessEdit: `${base}/p/{id}/edit` }}
    />
  );
}
