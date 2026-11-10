import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The look of a pill in a page header's row of pills: a little roomier than the pills on a card of the company map. */
export const HEADER_PILL = "px-2.5 py-0.5 text-xs leading-4";

/**
 * A page's header: the title (the page's one h1) at the left with a row of pills and one muted meta line under it, and a button group at
 * the right. Every page starts with it (the plain `Page` header is a thin wrapper), so every page starts the same way. It sits flat on the
 * page, not in a card (docs/plans/ui-cleanup.md).
 */
export function PageHeader({
  title,
  pills,
  meta,
  below,
  actions,
  actionsLabel,
  eyebrow,
  label,
  testId,
  className,
}: {
  title: ReactNode;
  /** The row of pills under the title (a `TagPill`, a `StatusPill`, an edit pencil). */
  pills?: ReactNode;
  /** The muted line under the pills: a `MetaLine`. */
  meta?: ReactNode;
  /** Anything else under the meta line (the processes inside this one). */
  below?: ReactNode;
  /** The button group at the right. */
  actions?: ReactNode;
  /** What the button group is called to a screen reader. */
  actionsLabel?: string;
  /** A small line above the title, such as a breadcrumb. */
  eyebrow?: ReactNode;
  /** What the card is called to a screen reader. */
  label: string;
  testId?: string;
  className?: string;
}) {
  return (
    <div data-testid={testId} data-page-header role="region" aria-label={label} className={cn("flex flex-wrap items-start justify-between gap-x-6 gap-y-3", className)}>
      <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1.5">
        {eyebrow}
        <h1 className="font-display text-xl leading-tight font-semibold tracking-tight break-words">{title}</h1>
        {pills && <div className="flex flex-wrap items-center gap-1.5">{pills}</div>}
        {meta}
        {below}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={actionsLabel ?? "Page actions"} data-page-actions>
          {actions}
        </div>
      )}
    </div>
  );
}
