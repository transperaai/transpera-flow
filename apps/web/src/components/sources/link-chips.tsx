"use client";

// A source's links as chips ("Step: Check fit", "Issue #12"), with "+ Link" and an unlink button on each when the viewer can
// edit (issue #118, A53). Reusable: the step detail, the issue, solution and process pages show a source the same way.

import type { LinkTargets, SourceLinkRow } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { linkLabel, linkTitle } from "@/lib/sources/links";
import { EDIT_ONLY } from "@/lib/phone";

/** The (i) texts for what a source's links and its warning mean. */
export const LINK_HELP = {
  linked: {
    label: "Linked to",
    description: "Everything this source is evidence for. Each chip is one link; remove a link with its ×, and add another with + Link.",
    example: "Step: Review monthly report, and Issue #12.",
  },
  unlinked: {
    label: "Not linked",
    description: "A source that isn't linked to anything can't be traced back from a step, an issue or a solution, so it doesn't count as evidence. Link it to what it supports.",
    example: "Notes from an ops walkthrough, linked to the Onboarding process.",
  },
} as const;

export function LinkChips({
  links,
  targets,
  onUnlink,
  disabled,
}: {
  links: readonly SourceLinkRow[];
  targets: LinkTargets;
  /** Given, each chip has a button that takes its link away. */
  onUnlink?: (link: SourceLinkRow) => void;
  disabled?: boolean;
}) {
  if (links.length === 0) return null;
  return (
    <ul aria-label="Linked to" className="flex flex-wrap gap-1.5">
      {links.map((l) => {
        const label = linkLabel(l, targets);
        return (
          <li key={l.id} data-link-kind={l.kind} title={linkTitle(l, targets)} className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-panel px-2.5 py-0.5 text-xs">
            <span className="truncate">{label}</span>
            {onUnlink && (
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove link: ${linkTitle(l, targets)}`}
                data-edit-entry
                className={`-mr-1 grid size-4 shrink-0 place-items-center rounded-full text-fg-3 outline-none hover:bg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${EDIT_ONLY}`}
                onClick={() => onUnlink(l)}
              >
                <span aria-hidden>×</span>
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The warning on a source that is linked to nothing (the prototype's words). */
export function UnlinkedWarning() {
  return (
    <p role="note" data-unlinked className="flex items-start gap-1 rounded-lg bg-warn-soft px-3 py-2 text-[13px]">
      <span>Not linked to anything yet. Link it, or it won&apos;t count as evidence.</span>
      <Help {...LINK_HELP.unlinked} />
    </p>
  );
}

/** The small label above a source's chips, with its (i). */
export function LinkedToLabel() {
  return (
    <span className="flex items-center text-xs font-medium text-fg-2">
      {LINK_HELP.linked.label}
      <Help {...LINK_HELP.linked} />
    </span>
  );
}
