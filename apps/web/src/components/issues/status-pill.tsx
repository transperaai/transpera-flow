import type { IssueStatus } from "@transpera-flow/db";
import { statusLabel } from "@/lib/issues/pages";
import { cn } from "@/lib/utils";

/** The theme token each status is drawn in: its own colour, so a list reads at a glance. */
export const STATUS_TONE: Record<IssueStatus, string> = {
  open: "auto",
  testing: "warn",
  resolved: "good",
  wont_fix: "fg-3",
  dismissed: "line-2",
};

/**
 * An issue's status as a pill: a dot in the status's colour on a soft tint of it, with the words in the normal text colour so it reads in
 * light and dark. The one pill the Issues list, the Issue page and the Solution page share.
 */
export function StatusPill({ status, className }: { status: IssueStatus; className?: string }) {
  const tone = STATUS_TONE[status];
  return (
    <span
      data-status={status}
      className={cn("inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap text-foreground", className)}
      style={{ background: `color-mix(in srgb, var(--${tone}) 18%, transparent)` }}
    >
      <i aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: `var(--${tone})` }} />
      {statusLabel(status)}
    </span>
  );
}
