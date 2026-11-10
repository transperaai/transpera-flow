import type { ReactNode } from "react";
import { CompanyHistoryView } from "@/components/history/company-history-view";
import { HistoryView } from "@/components/history/history-view";
import type { VersionActions, VersionLinks } from "@/components/history/version-dialogs";
import { MetaLine, PageHeader } from "@/components/page-kit";
import { pageBodyClass } from "@/components/shell/page";
import { ShellHeader } from "@/components/shell/shell-header";
import type { VersionMeta } from "@/lib/history/versions";

/**
 * The frame of a process's History screen (issue #105), shared by the workspace and the demo: the process switcher with its breadcrumbs
 * above the page's header, then the versions (a list on the left, the chosen version on the right), full width.
 */
export function HistoryPage({
  nav,
  processName,
  versions,
  viewBase,
  actions,
  links,
  note,
  company = false,
}: {
  /** The process switcher with its breadcrumbs. */
  nav: ReactNode;
  processName: string;
  versions: VersionMeta[];
  viewBase: string;
  actions?: VersionActions;
  links: VersionLinks;
  note?: string;
  /** The company map (B11): its versions are listed with what changed. */
  company?: boolean;
}) {
  const live = versions.find((v) => v.live);
  return (
    <div>
      <ShellHeader title={company ? "Company map history" : "Process history"} />
      <div className={pageBodyClass()}>
        <div className="flex min-w-0 flex-col gap-4">
          {nav}
          <PageHeader
            label={company ? "Company map history" : "Process history"}
            testId="history-header"
            title={company ? "Company map history" : `${processName} history`}
            meta={
              <MetaLine>
                <span data-versions-count>{versions.length === 1 ? "1 version" : `${versions.length} versions`}</span>
                {live ? <span>Live is version {live.number}</span> : ""}
              </MetaLine>
            }
          />
        </div>
        {company ? (
          <CompanyHistoryView versions={versions} actions={actions} links={links} note={note} viewBase={viewBase} />
        ) : (
          <HistoryView processName={processName} versions={versions} viewBase={viewBase} actions={actions} links={links} note={note} />
        )}
      </div>
    </div>
  );
}
