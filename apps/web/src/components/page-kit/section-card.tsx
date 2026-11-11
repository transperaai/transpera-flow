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
  level = 2,
  ...rest
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
  /** The title's heading level: 2 by default; 3 for a card inside a page section that has its own heading. */
  level?: 2 | 3;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <Card id={id} data-section={section} className={cn("scroll-mt-16 gap-3", className)} aria-labelledby={`${id}-heading`} {...rest}>
      <CardHeader>
        <CardTitle id={`${id}-heading`} role="heading" aria-level={level} className="font-display text-sm font-semibold">
          {title}
        </CardTitle>
        {description && <CardDescription className="text-xs" {...descriptionProps}>{description}</CardDescription>}
        {action && <CardAction className={actionClassName} data-edit-entry={actionIsEdit ? "" : undefined}>{action}</CardAction>}
      </CardHeader>
      <CardContent className={cn("flex flex-col gap-3", contentClassName)}>{children}</CardContent>
    </Card>
  );
}
