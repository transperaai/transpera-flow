// Department lanes on the company map (capacity Q4). Pure: the same processes, departments and servicing links always give the same lanes.
//
// The map lays its process cards in horizontal lanes: "Sales and whole business" first, then each department in its `sort` order. A
// process's lane is its department (chosen on its page, or worked out from the tier services its servicing links use; see
// `processDepartment` in packages/db). This module turns that into the lane list and a lane key for each process; where the cards go
// inside a lane is `bandLayout` in lib/editor/lanes.ts.

import { processDepartment, WHOLE_BUSINESS_LABEL, type DepartmentOwner, type ServicingLinkLike, type TierServiceLike } from "@transpera-flow/db";

export interface DepartmentLaneInput {
  /** The workspace's departments (any order: they are sorted by `sort` here). */
  departments: readonly { id: string; name: string; sort: number }[];
  services: readonly TierServiceLike[];
  links: readonly ServicingLinkLike[];
}

export const EMPTY_LANE_INPUT: DepartmentLaneInput = { departments: [], services: [], links: [] };

/** The key of the "Sales and whole business" lane. A department's key is its id. */
export const WHOLE_BUSINESS_LANE = "whole-business";

export interface LaneSpec {
  key: string;
  label: string;
}

/** The lanes in order: Sales and whole business, then each department by its sort order (ties by name). */
export function laneSpecs(input: DepartmentLaneInput): LaneSpec[] {
  const ordered = [...input.departments].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return [{ key: WHOLE_BUSINESS_LANE, label: WHOLE_BUSINESS_LABEL }, ...ordered.map((d) => ({ key: d.id, label: d.name }))];
}

/** Each process's lane key (a department id, or WHOLE_BUSINESS_LANE). */
export function laneOfProcesses(processes: readonly DepartmentOwner[], input: DepartmentLaneInput): Map<string, string> {
  const known = new Set(input.departments.map((d) => d.id));
  return new Map(processes.map((p) => [p.id, processDepartment(p, input.links, input.services, known).departmentId ?? WHOLE_BUSINESS_LANE]));
}
