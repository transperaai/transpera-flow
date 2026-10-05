"use client";

import { useState } from "react";
import { Help } from "@/components/help";
import { RestoreDialog, type VersionActions, type VersionLinks } from "@/components/history/version-dialogs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { authorLabel, describeChanges, formatPublished, type VersionMeta } from "@/lib/history/versions";

/**
 * The company map's History (B11): every published version of the map, newest first, with what changed and who made it.
 * The map is a picture of the business, not a process, so there are no simulated numbers here. A version made by the
 * system (a process was added, renamed or taken off the map) says so in words. Editors can restore a version into the
 * map's draft; it can't be duplicated (a copy of a map is not a process).
 */
export function CompanyHistoryView({
  versions,
  actions,
  links,
  note,
}: {
  /** Newest first. */
  versions: VersionMeta[];
  /** Restore; omitted for people who can't edit, who then see no buttons. */
  actions?: VersionActions;
  links: VersionLinks;
  note?: string;
}) {
  const [restoring, setRestoring] = useState<VersionMeta | null>(null);
  const firstNumber = Math.min(...versions.map((v) => v.number));
  if (versions.length === 0) return <p className="rounded-token border border-dashed border-line p-6 text-sm text-muted-foreground">The company map has no versions yet.</p>;
  return (
    <>
      <p className="max-w-prose text-sm text-muted-foreground">
        Every published version of the company map. When someone adds, renames or removes a process, the map records a new version of its own, so this
        list says what happened. {actions ? "Restore one to bring it back into your draft." : ""}
      </p>
      <div className="relative overflow-x-auto rounded-token border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium whitespace-nowrap">
                Version
                <Help
                  label="Version"
                  description="Each time you publish the Editor's draft of the company map it becomes the next version. Live is the one the Overview draws today. Older versions are kept."
                  example="v4 · Live is the map people see; v3 is how it was before the last publish."
                />
              </th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">Published</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">By</th>
              <th className="px-3 py-2 font-medium">
                What changed
                <Help
                  label="What changed"
                  description="How the version differs from the one before it. A version made when a process was added, renamed or taken off the map says so; otherwise it counts the cards and handoff lines added, removed and changed. Moving a card is not counted."
                  example="“Added Delivery” is a new process on the map; “1 connection added” is a new handoff line."
                />
              </th>
              {actions && (
                <th className="px-3 py-2 font-medium whitespace-nowrap">
                  <span className="inline-flex items-center">
                    Restore
                    <Help
                      label="Restore"
                      description="Copies that version of the map into your draft so you can check it and publish it again. It does not touch the live map until you publish. Processes that were deleted or moved inside another since are left out; processes made since stay on the map."
                      example="Restore v2 after a tidy-up made the map worse, check it in the Editor, then publish it as v6."
                    />
                  </span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
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
                <td className="min-w-48 px-3 py-2.5" data-what-changed>
                  {v.note ?? describeChanges(v.changes, v.number === firstNumber)}
                </td>
                {actions && (
                  <td className="px-3 py-2.5">
                    {!v.live && (
                      <Button variant="outline" size="sm" onClick={() => setRestoring(v)}>
                        Restore
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
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
