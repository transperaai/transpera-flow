"use client";

// The Share links page's table (issue #32, B3): every link, newest first, and the two things an editor can do to one: update its
// copy to today's page, or turn it off. The link itself is never shown here (only its hash is stored); the copy of a page is never
// shown either, so the list holds no names or figures a toggle hides.

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { refreshShareLink, revokeShareLink, type ShareResult } from "@/app/w/[slug]/share-actions";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { STATUS_LABELS, ideasText, openedText, shareDate, showsFinancials, showsPeople, showsTryChanges, whoText } from "@/lib/share/format";
import type { ShareLinkRow } from "@/lib/share/list";
import { EDIT_ONLY } from "@/lib/phone";

/** The (i) texts: what each action does, in plain words, with an example. */
export const SHARE_LIST_HELP = {
  update: {
    label: "Update copy",
    description: "The link shows the page as it was when you made it. Update it to show today's version. The link stays the same.",
    example: "You fixed three issues since sharing the Overview: Update copy, and the same link shows them.",
  },
  ideas: {
    label: "Ideas",
    description: "How many ideas people have sent from a link that lets them try changes. They arrive in Suggestions, and nothing changes unless you build one.",
    example: "3 sent: open Suggestions to build or dismiss each one.",
  },
  off: {
    label: "Turn off",
    description: "Stops the link working for everyone, straight away. It can't be turned back on.",
    example: "Turn off the link you sent to a client who has finished: they see “This link has expired or been turned off.”",
  },
} as const;

export interface ShareLinksTableProps {
  slug: string;
  links: ShareLinkRow[];
  /** Update a link's copy. Defaults to the Server Action; a test passes its own. */
  refresh?: (id: string) => Promise<ShareResult>;
  /** Turn a link off. Defaults to the Server Action. */
  revoke?: (id: string) => Promise<ShareResult>;
}

export function ShareLinksTable({ slug, links, refresh, revoke }: ShareLinksTableProps) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const doRefresh = refresh ?? ((id: string) => refreshShareLink(slug, id));
  const doRevoke = revoke ?? ((id: string) => revokeShareLink(slug, id));

  const run = (id: string, work: (id: string) => Promise<ShareResult>, done: string) =>
    startTransition(async () => {
      setMessage(null);
      try {
        const r = await work(id);
        setMessage({ id, ok: r.status === "ok", text: r.status === "ok" ? done : r.message });
        if (r.status === "ok") router.refresh();
      } catch {
        setMessage({ id, ok: false, text: "Couldn't do that. Check your connection and try again." });
      }
      setConfirming(null);
    });

  if (links.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line p-6 text-sm text-fg-2" data-share-empty>
        Nothing shared yet. Use Share on the Overview, a process, an issue or a solution.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-good" : "text-sm text-destructive"} data-share-message>
          {message.text}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-line">
        <Table data-share-links>
          <TableHeader>
            <TableRow>
              <TableHead>What</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Shows</TableHead>
              <TableHead>
                <span className="inline-flex items-center">
                  Ideas
                  <Help {...SHARE_LIST_HELP.ideas} />
                </span>
              </TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Works until</TableHead>
              <TableHead>Opened</TableHead>
              <TableHead>Made by</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {links.map((l) => (
              <TableRow key={l.id} data-share-link={l.id} data-status={l.status}>
                <TableCell className="font-medium">{l.what ?? <span className="text-fg-3">(deleted)</span>}</TableCell>
                <TableCell>{l.label ?? <span className="text-fg-3">—</span>}</TableCell>
                <TableCell className="text-xs">
                  <span className="block">{showsPeople(l.showPeople)}</span>
                  <span className="block text-fg-2">{showsFinancials(l.showFinancials)}</span>
                  {l.mode === "play" && (
                    <span className="block font-medium" data-share-play>
                      {showsTryChanges}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs" data-share-ideas>
                  {l.ideas === null ? (
                    <span className="text-fg-3">—</span>
                  ) : (
                    <Link href={`/w/${slug}/suggestions`} className="underline">
                      {ideasText(l.ideas)}
                    </Link>
                  )}
                </TableCell>
                <TableCell title={l.emails.join(", ") || undefined}>{whoText(l.emails)}</TableCell>
                <TableCell>{l.expiresAt ? shareDate(l.expiresAt) : "No end date"}</TableCell>
                <TableCell className="text-xs">{openedText(l.opens, l.lastOpenedAt)}</TableCell>
                <TableCell>{l.madeBy}</TableCell>
                <TableCell>
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${l.status === "active" ? "border-good/50 bg-good/10" : "border-line bg-panel-2 text-fg-2"}`}
                    data-share-status
                  >
                    {STATUS_LABELS[l.status]}
                  </span>
                </TableCell>
                <TableCell>
                  {l.status === "off" ? null : (
                    <div className={`flex flex-wrap items-center justify-end gap-2 ${EDIT_ONLY}`} data-edit-entry>
                      <span className="inline-flex items-center">
                        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => run(l.id, doRefresh, "The copy is up to date.")} data-share-update>
                          Update copy
                        </Button>
                        <Help {...SHARE_LIST_HELP.update} />
                      </span>
                      <span className="inline-flex items-center">
                        {confirming === l.id ? (
                          <span className="inline-flex items-center gap-1.5" data-share-confirm>
                            <span className="text-xs">Turn it off for good?</span>
                            <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => run(l.id, doRevoke, "The link is turned off.")} data-share-off-yes>
                              Turn off
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(l.id)} data-share-off>
                            Turn off
                          </Button>
                        )}
                        <Help {...SHARE_LIST_HELP.off} />
                      </span>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
