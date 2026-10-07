import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { FirstRunStatus, MapSkeleton } from "@/components/map/map-placeholder";
import { ProcessCanvas } from "@/components/process-canvas";
import { northbeamRun } from "../fixtures";

// The stand-in for a map that loads late, and the chip over a map whose first run is computing (issue #44).

const meta: Meta = { title: "Map/Placeholder", parameters: { layout: "padded" } };
export default meta;

/** The map's frame with its toolbar and four step-card shapes. */
export const Skeleton: StoryObj = {
  name: "MapSkeleton",
  tags: ["visual-phone"],
  render: () => (
    <div style={{ width: "100%", maxWidth: 1200 }}>
      <MapSkeleton height={256} />
    </div>
  ),
};

/** The chip on its own, in the corner of a box. */
export const Chip: StoryObj = {
  name: "FirstRunStatus",
  render: () => (
    <div className="relative h-12 w-72 rounded-lg border bg-card">
      <FirstRunStatus />
    </div>
  ),
};

/** Ready once the map has framed itself and held still, so the picture does not depend on timing (`data-visual-pending`, as in the process map's stories). */
function FramedMap() {
  const { bundle } = northbeamRun();
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
      <ProcessCanvas bundle={bundle} showPlayback={false} computing />
    </div>
  );
}

/** Northbeam drawn without numbers while its first run computes. */
export const FirstRun: StoryObj = {
  tags: ["visual-phone"],
  render: () => <FramedMap />,
};
