import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * What a card shows when it has nothing yet: an icon, one sentence saying what goes here, and the button that adds the first one.
 * (`components/shell/empty-state.tsx` is the dashed box for a whole list or chart; this one sits inside a section card.)
 */
export function EmptyState({
  icon: Icon,
  children,
  action,
  className,
  ...rest
}: { icon?: LucideIcon; children: ReactNode; action?: ReactNode; className?: string } & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <div className={cn("flex flex-col items-center gap-3 rounded-lg bg-muted/40 px-4 py-8 text-center", className)} {...rest}>
      {Icon && <Icon aria-hidden className="size-8 text-fg-3" />}
      <p className="max-w-md text-sm text-fg-2">{children}</p>
      {action}
    </div>
  );
}
