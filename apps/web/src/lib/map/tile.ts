// What a map tile (rating tile, issue #242) shows beyond the step's own values:
// the one headline number, and the colours a rating gives the tile. Pure, so the
// canvas and the map image export share one mapping and it is unit-tested.

import type { Rating } from "@transpera-flow/engine";
import { formatHours, formatNumber } from "@/lib/format";
import { RATING_STYLE } from "./rating";

/** B's "N issues" pill on a tile's top-right edge (the issue badge and a closed group's count). */
export const ISSUE_PILL_CLASS =
  "absolute -top-2.5 right-2.5 z-10 flex h-5 items-center rounded-full border-2 border-panel bg-destructive px-2 text-[11px] leading-none font-bold text-crit-fg shadow-token";

export interface HeadlineInput {
  /** The step has a role or a person (today's queue condition). */
  staffed: boolean;
  /** `result.steps[step.id]` when the run has the step, else null. */
  run: { avgWait: number; avgQueue: number } | null;
  /** The step's planned wait, in hours. */
  waitHours: number;
}

export interface Headline {
  value: string;
  caption: string;
  /** Hover text. */
  title: string;
  /** Extra words for the screen-reader label, or null when the label already says it. */
  phrase: string | null;
}

/** The one number on a tile: the queue wait of a staffed step, the planned wait of one nobody works. */
export function tileHeadline({ staffed, run, waitHours }: HeadlineInput): Headline {
  if (staffed) {
    if (run) {
      return {
        value: formatHours(run.avgWait),
        caption: `waiting · queue ${formatNumber(run.avgQueue)}`,
        title: "Average time an item waits in the queue before work starts, and the average number waiting, in this run",
        phrase: `waits ${formatHours(run.avgWait)} in the queue on average, average queue ${formatNumber(run.avgQueue)}`,
      };
    }
    return { value: "—", caption: "waiting", title: "Not simulated yet", phrase: null };
  }
  if (waitHours > 0) return { value: formatHours(waitHours), caption: "wait", title: "Planned wait at this step", phrase: null };
  return { value: "—", caption: "wait", title: "No wait entered", phrase: null };
}

export interface TileColours {
  background: string;
  borderColor: string;
  /** The rating dot. */
  dot: string;
  /** The foot's divider line. */
  divider: string;
}

/** A tile's fill, edge, dot and divider from its rating (null: unrated); a bottleneck edges in the critical colour. */
export function tileColours(rating: Rating | null, bottleneck: boolean): TileColours {
  const edge = rating ? RATING_STYLE[rating].stripe : "var(--line-2)";
  return {
    background: rating ? RATING_STYLE[rating].soft : "var(--panel)",
    borderColor: bottleneck ? "var(--crit)" : edge,
    dot: edge,
    divider: `color-mix(in oklab, ${edge} 35%, transparent)`,
  };
}
