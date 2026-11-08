import type { ReactNode } from "react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * A section of a page as a card: a title (with an optional description under it and buttons at the right) over the content. The id makes
 * it a target for a link (`#issues`) and names the card to a screen reader.
 */
export function SectionCard({
  id,
  title,
  description,
  descriptionProps,
  action,
  actionClassName,
  actionIsEdit,
  children,
  className,
  contentClassName,
  section,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  /** Attributes for the description (a test hook such as `data-issue-counts`). */
  descriptionProps?: Record<`data-${string}`, string>;
  /** Buttons at the right of the title. */
  action?: ReactNode;
  actionClassName?: string;
  /** The buttons change things: marks them `data-edit-entry` (hidden from readers and on a phone, by the page). */
  actionIsEdit?: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  /** The card's `data-section` (a test hook). */
  section?: string;
}) {
  return (
    <Card id={id} data-section={section} className={cn("scroll-mt-16", className)} aria-labelledby={`${id}-heading`}>
      <CardHeader>
        <CardTitle id={`${id}-heading`} role="heading" aria-level={2} className="font-display text-base font-bold">
          {title}
        </CardTitle>
        {description && <CardDescription {...descriptionProps}>{description}</CardDescription>}
        {action && <CardAction className={actionClassName} data-edit-entry={actionIsEdit ? "" : undefined}>{action}</CardAction>}
      </CardHeader>
      <CardContent className={cn("flex flex-col gap-4", contentClassName)}>{children}</CardContent>
    </Card>
  );
}
