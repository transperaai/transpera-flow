"use client";

import Link from "next/link";
import { History } from "lucide-react";
import { useState } from "react";
import { DuplicateDialog, RestoreDialog, type VersionActions, type VersionLinks } from "@/components/history/version-dialogs";
import { EmptyState, ListRow, SectionCard, StatusPill } from "@/components/page-kit";
import { Button } from "@/components/ui/button";
import { authorLabel, describeChanges, formatPublished, type VersionMeta } from "@/lib/history/versions";
import { EDIT_ONLY } from "@/lib/phone";

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
      <SectionCard id="versions" section="versions" title="Versions">
        <EmptyState icon={History} data-empty="versions">
          {processName} hasn&apos;t been published yet, so it has no history. Publish its first version from the Editor.
        </EmptyState>
      </SectionCard>
    );
  }

  return (
    <>
      <SectionCard
        id="versions"
        section="versions"
        title="Versions"
        description={`Every published version, with who published it and what changed. ${actions ? "Restore one, or duplicate it as a new process." : "Open one to see how it looked."}`}
      >
        <ul className="flex flex-col gap-2" aria-label="Versions">
          {versions.map((v) => (
            <ListRow
              key={v.revisionId}
              data-version={v.number}
              title={<span className="font-mono">v{v.number}</span>}
              pills={v.live ? <StatusPill label="Live" tone="auto" /> : undefined}
              meta={
                <>
                  {formatPublished(v.publishedAt)} · {authorLabel(v)}
                </>
              }
              actions={
                <>
                  {!v.live && (
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`${viewBase}?version=${v.number}`}>View</Link>
                    </Button>
                  )}
                  {actions && !v.live && (
                    <Button variant="outline" size="sm" className={EDIT_ONLY} data-edit-entry onClick={() => setDialog({ kind: "restore", version: v })}>
                      Restore
                    </Button>
                  )}
                  {actions && (
                    <Button variant="outline" size="sm" className={EDIT_ONLY} data-edit-entry onClick={() => setDialog({ kind: "duplicate", version: v })}>
                      Duplicate
                    </Button>
                  )}
                </>
              }
            >
              {describeChanges(v.changes, v.number === firstNumber)}
            </ListRow>
          ))}
        </ul>
      </SectionCard>
      {note && <p className="text-xs text-fg-2">{note}</p>}

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
