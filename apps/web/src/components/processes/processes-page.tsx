import Link from "next/link";
import { Network, Workflow } from "lucide-react";
import { NewProcessButton, type CreateProcess } from "@/components/new-process-dialog";
import { ProcessesList } from "@/components/processes/processes-list";
import { UploadProcessButton, type UploadProcess } from "@/components/processes/upload-process-dialog";
import { EmptyState } from "@/components/page-kit";
import { EditMarker } from "@/components/processes/list-table";
import { Page } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { EDIT_ONLY } from "@/lib/phone";
import type { ArchivedProcess, ProcessAdminOps } from "@/lib/processes/admin";
import type { ProcessCardData } from "@/lib/processes/data";
import type { CompanyRowData, ProcessRowData } from "@/lib/processes/rows";

/**
 * The Processes page (issue #101; the ListPage of docs/plans/ui-cleanup.md): a header with New process as its one primary action
 * (Company map, History and Upload are outline buttons beside it), a toolbar, and one table with sub-processes indented under their
 * parent. A row opens in place to that process's map card. Editors rename, re-type, archive and restore processes here (issue #182).
 */
export function ProcessesPage({
  rows,
  hrefs,
  companyMap,
  companyHistoryHref,
  loadCard,
  companyRow,
  create,
  upload,
  archived,
  admin,
  note,
}: {
  rows: ProcessRowData[];
  hrefs: Record<string, string>;
  /**
   * The company map button. `edit` is the Editor, for a workspace with nothing published yet (there is nothing to read at the
   * Overview): editors only, and it changes things, so a phone doesn't show it. Omit it to show no button. `editHref` is the
   * Editor again, for editors once something is published: it sits beside the Company map button, to make a new version.
   */
  companyMap?: { href: string; edit: boolean; editHref?: string };
  /** The company map's History page: a button beside Company map. Omit it when the map has no published version. */
  companyHistoryHref?: string;
  loadCard: (processId: string) => Promise<ProcessCardData | null>;
  /** The company map's own row, pinned at the top of the table (Q16): its version, a draft pill, History, Edit and Open. */
  companyRow?: CompanyRowData;
  /** Start a process (signed-in editors only). */
  create?: CreateProcess;
  /** Bring in a process from a file (signed-in editors only; issue #166). */
  upload?: UploadProcess;
  /** The archived processes, for the Archived filter (issue #182). */
  archived?: ArchivedProcess[];
  /** Rename, change type, archive and restore (signed-in editors only; issue #182). */
  admin?: ProcessAdminOps;
  /** A line under the table, such as the demo's reminder that nothing is kept. */
  note?: string;
}) {
  return (
    <Page
      title="Processes"
      eyebrow="Company"
      description="This workspace's own processes: the company map and everything inside it. Open a row to see that process's map."
      actions={
        <div className="flex flex-wrap items-center gap-2" data-processes-actions>
          {(companyMap || companyHistoryHref) && (
            <div role="group" aria-label="Company map" className="flex flex-wrap items-center gap-2" data-company-map-group>
              {companyMap && !companyMap.edit && (
                <Button variant="outline" asChild>
                  <Link href={companyMap.href}>
                    <Network /> Company map
                  </Link>
                </Button>
              )}
              {companyMap && (companyMap.edit || companyMap.editHref) && (
                <Button variant="outline" asChild className={EDIT_ONLY} data-edit-entry data-edit-company-map>
                  <Link href={companyMap.edit ? companyMap.href : companyMap.editHref!}>
                    <EditMarker /> Edit company map
                  </Link>
                </Button>
              )}
              {companyHistoryHref && (
                <Button variant="outline" asChild>
                  <Link href={companyHistoryHref} data-company-history>
                    History
                  </Link>
                </Button>
              )}
            </div>
          )}
          {upload && <UploadProcessButton upload={upload} />}
          {create && <NewProcessButton create={create} />}
        </div>
      }
    >
      <ProcessesList
        rows={rows}
        hrefs={hrefs}
        loadCard={loadCard}
        company={companyRow}
        archived={archived}
        admin={admin}
        empty={
          <EmptyState
            icon={Workflow}
            data-processes-empty
            action={
              create ? (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {upload && <UploadProcessButton upload={upload} />}
                  <NewProcessButton create={create} />
                </div>
              ) : undefined
            }
          >
            {create ? "No processes yet. Start one with New process, or bring one in from a file." : "No processes yet. An Agency admin adds them."}
          </EmptyState>
        }
      />
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </Page>
  );
}
