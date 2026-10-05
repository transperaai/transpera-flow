"use client";

import Link from "next/link";
import { useState } from "react";
import { DuplicateDialog, RestoreDialog, type VersionActions, type VersionLinks } from "@/components/history/version-dialogs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { authorLabel, describeChanges, formatPublished, type VersionMeta } from "@/lib/history/versions";

/**
 * A process's History screen: a plain list of its published versions, newest first: who published each, when, and what
 * changed. No simulated numbers. View opens the process page at that version, read only; editors also get Restore and Duplicate.
 */
export function HistoryView({
  processName,
  versions,
  viewBase,
  actions,
  links,
  note,
}: {
  processName: string;
  /** Newest first. */
  versions: VersionMeta[];
  /** The process page; View adds `?version=N`. */
  viewBase: string;
  /** Restore and Duplicate; omitted for people who can't edit, who then see neither. */
  actions?: VersionActions;
  links: VersionLinks;
  /** A line under the table, such as the demo's reminder that nothing is kept. */
  note?: string;
}) {
  const [dialog, setDialog] = useState<{ kind: "restore" | "duplicate"; version: VersionMeta } | null>(null);
  const firstNumber = Math.min(...versions.map((v) => v.number));

  if (versions.length === 0) {
    return (
      <p className="rounded-token border border-dashed border-line p-6 text-sm text-muted-foreground">
        {processName} hasn&apos;t been published yet, so it has no history. Publish its first version from the Editor.
      </p>
    );
  }

  return (
    <>
      <p className="max-w-prose text-sm text-muted-foreground">
        Every published version, with who published it and what changed. {actions ? "Restore one, or duplicate it as a new process." : "Open one to see how it looked."}
      </p>

      <div className="relative overflow-x-auto rounded-token border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium whitespace-nowrap">Version</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">Published</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">By</th>
              <th className="px-3 py-2 font-medium">What changed</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => {
              return (
                <tr key={v.revisionId} data-version={v.number} className="border-b align-top last:border-0">
                  <td className="px-3 py-2.5 font-mono whitespace-nowrap">
                    v{v.number}
                    {v.live && (
                      <Badge variant="outline" className="ml-2 border-accent bg-accent-soft font-sans text-fg">
                        Live
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs whitespace-nowrap">{formatPublished(v.publishedAt)}</td>
                  <td className="px-3 py-2.5 text-xs">{authorLabel(v)}</td>
                  <td className="min-w-48 px-3 py-2.5">{describeChanges(v.changes, v.number === firstNumber)}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {!v.live && (
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`${viewBase}?version=${v.number}`}>View</Link>
                        </Button>
                      )}
                      {actions && !v.live && (
                        <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "restore", version: v })}>
                          Restore
                        </Button>
                      )}
                      {actions && (
                        <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "duplicate", version: v })}>
                          Duplicate
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}

      {actions && dialog?.kind === "restore" && (
        <RestoreDialog
          version={dialog.version.number}
          processName={processName}
          revisionId={dialog.version.revisionId}
          restore={actions.restore}
          links={links}
          onClose={() => setDialog(null)}
        />
      )}
      {actions && dialog?.kind === "duplicate" && (
        <DuplicateDialog
          version={dialog.version.number}
          processName={processName}
          revisionId={dialog.version.revisionId}
          duplicate={actions.duplicate}
          links={links}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
