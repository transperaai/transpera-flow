import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One row of a list inside a section card (a published version, a saved item): a title with pills beside it, one muted line under it
 * and a line of text, and the row's buttons at the right. Rows sit on a soft tint, like the rows of "Solutions tried" on the Issue page.
 */
export function ListRow({
  title,
  pills,
  meta,
  children,
  actions,
  className,
  ...rest
}: {
  title: ReactNode;
  /** Pills after the title (a `StatusPill`). */
  pills?: ReactNode;
  /** The muted line under the title ("29 Sep 2026 · Maya Collins"). */
  meta?: ReactNode;
  /** The row's main text. */
  children?: ReactNode;
  /** The buttons at the right, as one group. */
  actions?: ReactNode;
  className?: string;
} & Record<`data-${string}`, string | number | boolean | undefined>) {
  return (
    <li className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-lg bg-muted/40 px-4 py-3", className)} {...rest}>
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">{title}</span>
          {pills}
        </div>
        {meta && <div className="text-xs text-fg-2">{meta}</div>}
        {children && <div className="text-sm" data-row-text>{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </li>
  );
}
