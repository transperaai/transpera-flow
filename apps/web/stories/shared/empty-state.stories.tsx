import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useMemo, useState } from "react";
import { ProcessCanvas } from "@/components/process-canvas";
import { EmptyState } from "@/components/shell/empty-state";
import { Button } from "@/components/ui/button";
import { demoBundle } from "@/lib/sources/demo";

// A list, chart or map with nothing to show yet (issue #44).

const meta: Meta = { title: "Shared/EmptyState", parameters: { layout: "padded" } };
export default meta;

export const Plain: StoryObj = {
  render: () => <EmptyState>No people yet. Add them in Settings, People.</EmptyState>,
};

export const WithTitle: StoryObj = {
  render: () => <EmptyState title="Nothing here yet">Issues you log, and insights you acknowledge, will be listed here.</EmptyState>,
};

export const WithAction: StoryObj = {
  render: () => (
    <EmptyState title="Nothing to draw yet" action={<Button variant="outline" size="sm">Open in Editor</Button>}>
      This process has no steps.
    </EmptyState>
  ),
};

/** A read-only map whose process has only start and end. Ready once the map has framed itself (`data-visual-pending`). */
function EmptyMap_() {
  const bundle = useMemo(() => {
    const base = demoBundle();
    const ends = base.steps.filter((s) => s.kind === "start" || s.kind === "end");
    const kept = new Set(ends.map((s) => s.id));
    return { ...base, steps: ends, edges: base.edges.filter((e) => kept.has(e.from_step_id) && kept.has(e.to_step_id)) };
  }, []);
  const [pending, setPending] = useState(true);
  useEffect(() => {
    let frame = 0;
    let last = "";
    let still = 0;
    let done = false;
    const tick = () => {
      if (done) return;
      const transform = document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
      still = transform && transform === last ? still + 1 : 0;
      last = transform;
      if (still >= 30) {
        setPending(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      done = true;
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div data-visual-pending={pending ? "" : undefined} style={{ width: "100%", maxWidth: 1200 }}>
      <ProcessCanvas bundle={bundle} showPlayback={false} emptyAction={<Button variant="outline" size="sm">Open in Editor</Button>} />
    </div>
  );
}

export const EmptyMap: StoryObj = {
  tags: ["visual-phone"],
  render: () => <EmptyMap_ />,
};
