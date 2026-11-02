// The process page's Department field (Q4). Pure.

import { processDepartment, WHOLE_BUSINESS_LABEL, type ProcessRow } from "@transpera-flow/db";
import type { DepartmentLaneInput } from "@/lib/overview/department-lanes";

/** The select's value for "Sales and whole business" (a department's value is its id; null is "worked out"). */
export const WHOLE_BUSINESS_CHOICE = "whole-business";

export interface DepartmentFieldData {
  /** The stored choice: a department id, WHOLE_BUSINESS_CHOICE, or null (worked out). */
  value: string | null;
  options: { value: string; label: string }[];
  /** What "worked out" gives, as a label. */
  workedOut: string;
  /** What the process is under now, as a label. */
  current: string;
  /** Whether the choice was made by the owner. */
  chosen: boolean;
}

export function departmentField(process: Pick<ProcessRow, "id" | "department_id" | "whole_business">, input: DepartmentLaneInput): DepartmentFieldData {
  const known = new Set(input.departments.map((d) => d.id));
  const name = (id: string | null) => (id ? (input.departments.find((d) => d.id === id)?.name ?? WHOLE_BUSINESS_LABEL) : WHOLE_BUSINESS_LABEL);
  const workedOut = processDepartment({ id: process.id }, input.links, input.services, known);
  const now = processDepartment(process, input.links, input.services, known);
  const value = now.chosen ? (now.departmentId ?? WHOLE_BUSINESS_CHOICE) : null;
  return {
    value,
    options: [
      ...[...input.departments].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)).map((d) => ({ value: d.id, label: d.name })),
      { value: WHOLE_BUSINESS_CHOICE, label: WHOLE_BUSINESS_LABEL },
    ],
    workedOut: name(workedOut.departmentId),
    current: name(now.departmentId),
    chosen: now.chosen,
  };
}
