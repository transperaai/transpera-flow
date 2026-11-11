"use client";

// The two maps of the Solution page (Q12, D44): the live map above this solution's map, read-only. They open and close their groups
// together, open on what changed, and mark new or changed steps on the solution's map. No numbers are worked out here.

import dynamic from "next/dynamic";
import { useState } from "react";
import { MapSkeleton } from "@/components/map/map-placeholder";
import { SectionCard } from "@/components/page-kit";
import type { Comparison } from "@/lib/solutions/compare";

// The map is heavy: load it once the page has drawn.
const ProcessCanvas = dynamic(() => import("@/components/process-canvas").then((m) => m.ProcessCanvas), {
  ssr: false,
  loading: () => <MapSkeleton height={416} />,
});

export function SolutionMaps({ comparison, notes }: { comparison: Comparison; notes: string[] }) {
  // One set of open groups for both maps: open or close a group on either and it follows on the other.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(comparison.open);
  return (
    <SectionCard id="maps" section="maps" title="Live and this solution" description="The two maps open and close together. New or changed steps are marked on the solution's map.">
      <div className="flex flex-col gap-1">
        <p className="text-xs text-fg-2" data-diff-key>
          <span aria-hidden className="mr-1 inline-block h-2.5 w-4 border border-dashed border-edit align-middle" />
          new or changed · <s>removed</s>. The maps open on what changed; Fit shows the whole process.
        </p>
        {notes.map((n) => (
          <p key={n} className="text-xs text-fg-2" data-compare-note>
            {n}
          </p>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-4" data-maps>
        {(
          [
            ["live", "Live", comparison.base, null],
            ["solution", "With this solution", comparison.solved, comparison.diff],
          ] as const
        ).map(([id, title, bundle, diff]) => (
          <div key={id} className="flex min-w-0 flex-col gap-1" data-map-side={id}>
            <h3 className="text-sm font-semibold">{title}</h3>
            <div className="flex h-[55svh] min-h-[26rem] min-w-0 flex-col overflow-hidden rounded-token border bg-card">
              <ProcessCanvas
                bundle={bundle}
                diff={diff}
                expanded={expanded}
                onExpandedChange={setExpanded}
                showPlayback={false}
                showLanes={false}
                legend={false}
                diffLegend={false}
                focus={comparison.changed}
                height="fill"
                stepDetail={false}
                branchNodes
              />
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
