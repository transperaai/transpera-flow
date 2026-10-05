"use client";

// The light half of "+ Link" (issue #118, A53 slice 2): the context a page's source links live in, and the Sources block that reads it.
// Kept apart from the provider (./linking.tsx, which saves through Server Actions and opens the dialog) so a screen that only shows
// the block, such as the step detail on the map, doesn't pull the saving code into its bundle. Outside a provider the block draws nothing.

import { createContext, useContext } from "react";
import type { SourceLinkRow, SourceLinkTarget, SourceRow } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { targetValue } from "@/lib/sources/links";
import { SOURCE_KIND_LABELS } from "@/lib/sources/validate";

/** The (i) texts: what the Sources block and its "+ Link" mean. */
export const LINKED_SOURCES_HELP = {
  sources: {
    label: "Sources",
    description: "The interviews, notes and data that show this is real. A source linked here counts as evidence for it, and one source can be linked to many things.",
    example: "Interview: Maya Collins, “I review every single report before it goes out.”",
  },
  link: {
    label: "Link a source",
    description: "Link a source to this: add a new one, or pick one you have already added. Linking doesn't change what else the source is linked to.",
    example: "Link the notes from the ops walkthrough to the step Access requests.",
  },
} as const;

export interface SourceLinking {
  canEdit: boolean;
  sources: readonly SourceRow[];
  links: readonly SourceLinkRow[];
  /** The sources linked to a thing, with the link that says so. */
  linkedTo: (target: SourceLinkTarget) => { source: SourceRow; link: SourceLinkRow }[];
  /** Open the Add / Link source dialog for a thing. `label` is what it is called ("Step: Check fit"). */
  open: (target: SourceLinkTarget, label: string) => void;
  unlink: (link: SourceLinkRow) => Promise<void>;
  /**
   * The issue's own list of sources was just saved with these (the issue page's Edit dialog): bring the links in line, so the page
   * shows what the dialog saved. Live, the server has done it and the page is asked for again; in the demo the tab's store is updated.
   */
  syncIssue: (issueId: string, sourceIds: readonly string[]) => Promise<void>;
  error: string | null;
  busy: boolean;
}

export const SourceLinkingContext = createContext<SourceLinking | null>(null);

/** What a screen can do about sources, or null when it doesn't load them. */
export const useSourceLinking = () => useContext(SourceLinkingContext);

const excerpt = (body: string | null, n = 160) => {
  const text = (body ?? "").trim().replace(/\s+/g, " ");
  return text.length <= n ? text : `${text.slice(0, n).replace(/\s+\S*$/, "")}…`;
};

/**
 * The sources linked to one thing, as a block: "Sources" with its (i), a "+ Link" (and its (i)), and each source's title, type
 * and quote with a button to take the link away. Draws nothing outside a <SourceLinkingProvider>.
 */
export function LinkedSources({
  target,
  label,
  empty = "None linked yet.",
  linkText = "+ Link",
  heading = "Sources",
  hideTitle = false,
  help = true,
  className,
}: {
  target: SourceLinkTarget;
  /** What the thing is called, for the dialog ("Step: Check fit"). */
  label: string;
  empty?: string;
  /** The button's words ("+ Link a source" in the insight pop-up). */
  linkText?: string;
  heading?: string;
  /** The page already has a title for it (a section called Sources): show only the "+ Link". */
  hideTitle?: boolean;
  /** Show the (i)s by the heading and the link button. Default true. */
  help?: boolean;
  className?: string;
}) {
  const linking = useSourceLinking();
  if (!linking) return null;
  const items = linking.linkedTo(target);
  return (
    <section aria-label={heading} data-linked-sources={targetValue(target)} className={className ?? "flex flex-col gap-1.5"}>
      <div className={hideTitle ? "flex items-center justify-end gap-2" : "flex items-center justify-between gap-2"}>
        {!hideTitle && (
          <h4 className="flex items-center text-[11px] font-semibold tracking-wide text-fg-3 uppercase">
            {heading}
            {help && <Help {...LINKED_SOURCES_HELP.sources} />}
          </h4>
        )}
        {linking.canEdit && (
          <span className="flex items-center">
            <Button type="button" variant="ghost" size="sm" onClick={() => linking.open(target, label)} aria-label={`Link a source to ${label}`}>
              {linkText}
            </Button>
            {help && <Help {...LINKED_SOURCES_HELP.link} />}
          </span>
        )}
      </div>
      {items.length ? (
        <ul className="flex flex-col gap-1.5">
          {items.map(({ source, link }) => (
            <li key={link.id} className="flex items-start justify-between gap-2 text-xs">
              <span className="min-w-0">
                <b className="font-semibold">{source.title}</b> <span className="text-fg-3">· {SOURCE_KIND_LABELS[source.kind]}</span>
                {source.body && <span className="block text-fg-2">“{excerpt(source.body)}”</span>}
              </span>
              {linking.canEdit && (
                <button
                  type="button"
                  disabled={linking.busy}
                  aria-label={`Remove link: ${source.title}`}
                  className="-mr-1 grid size-5 shrink-0 place-items-center rounded-full text-fg-3 outline-none hover:bg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  onClick={() => void linking.unlink(link)}
                >
                  <span aria-hidden>×</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-fg-3">{empty}</p>
      )}
      {linking.error && (
        <p role="alert" className="text-xs text-crit">
          {linking.error}
        </p>
      )}
    </section>
  );
}
