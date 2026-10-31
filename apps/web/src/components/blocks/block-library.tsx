"use client";

// The Block library page (issue #116): a card for each saved block with how many solutions use it, its name and
// description and a small map of its steps. "✎ New block" opens the Editor in block mode. On the demo the blocks live in this
// tab (lib/blocks/demo.ts), so a block saved from the Editor shows here at once.

import Link from "next/link";
import { Layers } from "lucide-react";
import type { BlockRow } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Page } from "@/components/shell/page";
import { isGroup } from "@transpera-flow/db";
import { SplitBar, SplitLegend } from "@/components/split-bar";
import { blockStepCount, readBlock } from "@/lib/blocks/blocks";
import { useDemoBlocks } from "@/lib/blocks/demo";
import { cn } from "@/lib/utils";
import { BlockMap } from "./block-map";
import { EDIT_ONLY } from "@/lib/phone";

/** "Used in 2 solutions": the solutions whose map holds a group put in from this block (lib/blocks/usage.ts). */
export const usageText = (n: number) => `Used in ${n} ${n === 1 ? "solution" : "solutions"}`;

export function BlockLibrary({ blocks, mode, newHref, usage = {} }: { blocks: BlockRow[]; mode: "live" | "readonly" | "demo"; newHref: string | null; usage?: Record<string, number> }) {
  const demo = useDemoBlocks();
  const list = mode === "demo" ? demo : blocks;
  return (
    <Page
      title="Block library"
      eyebrow="Improve"
      description="Saved bundles of steps. Drop one into a solution, or into a process in the Editor."
      actions={
        newHref ? (
          <span className={`inline-flex items-center ${EDIT_ONLY}`} data-edit-entry>
            <Link href={newHref} className={cn(buttonVariants({ variant: "outline" }), "border-edit bg-edit text-edit-fg hover:bg-edit/90 hover:text-edit-fg dark:border-edit dark:bg-edit dark:hover:bg-edit/90")}>
              ✎ New block
            </Link>
            <Help
              label="New block"
              description="Opens the Editor on an empty map. Build a few steps, name the block, and save it to the library to reuse it."
              example="Build “Client sign-off” once (send the summary, chase, record the decision), then insert it into any process."
            />
          </span>
        ) : undefined
      }
    >
      {mode === "readonly" && <p className="text-xs text-muted-foreground">You can look at the library but not change it. Ask an Agency admin to add blocks.</p>}
      {list.length === 0 ? (
        <Card className="items-center gap-2 p-8 text-center">
          <Layers aria-hidden className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">No blocks yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            In the Editor, select a group and press “Save this group as a block”, or press “New block” to build one from scratch.
          </p>
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Blocks">
          {list.map((b) => {
            const block = readBlock(b.steps);
            const steps = blockStepCount(block);
            return (
              <li key={b.id}>
                <Card className="h-full" data-block={b.id}>
                  <div className="flex flex-col gap-2 px-(--card-spacing)">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <span className="flex items-center text-xs text-muted-foreground">
                        <span data-used-in={b.id}>{usageText(usage[b.id] ?? 0)}</span>
                        <Help
                          label="Used in"
                          description="How many saved solutions have this block in their map. A block put into one solution twice counts once."
                          example="Once “Client sign-off” sits in two solutions, this reads “Used in 2 solutions”."
                        />
                      </span>
                    </div>
                    <h2 className="font-heading text-base font-semibold">{b.name}</h2>
                    {b.description && <p className="text-xs text-muted-foreground">{b.description}</p>}
                    <p className="text-xs text-fg-2">
                      {steps} {steps === 1 ? "step" : "steps"}
                    </p>
                  </div>
                  <div className="overflow-x-auto px-(--card-spacing)">
                    <BlockMap block={block} label={`Map of ${b.name}: ${steps} ${steps === 1 ? "step" : "steps"}`} />
                  </div>
                  <BlockSteps block={block} />
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}

/** Each step of a block with its work split, tier multipliers and whether it goes to the client's manager: the base values a block carries. */
export function BlockSteps({ block }: { block: ReturnType<typeof readBlock> }) {
  const steps = block.steps.filter((s) => !isGroup(s));
  if (!steps.length) return null;
  const withSplit = steps.some((s) => s.split);
  return (
    <div className="flex flex-col gap-1.5 px-(--card-spacing)" data-block-steps>
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
