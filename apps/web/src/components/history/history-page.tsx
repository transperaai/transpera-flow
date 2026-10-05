import type { ReactNode } from "react";
import { CompanyHistoryView } from "@/components/history/company-history-view";
import { HistoryView } from "@/components/history/history-view";
import type { VersionActions, VersionLinks } from "@/components/history/version-dialogs";
import { ShellHeader } from "@/components/shell/shell-header";
import type { VersionMeta } from "@/lib/history/versions";

/**
 * The frame of a process's History screen (issue #105), shared by the workspace and the demo: the process
 * switcher with its breadcrumbs, the page's name, then the list of versions.
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
  return (
    <div>
      <ShellHeader title={company ? "Company map history" : "Process history"} />
      <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-5 px-4 pt-6 pb-12 sm:px-6">
        <header className="flex flex-col gap-1">
          {nav}
          <h2 className="font-heading text-2xl leading-tight font-semibold tracking-tight">{company ? "Company map history" : "Process history"}</h2>
        </header>
        {company ? (
          <CompanyHistoryView versions={versions} actions={actions} links={links} note={note} />
        ) : (
        <HistoryView processName={processName} versions={versions} viewBase={viewBase} actions={actions} links={links} note={note} />
        )}
      </div>
    </div>
  );
}
