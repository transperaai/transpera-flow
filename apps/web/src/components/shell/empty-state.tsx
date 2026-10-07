import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A list, chart or map with nothing to show yet (issue #44): one sentence, and optionally what to do next. */
export function EmptyState({
  title,
  children,
  action,
  className,
  ...rest
}: {
  title?: string;
  children: ReactNode;
  /** What to do next (a link or a button), shown under the sentence. */
  action?: ReactNode;
  className?: string;
} & Omit<ComponentProps<"div">, "title">) {
  return (
    <div data-empty className={cn("rounded-token border border-dashed border-line p-6 text-sm text-muted-foreground", className)} {...rest}>
      {title && <p className="font-medium text-fg">{title}</p>}
      <div>{children}</div>
      {action && <div className="mt-3 flex gap-2">{action}</div>}
    </div>
  );
}
