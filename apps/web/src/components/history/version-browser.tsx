"use client";

import { useRef, useState, type ReactNode } from "react";
import { StatusPill } from "@/components/page-kit";
import { authorLabel, formatPublished, type VersionMeta } from "@/lib/history/versions";
import { cn } from "@/lib/utils";

/**
 * The History screens' master-detail (docs/plans/ui-cleanup.md, "DetailPage"): the versions on the left (about 360px), newest first, and the
 * chosen version on the right with what changed and its buttons. Below `lg` the two stack, and choosing a version scrolls to it.
 */
export function VersionBrowser({
  versions,
  summary,
  actions,
  heading,
  description,
  note,
  initialVersion,
}: {
  /** Newest first; at least one. */
  versions: VersionMeta[];
  /** What changed in a version, in words. */
  summary: (v: VersionMeta) => ReactNode;
  /** The chosen version's buttons (View, Restore, Duplicate). */
  actions: (v: VersionMeta) => ReactNode;
  /** The list's label, with an (i) where it has one. */
  heading?: ReactNode;
  /** One muted sentence under the label: what the list is and what can be done. */
  description?: ReactNode;
  /** A line under the chosen version, such as the demo's reminder that nothing is kept. */
  note?: string;
  /** The version chosen to start with; the newest by default. */
  initialVersion?: number;
}) {
  const [chosen, setChosen] = useState<number>(() => (versions.some((v) => v.number === initialVersion) ? initialVersion! : versions[0]!.number));
  const detail = useRef<HTMLElement>(null);
  const current = versions.find((v) => v.number === chosen) ?? versions[0]!;
  const choose = (n: number) => {
    setChosen(n);
    // Stacked (below lg), the chosen version sits under the list: bring it into view.
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 1023px)").matches) detail.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[22.5rem_minmax(0,1fr)]" data-history>
      <section id="versions" data-section="versions" aria-labelledby="versions-heading" className="flex min-w-0 flex-col gap-2">
        <h2 id="versions-heading" className="flex items-center text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
          {heading ?? "Versions"}
        </h2>
        {description && <p className="max-w-prose text-xs text-fg-2">{description}</p>}
        <ul aria-label="Versions" className="flex flex-col divide-y divide-line overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {versions.map((v) => {
            const on = v.number === current.number;
            return (
              <li key={v.revisionId} data-version={v.number}>
                <button
                  type="button"
                  aria-current={on ? "true" : undefined}
                  aria-controls="version-detail"
                  onClick={() => choose(v.number)}
                  className={cn(
                    "flex w-full min-w-0 flex-col gap-0.5 px-4 py-3 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    on && "bg-muted shadow-[inset_3px_0_0_var(--accent)] hover:bg-muted",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">v{v.number}</span>
                    {v.live && <StatusPill label="Live" tone="auto" />}
                    <span className="ml-auto text-xs text-fg-2">{formatPublished(v.publishedAt)}</span>
                  </span>
                  <span className="text-xs text-fg-2">{authorLabel(v)}</span>
                  <span className="truncate text-sm">{summary(v)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section
        ref={detail}
        id="version-detail"
        aria-labelledby="version-detail-heading"
        data-version-detail={current.number}
        className="flex min-w-0 scroll-mt-16 flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10 lg:sticky lg:top-16"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="version-detail-heading" className="flex items-center gap-2 text-base font-semibold">
              Version {current.number}
              {current.live && <StatusPill label="Live" tone="auto" />}
            </h2>
            <p className="text-sm text-fg-2">
              Published {formatPublished(current.publishedAt)} by {authorLabel(current)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Version ${current.number} actions`}>
            {actions(current)}
          </div>
        </div>
        <div className="flex flex-col gap-1 border-t border-line pt-4">
          <h3 className="text-sm font-semibold">What changed</h3>
          <p className="max-w-prose text-sm">{summary(current)}</p>
        </div>
        {note && <p className="text-xs text-fg-2">{note}</p>}
      </section>
    </div>
  );
}
