"use client";

import Link from "next/link";
import { History } from "lucide-react";
import { useState } from "react";
import { Help } from "@/components/help";
import { RestoreDialog, type VersionActions, type VersionLinks } from "@/components/history/version-dialogs";
import { EmptyState, ListRow, SectionCard, StatusPill } from "@/components/page-kit";
import { Button } from "@/components/ui/button";
import { authorLabel, describeChanges, formatPublished, type VersionMeta } from "@/lib/history/versions";
import { EDIT_ONLY } from "@/lib/phone";

/**
 * The company map's History (B11): every published version of the map, newest first, with what changed and who made it.
 * The map is the business as a set of processes, not a process, so there are no simulated numbers here (the Sandbox simulates the company from it). A version made by the
 * system (a process was added, renamed or taken off the map) says so in words. Editors can restore a version into the
 * map's draft; it can't be duplicated (a copy of a map is not a process).
 */
export function CompanyHistoryView({
  versions,
  actions,
  links,
  note,
  viewBase,
}: {
  /** Where the company map is drawn (the Overview): View adds `?version=N`. Omitted: no View buttons. */
  viewBase?: string;
  /** Newest first. */
  versions: VersionMeta[];
  /** Restore; omitted for people who can't edit, who then see no buttons. */
  actions?: VersionActions;
  links: VersionLinks;
  note?: string;
}) {
  const [restoring, setRestoring] = useState<VersionMeta | null>(null);
  const firstNumber = Math.min(...versions.map((v) => v.number));
  if (versions.length === 0) {
    return (
      <SectionCard id="versions" section="versions" title="Versions">
        <EmptyState icon={History} data-empty="versions">
          The company map has no versions yet.
        </EmptyState>
      </SectionCard>
    );
  }
  return (
    <>
      <SectionCard
        id="versions"
        section="versions"
        title={
          <span className="flex items-center">
            Versions
            <Help
              label="Version"
              description="Each time you publish the Editor's draft of the company map it becomes the next version. Live is the one the Overview draws today. Older versions are kept."
              example="v4 · Live is the map people see; v3 is how it was before the last publish."
            />
          </span>
        }
        description={`Every published version of the company map. When someone adds, renames or removes a process, the map records a new version of its own, so this list says what happened. ${viewBase ? "View one to see how the map looked, read only." : ""} ${actions ? "Restore one to bring it back into your draft." : ""}`}
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
                viewBase || actions ? (
                  <>
                    {viewBase && !v.live && (
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`${viewBase}?version=${v.number}`}>View</Link>
                      </Button>
                    )}
                    {actions && !v.live && (
                      <Button variant="outline" size="sm" className={EDIT_ONLY} data-edit-entry onClick={() => setRestoring(v)}>
                        Restore
                      </Button>
                    )}
                  </>
                ) : undefined
              }
            >
              <span data-what-changed>{v.note ?? describeChanges(v.changes, v.number === firstNumber)}</span>
            </ListRow>
          ))}
        </ul>
      </SectionCard>
      {note && <p className="text-xs text-fg-2">{note}</p>}
      {actions && restoring && (
        <RestoreDialog
          version={restoring.number}
          processName="the company map"
          revisionId={restoring.revisionId}
          restore={actions.restore}
          links={links}
          onClose={() => setRestoring(null)}
        />
      )}
    </>
  );
}
