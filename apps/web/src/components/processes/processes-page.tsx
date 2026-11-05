import Link from "next/link";
import { Network } from "lucide-react";
import { NewProcessButton, type CreateProcess } from "@/components/new-process-dialog";
import { ProcessesList } from "@/components/processes/processes-list";
import { UploadProcessButton, type UploadProcess } from "@/components/processes/upload-process-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { Page } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { EDIT_ONLY } from "@/lib/phone";
import type { ArchivedProcess, ProcessAdminOps } from "@/lib/processes/admin";
import type { ProcessCardData } from "@/lib/processes/data";
import type { ProcessRowData } from "@/lib/processes/rows";

/**
 * The Processes page (issue #101): the company map as a list, sub-processes indented under their parent. A row
 * opens in place to that process's map card. Replaces the A33 placeholder list. Editors rename, re-type, archive and
 * restore processes here (issue #182).
 */
export function ProcessesPage({
  rows,
  hrefs,
  companyMap,
  companyHistoryHref,
  loadCard,
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
      width="max-w-6xl"
      description="This workspace's own processes: the company map and everything inside it. Other workspaces have their own. Open a row to see that process's map card."
      actions={
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2" data-processes-actions>
          {(companyMap || companyHistoryHref) && (
            <div role="group" aria-label="Company map" className="inline-flex flex-wrap items-center gap-1 rounded-xl border bg-muted/30 p-0.5" data-company-map-group>
              {companyMap &&
                (companyMap.edit ? (
                  <Button asChild className={`bg-edit text-edit-fg hover:bg-edit/90 ${EDIT_ONLY}`} data-edit-entry data-edit-company-map>
                    <Link href={companyMap.href}>✎ Edit company map</Link>
                  </Button>
                ) : (
                  <>
                    <Button variant="outline" asChild>
                      <Link href={companyMap.href}>
                        <Network /> Company map
                      </Link>
                    </Button>
                    {companyMap.editHref && (
                      <Button asChild className={`bg-edit text-edit-fg hover:bg-edit/90 ${EDIT_ONLY}`} data-edit-entry data-edit-company-map>
                        <Link href={companyMap.editHref}>✎ Edit company map</Link>
                      </Button>
                    )}
                  </>
                ))}
              {companyHistoryHref && (
                <Button variant="outline" asChild>
                  <Link href={companyHistoryHref} data-company-history>
                    History
                  </Link>
                </Button>
              )}
            </div>
          )}
          {(upload || create) && (
            <div className="flex flex-wrap items-center gap-2" data-page-actions>
              {upload && <UploadProcessButton upload={upload} />}
              {create && <NewProcessButton create={create} />}
            </div>
          )}
        </div>
      }
    >
      <ProcessesList
        rows={rows}
        hrefs={hrefs}
        loadCard={loadCard}
        archived={archived}
        admin={admin}
        empty={
          create ? (
            <EmptyState
              data-processes-empty
              title="No processes yet."
              action={
                <>
                  <NewProcessButton create={create} />
                  {upload && <UploadProcessButton upload={upload} />}
                </>
              }
            >
              Start one with New process, or bring one in from a file.
            </EmptyState>
          ) : (
            <EmptyState data-processes-empty>No processes yet. An Agency admin adds them.</EmptyState>
          )
        }
      />
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </Page>
  );
}
