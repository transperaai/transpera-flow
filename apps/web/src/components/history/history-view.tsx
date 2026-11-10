"use client";

import Link from "next/link";
import { History } from "lucide-react";
import { useState } from "react";
import { DuplicateDialog, RestoreDialog, type VersionActions, type VersionLinks } from "@/components/history/version-dialogs";
import { VersionBrowser } from "@/components/history/version-browser";
import { EmptyState } from "@/components/page-kit";
import { Button } from "@/components/ui/button";
import { describeChanges, type VersionMeta } from "@/lib/history/versions";
import { EDIT_ONLY } from "@/lib/phone";

/**
 * A process's History screen: its published versions, newest first, on the left (who published each, when, and what changed), and the
 * chosen one on the right with its buttons. No simulated numbers. View opens the process page at that version, read only; editors also
 * get Restore and Duplicate.
 */
export function HistoryView({
  processName,
  versions,
  viewBase,
  actions,
  links,
  note,
  initialVersion,
}: {
  processName: string;
  /** Newest first. */
  versions: VersionMeta[];
  /** The process page; View adds `?version=N`. */
  viewBase: string;
  /** Restore and Duplicate; omitted for people who can't edit, who then see neither. */
  actions?: VersionActions;
  links: VersionLinks;
  /** A line under the chosen version, such as the demo's reminder that nothing is kept. */
  note?: string;
  /** The version chosen to start with; the newest by default. */
  initialVersion?: number;
}) {
  const [dialog, setDialog] = useState<{ kind: "restore" | "duplicate"; version: VersionMeta } | null>(null);
  const firstNumber = Math.min(...versions.map((v) => v.number));

  if (versions.length === 0) {
    return (
      <EmptyState icon={History} data-empty="versions" className="ring-1 ring-foreground/10">
        {processName} hasn&apos;t been published yet, so it has no history. Publish its first version from the Editor.
      </EmptyState>
    );
  }

  return (
    <>
      <VersionBrowser
        versions={versions}
        initialVersion={initialVersion}
        note={note}
        description={`Every published version, with who published it and what changed. ${actions ? "Restore one, or duplicate it as a new process." : "Open one to see how it looked."}`}
        summary={(v) => describeChanges(v.changes, v.number === firstNumber)}
        actions={(v) => (
          <>
            {v.live && <span className="text-sm text-fg-2">The process page shows this version.</span>}
            {!v.live && (
              <Button variant="outline" asChild>
                <Link href={`${viewBase}?version=${v.number}`}>View</Link>
              </Button>
            )}
            {actions && !v.live && (
              <Button variant="outline" className={EDIT_ONLY} data-edit-entry onClick={() => setDialog({ kind: "restore", version: v })}>
                Restore
              </Button>
            )}
            {actions && (
              <Button variant="outline" className={EDIT_ONLY} data-edit-entry onClick={() => setDialog({ kind: "duplicate", version: v })}>
                Duplicate
              </Button>
            )}
          </>
        )}
      />

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
