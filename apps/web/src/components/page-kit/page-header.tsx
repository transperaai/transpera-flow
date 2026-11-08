import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

/** The look of a pill in a page header's row of pills: a little roomier than the pills on a card of the company map. */
export const HEADER_PILL = "px-2.5 py-0.5 text-xs leading-4";

/**
 * A page's header card: the title (the page's one h1) at the left with a row of pills and one muted meta line under it, and a button
 * group at the right. The process page and the Issue and Solution pages share it, so every page starts the same way.
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
    <Card data-testid={testId} data-page-header role="region" aria-label={label} className={className}>
      <CardContent className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          {eyebrow}
          <h1 className="font-display text-2xl leading-tight font-bold break-words">{title}</h1>
          {pills && <div className="flex flex-wrap items-center gap-1.5">{pills}</div>}
          {meta}
          {below}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={actionsLabel ?? "Page actions"} data-page-actions>
            {actions}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
