"use client";

// The process page's header card (Q8): the process name as the page title with pills for its category (Q3) and department (Q4), one
// muted line under it ("4 steps · 2 roles · Version 3"), and History, Edit and Export at the right. A small pencil beside the pills
// opens a popover with the Type and Department selects for the Owner and Agency admins; readers see the pills only.

import { Pencil } from "lucide-react";
import { useState, useTransition, type ReactNode } from "react";
import { PROCESS_CATEGORIES, PROCESS_CATEGORY_HELP, PROCESS_CATEGORY_LABELS, isProcessCategory, type ProcessCategory } from "@transpera-flow/db";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HEADER_PILL, MetaLine, PageHeader } from "@/components/page-kit";
import { TagPill } from "@/components/tag-pill";
import type { ProcessAdminResult } from "@/lib/processes/admin";
import type { DepartmentFieldData } from "@/lib/process-page/department";
import { aboutSummary, type About } from "@/lib/process-page/about";
import { EDIT_ONLY } from "@/lib/phone";

const PILL = HEADER_PILL;

export function ProcessHeader({
  name,
  about,
  department,
  departmentEditor,
  editCategory,
  status,
  inside,
  actions,
}: {
  name: string;
  about: About;
  department?: DepartmentFieldData;
  /** The Department select (a server action behind it), for the Owner and Agency admins; absent for everyone else. */
  departmentEditor?: ReactNode;
  /** Saves a new category (a server action); absent for people who may not edit. */
  editCategory?: (category: ProcessCategory) => Promise<ProcessAdminResult>;
  /** Replaces the summary line: the notice of an earlier version, with its way back. */
  status?: ReactNode;
  /** The processes inside this one. */
  inside?: ReactNode;
  /** History, Edit and Export. */
  actions: ReactNode;
}) {
  const [category, setCategory] = useState<ProcessCategory>(about.category);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const change = (next: string) => {
    if (!editCategory || !isProcessCategory(next) || next === category) return;
    const before = category;
    setCategory(next);
    setError(null);
    start(async () => {
      const r = await editCategory(next);
      if (r.status === "error") {
        setCategory(before);
        setError(r.message);
      }
    });
  };
  const canEdit = Boolean(editCategory) || Boolean(departmentEditor);
  const pills = (
    <>
      <TagPill tag={PROCESS_CATEGORY_LABELS[category]} className={PILL} />
      {department && <TagPill tag={department.current} className={PILL} />}
      {canEdit && (
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Edit type and department" className={EDIT_ONLY} data-edit-entry data-process-edit>
              <Pencil aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 gap-3">
            {editCategory && (
              <label className="flex flex-col gap-1 text-xs text-fg-3">
                Type
                <NativeSelect aria-label="Type" data-process-category value={category} disabled={pending} onChange={(e) => change(e.target.value)} title={PROCESS_CATEGORY_HELP[category]} className="h-8 w-full text-sm text-fg">
                  {PROCESS_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {PROCESS_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            {departmentEditor}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
  return (
    <PageHeader
      testId="about-process"
      label="Process"
      title={name}
      pills={pills}
      meta={<MetaLine>{status ?? <p>{aboutSummary({ ...about, category })}</p>}</MetaLine>}
      below={inside}
      actions={actions}
      actionsLabel="Process actions"
    />
  );
}
