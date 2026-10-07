"use client";

// The Block library page (issue #116): a card for each saved block with its type, how many solutions use it, its name and
// description and a small map of its steps. "✎ New block" opens the Editor in block mode. On the demo the blocks live in this
// tab (lib/blocks/demo.ts), so a block saved from the Editor shows here at once.

import Link from "next/link";
import { Layers } from "lucide-react";
import type { BlockRow } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Page } from "@/components/shell/page";
import { blockStepCount, readBlock } from "@/lib/blocks/blocks";
import { useDemoBlocks } from "@/lib/blocks/demo";
import { cn } from "@/lib/utils";
import { BlockMap } from "./block-map";
import { EDIT_ONLY } from "@/lib/phone";

const TYPE_LABEL: Record<BlockRow["type"], string> = { manual: "By hand", ai: "AI" };

/** "Used in 2 solutions". Solutions arrive with A49 and don't record the blocks they use yet, so until then it is 0. */
export const usageText = (n: number) => `Used in ${n} ${n === 1 ? "solution" : "solutions"}`;

export function BlockLibrary({ blocks, mode, newHref }: { blocks: BlockRow[]; mode: "live" | "readonly" | "demo"; newHref: string | null }) {
  const demo = useDemoBlocks();
  const list = mode === "demo" ? demo : blocks;
  return (
    <Page
      title="Block library"
      eyebrow="Improve"
      description="Saved bundles of steps. Drop one into a solution, or into a process in the Editor. AI solutions are blocks too."
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
      {mode === "readonly" && <p className="text-xs text-muted-foreground">You can look at the library but not change it. Ask an owner or editor to add blocks.</p>}
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
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center">
                        <Badge variant={b.type === "ai" ? "default" : "outline"}>{TYPE_LABEL[b.type]}</Badge>
                        <Help
                          label="Block type"
                          description="“By hand” blocks were built or saved by a person. “AI” blocks were made by the AI's solution ideas. Both are inserted the same way."
                          example="“Client sign-off” is by hand; an “AI lead qualifier” the AI suggested is marked AI."
                        />
                      </span>
                      <span className="flex items-center text-xs text-muted-foreground">
                        {usageText(0)}
                        <Help
                          label="Used in"
                          description="How many saved solutions use this block. Solutions are not built yet, so it shows 0 until they are."
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
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
