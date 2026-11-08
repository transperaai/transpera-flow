import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TimelineEntry {
  id: string;
  /** The icon for the kind of entry. */
  icon: LucideIcon;
  who: string;
  /** When, already worded ("5 Nov"). */
  when: string;
  /** One plain line: "Status: Open → Testing solutions". */
  text: ReactNode;
  /** What kind of entry, for a test or a style. */
  kind?: string;
}

/** A list of what happened, one entry per line with an icon for its kind, in the order given. */
export function Timeline({ entries, empty, className, ...rest }: { entries: readonly TimelineEntry[]; empty?: ReactNode; className?: string } & Record<`data-${string}`, string | undefined>) {
  if (!entries.length) return <p className="text-sm text-fg-2">{empty ?? "Nothing yet."}</p>;
  return (
    <ol className={cn("flex flex-col", className)} {...rest}>
      {entries.map((e, i) => (
        <li key={e.id} data-timeline-entry data-kind={e.kind} className="relative flex gap-3 pb-3 last:pb-0">
          {i < entries.length - 1 && <span aria-hidden className="absolute top-6 bottom-0 left-3 w-px bg-line" />}
          <span aria-hidden className="relative z-10 grid size-6 shrink-0 place-items-center rounded-full border border-line bg-panel text-fg-2">
            <e.icon className="size-3.5" />
          </span>
          <div className="flex min-w-0 flex-col text-sm">
            <span>{e.text}</span>
            <span className="text-xs text-fg-3">
              {e.who} · {e.when}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}
