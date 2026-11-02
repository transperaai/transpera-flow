"use client";

// The Department field in "About this process" (Q4): the Owner and Agency admins choose the department the company map puts this
// process under; everyone else reads it. Unset shows the worked-out department as the default.

import { SelectField } from "@/components/fields";
import { saveProcessDepartment } from "@/app/w/[slug]/process-department-actions";
import type { DepartmentFieldData } from "@/lib/process-page/department";

export function ProcessDepartmentField({ processId, data, canEdit }: { processId: string; data: DepartmentFieldData; canEdit: boolean }) {
  if (!canEdit) {
    return (
      <div className="min-w-0" data-testid="process-department">
        <dt className="text-xs text-fg-3">Department</dt>
        <dd>{data.current}</dd>
      </div>
    );
  }
  return (
    <div className="min-w-0" data-testid="process-department">
      <SelectField
        label="Department"
        value={data.value}
        save={(base, next) => saveProcessDepartment(processId, base, next)}
        options={data.options}
        noneLabel={`Worked out: ${data.workedOut}`}
        hint="Sets the lane on the company map."
      />
    </div>
  );
}
