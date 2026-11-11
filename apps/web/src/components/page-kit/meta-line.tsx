import { Children, Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one muted line under a page's title ("4 steps · 2 roles · Version 3"; "Owner Karl · Created 5 Nov"). Children are the parts: empty
 * ones are left out and the rest are told apart by a middle dot. A single child (a sentence) is shown as it is.
 */
export function MetaLine({ children, className }: { children: ReactNode; className?: string }) {
  const parts = Children.toArray(children).filter((c) => c !== "");
  if (!parts.length) return null;
  return (
    <div data-meta-line className={cn("flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-fg-2", className)}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden>·</span>}
          {p}
        </Fragment>
      ))}
    </div>
  );
}
