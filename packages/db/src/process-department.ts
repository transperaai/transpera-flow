// Which department a process sits under on the company map (capacity Q4, migration 20270127000000). Pure.
//
// A process may carry a department of its own (`processes.department_id`, the owner's choice on the process page). Without one it
// is worked out from its servicing links: the tier services (a service with both a department and a tier) the links use. When
// they all sit in one department, that is the process's; otherwise it has none, which the map and the process page call
// "Sales and whole business": the pipeline, the internal processes and anything serving both departments or none. The owner can also
// put a process there on purpose (`processes.whole_business`) when its links would otherwise work out a department.
// Whether a tier service is switched on does not matter here: pausing a tier must not move a process to another lane.

export interface DepartmentOwner {
  id: string;
  department_id?: string | null;
  /** The owner chose "Sales and whole business" (so a department is not worked out). */
  whole_business?: boolean;
}
export interface ServicingLinkLike {
  process_id: string;
  service_id: string;
}
export interface TierServiceLike {
  id: string;
  department_id: string | null;
  tier_id: string | null;
}

/** The label for "no single department". */
export const WHOLE_BUSINESS_LABEL = "Sales and whole business";

export interface ProcessDepartment {
  /** The department, or null for "Sales and whole business". */
  departmentId: string | null;
  /** True when the owner chose it (a stored department that still exists, or whole business); false when it is worked out. */
  chosen: boolean;
}

/** The one department of the tier services this process's servicing links use, or null when they use none or more than one. */
export function derivedDepartment(processId: string, links: readonly ServicingLinkLike[], services: readonly TierServiceLike[]): string | null {
  const byId = new Map(services.map((s) => [s.id, s]));
  const departments = new Set<string>();
  for (const link of links) {
    if (link.process_id !== processId) continue;
    const svc = byId.get(link.service_id);
    if (svc?.tier_id && svc.department_id) departments.add(svc.department_id);
  }
  return departments.size === 1 ? [...departments][0]! : null;
}

/**
 * A process's department: its own when it names one of `departmentIds`, else the derived one (which must also be one of them).
 * A stored department that no longer exists counts as unset.
 */
export function processDepartment(
  process: DepartmentOwner,
  links: readonly ServicingLinkLike[],
  services: readonly TierServiceLike[],
  departmentIds: ReadonlySet<string>,
): ProcessDepartment {
  if (process.department_id && departmentIds.has(process.department_id)) return { departmentId: process.department_id, chosen: true };
  if (process.whole_business) return { departmentId: null, chosen: true };
  const derived = derivedDepartment(process.id, links, services);
  return { departmentId: derived && departmentIds.has(derived) ? derived : null, chosen: false };
}

/** Every process's department id (null: Sales and whole business), by process id. */
export function processDepartments(
  processes: readonly DepartmentOwner[],
  links: readonly ServicingLinkLike[],
  services: readonly TierServiceLike[],
  departments: readonly { id: string }[],
): Map<string, string | null> {
  const known = new Set(departments.map((d) => d.id));
  return new Map(processes.map((p) => [p.id, processDepartment(p, links, services, known).departmentId]));
}
