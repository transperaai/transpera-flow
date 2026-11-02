// Swimlane view (issue #8, PRD §4.1): steps grouped in horizontal lanes by
// role. Lanes are a view, not data: a step's lane follows its role, and a step
// keeps its stored position, which the free layout still uses. Within a lane
// steps keep their left-to-right order (their stored x); steps that would
// overlap are stacked in rows.

import type { ProcessBundle, StepRow } from "@transpera-flow/db";

export interface Lane {
  /** A role id, or NO_ROLE_LANE. */
  key: string;
  label: string;
  /** The role's colour; null for the no-role lane. */
  color: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaneLayout {
  lanes: Lane[];
  /** Where each step is drawn in the lane view. */
  positions: Map<string, { x: number; y: number }>;
  /** Each step's lane key. */
  laneOf: Map<string, string>;
}

export const NO_ROLE_LANE = "none";

type Size = { width: number; height: number };

/** A card's size before React Flow has measured it. */
const defaultSize = (step: StepRow): Size =>
  step.kind === "start" || step.kind === "end" ? { width: 100, height: 30 } : { width: 176, height: 88 };

const PAD = 24;
const ROW_GAP = 24;
const COL_GAP = 16;
/** Room on each lane's left for its name. */
const LABEL_WIDTH = 150;

/**
 * Which lane each step goes in: its role's; a step pinned to a person without
 * a role goes in that person's first role's lane. The start step goes in the
 * lane of the step it leads to, an end step in the lane of the step most
 * likely to lead to it, so they sit next to their work. Anything else without
 * a role (a client decision, a wait) goes in the "No role" lane.
 */
export function assignLanes(bundle: ProcessBundle): Map<string, string> {
  const roles = new Set(bundle.roles.map((r) => r.id));
  const own = (step: StepRow): string | null => {
    if (step.role_id && roles.has(step.role_id)) return step.role_id;
    if (step.person_id) {
      const pr = bundle.personRoles.find((r) => r.person_id === step.person_id && roles.has(r.role_id));
      if (pr) return pr.role_id;
    }
    return null;
  };
  const byId = new Map(bundle.steps.map((s) => [s.id, s]));
  const out = new Map<string, string>();
  for (const step of bundle.steps) {
    let lane = own(step);
    if (!lane && (step.kind === "start" || step.kind === "end")) {
      const links = bundle.edges
        .filter((e) => (step.kind === "start" ? e.from_step_id === step.id : e.to_step_id === step.id))
        .sort((a, b) => Number(b.probability) - Number(a.probability) || a.id.localeCompare(b.id));
      for (const e of links) {
        const other = byId.get(step.kind === "start" ? e.to_step_id : e.from_step_id);
        lane = other ? own(other) : null;
        if (lane) break;
      }
    }
    out.set(step.id, lane ?? NO_ROLE_LANE);
  }
  return out;
}

/** Lanes top to bottom in the workspace's role order, "No role" last; only lanes with steps. */
export function laneLayout(bundle: ProcessBundle, sizes: ReadonlyMap<string, Size> = new Map()): LaneLayout {
  const laneOf = assignLanes(bundle);
  const size = (s: StepRow) => sizes.get(s.id) ?? defaultSize(s);
  const order = [...bundle.roles.map((r) => ({ key: r.id, label: r.name, color: r.color })), { key: NO_ROLE_LANE, label: "No role", color: null }];
  const minX = Math.min(0, ...bundle.steps.map((s) => Number(s.x)));
  const maxX = Math.max(0, ...bundle.steps.map((s) => Number(s.x) + size(s).width));
  const left = minX - LABEL_WIDTH;
  const width = maxX + PAD * 2 - left;

  const lanes: Lane[] = [];
  const positions = new Map<string, { x: number; y: number }>();
  let top = 0;
  for (const lane of order) {
    const steps = bundle.steps
      .filter((s) => laneOf.get(s.id) === lane.key)
      .sort((a, b) => Number(a.x) - Number(b.x) || Number(a.y) - Number(b.y) || a.id.localeCompare(b.id));
    if (!steps.length) continue;
    // Stack steps that would overlap: each goes in the first row with room for it.
    const rowEnds: number[] = [];
    const rowOf = new Map<string, number>();
    for (const s of steps) {
      const x = Number(s.x);
      let row = rowEnds.findIndex((end) => end + COL_GAP <= x);
      if (row < 0) row = rowEnds.push(0) - 1;
      rowEnds[row] = x + size(s).width;
      rowOf.set(s.id, row);
    }
    const rowHeight = Math.max(...steps.map((s) => size(s).height));
    const rows = rowEnds.length;
    for (const s of steps) {
      const row = rowOf.get(s.id)!;
      const y = top + PAD + row * (rowHeight + ROW_GAP) + (rowHeight - size(s).height) / 2;
      positions.set(s.id, { x: Number(s.x), y: Math.round(y) });
    }
    const height = PAD * 2 + rows * rowHeight + (rows - 1) * ROW_GAP;
    lanes.push({ ...lane, x: left, y: top, width, height });
    top += height;
  }
  return { lanes, positions, laneOf };
}

// ---------------------------------------------------------------------------------------------------------------------
// Bands: the company map's lanes (capacity Q4). Unlike the role lanes above, which stack steps into rows, a band keeps the
// stored layout: each top-level card keeps its stored x, and its stored y relative to the highest card of its lane. The lane
// is as tall as its cards need, so a lane edge never cuts a card.

/** Empty stretches of a lane longer than this are closed up to BAND_GAP. */
const BAND_MAX_GAP = 160;
const BAND_GAP = 48;
/** Room above a lane's first card for its name. */
const BAND_TOP = 60;

export interface BandSpec {
  /** The lanes top to bottom; one with no cards is not drawn. */
  lanes: readonly { key: string; label: string }[];
  /** A top-level step's lane key; a step with none goes in the first lane. */
  laneOf: ReadonlyMap<string, string>;
}

/** Cards in horizontal bands by `spec`, at their stored x and y within the band. Steps inside a group are not placed here. */
export function bandLayout(steps: readonly StepRow[], spec: BandSpec, sizeOf: (step: StepRow) => Size): LaneLayout {
  const top = steps.filter((s) => !s.parent_step_id);
  const first = spec.lanes[0]?.key ?? NO_ROLE_LANE;
  const keys = new Set(spec.lanes.map((l) => l.key));
  const laneKey = (s: StepRow) => {
    const k = spec.laneOf.get(s.id);
    return k !== undefined && keys.has(k) ? k : first;
  };
  const laneOf = new Map(top.map((s) => [s.id, laneKey(s)]));
  const minX = Math.min(0, ...top.map((s) => Number(s.x)));
  const maxX = Math.max(0, ...top.map((s) => Number(s.x) + sizeOf(s).width));
  const left = minX - LABEL_WIDTH;
  const width = maxX + PAD * 2 - left;
  const lanes: Lane[] = [];
  const positions = new Map<string, { x: number; y: number }>();
  let at = 0;
  for (const lane of spec.lanes) {
    const cards = top.filter((s) => laneOf.get(s.id) === lane.key);
    if (!cards.length) continue;
    // Stored y, relative to the lane's highest card. A stretch with no card of this lane (where other lanes' cards sat in the one stored
    // map) longer than BAND_MAX_GAP is closed up to BAND_GAP; everything else, side by side or close, stays as stored.
    const sorted = [...cards].sort((a, b) => Number(a.y) - Number(b.y) || Number(a.x) - Number(b.x) || a.id.localeCompare(b.id));
    const minY = Number(sorted[0]!.y);
    let taken = 0;
    let reach = -Infinity;
    let bottom = 0;
    for (const s of sorted) {
      const y = Number(s.y);
      if (reach > -Infinity && y - reach > BAND_MAX_GAP) taken += y - reach - BAND_GAP;
      const shown = Math.round(at + BAND_TOP + (y - minY) - taken);
      positions.set(s.id, { x: Number(s.x), y: shown });
      reach = Math.max(reach, y + sizeOf(s).height);
      bottom = Math.max(bottom, shown + sizeOf(s).height);
    }
    const height = bottom + PAD - at;
    lanes.push({ key: lane.key, label: lane.label, color: null, x: left, y: at, width, height });
    at += height;
  }
  return { lanes, positions, laneOf };
}
