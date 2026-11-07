// A block's steps with their work split (Q15 moved this out of the library list so a test can render it without the library's
// server actions).

import { isGroup } from "@transpera-flow/db";
import { SplitBar, SplitLegend } from "@/components/split-bar";
import type { readBlock } from "@/lib/blocks/blocks";

/** Each step of a block with its work split, tier multipliers and whether it goes to the client's manager: the base values a block carries. */
export function BlockSteps({ block }: { block: ReturnType<typeof readBlock> }) {
  const steps = block.steps.filter((s) => !isGroup(s));
  if (!steps.length) return null;
  const withSplit = steps.some((s) => s.split);
  return (
    <div className="flex flex-col gap-1.5" data-block-steps>
      <ul className="flex flex-col gap-1.5">
        {steps.map((s) => (
          <li key={s.id} className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-x-3 text-xs" data-block-step>
            <span className="min-w-0 truncate">
              {s.name}
              {s.to_client_manager && <span className="ml-1.5 text-fg-2">· the client&apos;s manager</span>}
              {s.tier_multiplier && Object.keys(s.tier_multiplier).length > 0 && (
                <span className="ml-1.5 text-fg-2">· {Object.entries(s.tier_multiplier).map(([k, v]) => `${k} ×${v}`).join(", ")}</span>
              )}
            </span>
            {s.split ? <SplitBar split={s.split} /> : <span className="text-fg-2">No split</span>}
          </li>
        ))}
      </ul>
      {withSplit && <SplitLegend />}
    </div>
  );
}
