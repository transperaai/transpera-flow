"use client";

// The Block library page (issue #116): a card for each saved block with how many solutions use it, its name and
// description and a small map of its steps. "✎ New block" opens the Editor in block mode. On the demo the blocks live in this
// tab (lib/blocks/demo.ts), so a block saved from the Editor shows here at once.

import Link from "next/link";
import { Layers } from "lucide-react";
import type { BlockRow } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, MetaLine, PageHeader, SectionCard } from "@/components/page-kit";
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

const NEW_BLOCK_LINK = cn(buttonVariants(), "bg-edit text-edit-fg hover:bg-edit/90");

export function BlockLibrary({ blocks, mode, newHref, usage = {} }: { blocks: BlockRow[]; mode: "live" | "readonly" | "demo"; newHref: string | null; usage?: Record<string, number> }) {
  const demo = useDemoBlocks();
  const list = mode === "demo" ? demo : blocks;
  return (
    <Page title="Block library" hideHeader>
      <PageHeader
        label="Block library"
        testId="blocks-header"
        eyebrow={<span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Improve</span>}
        title="Block library"
        meta={
          <MetaLine>
            <span>Saved bundles of steps. Drop one into a solution, or into a process in the Editor.</span>
            <span data-blocks-count>{list.length === 1 ? "1 block" : `${list.length} blocks`}</span>
            {mode === "readonly" ? <span>You can look at the library but not change it. Ask an Agency admin to add blocks.</span> : ""}
          </MetaLine>
        }
        actionsLabel="Block library actions"
        actions={
          newHref ? (
            <span className={`inline-flex items-center ${EDIT_ONLY}`} data-edit-entry>
              <Link href={newHref} className={NEW_BLOCK_LINK}>
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
      />
      {list.length === 0 ? (
        <EmptyState
          icon={Layers}
          data-testid="blocks-empty"
          action={
            newHref ? (
              <span className={`inline-flex items-center ${EDIT_ONLY}`} data-edit-entry>
                <Link href={newHref} className={NEW_BLOCK_LINK}>
                  ✎ New block
                </Link>
              </span>
            ) : undefined
          }
        >
          No blocks yet. In the Editor, select a group and press “Save this group as a block”, or press “New block” to build one from scratch.
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Blocks">
          {list.map((b) => {
            const block = readBlock(b.steps);
            const steps = blockStepCount(block);
            return (
              <li key={b.id} className="min-w-0" data-block={b.id}>
                <SectionCard
                  id={`block-${b.id}`}
                  className="h-full"
                  title={b.name}
                  contentClassName="gap-3"
                >
                  <div className="flex flex-col gap-1">
                    {b.description && <p className="text-sm text-fg-2">{b.description}</p>}
                    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-fg-2">
                      <span>
                        {steps} {steps === 1 ? "step" : "steps"}
                      </span>
                      <span aria-hidden>·</span>
                      <span className="flex items-center">
                        <span data-used-in={b.id}>{usageText(usage[b.id] ?? 0)}</span>
                        <Help
                          label="Used in"
                          description="How many saved solutions have this block in their map. A block put into one solution twice counts once."
                          example="Once “Client sign-off” sits in two solutions, this reads “Used in 2 solutions”."
                        />
                      </span>
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <BlockMap block={block} label={`Map of ${b.name}: ${steps} ${steps === 1 ? "step" : "steps"}`} />
                  </div>
                  <BlockSteps block={block} />
                </SectionCard>
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
