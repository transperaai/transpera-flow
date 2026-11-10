"use client";

// The process page's toolbar (Q8, then the workbench of docs/plans/ui-cleanup.md): one slim row with the process name as the page's one
// title (the process switcher where there is one), a Live or Draft pill with the version, the process's rating, pills for its category
// (Q3) and department (Q4), the key numbers inline ("4 steps · 2 roles · 38 h a month · A$4,180 a month"), and History, Edit and
// Export at the right. A small pencil beside the pills opens a popover with the Type and Department selects for the Owner and Agency
// admins; readers see the pills only.

import { Pencil } from "lucide-react";
import type { Rating } from "@transpera-flow/engine";
import { useState, useTransition, type ReactNode } from "react";
import { PROCESS_CATEGORIES, PROCESS_CATEGORY_HELP, PROCESS_CATEGORY_LABELS, isProcessCategory, type ProcessCategory } from "@transpera-flow/db";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HEADER_PILL } from "@/components/page-kit";
import { TagPill } from "@/components/tag-pill";
import { RatingPill } from "@/components/overview/rating-pill";
import type { ProcessAdminResult } from "@/lib/processes/admin";
import type { DepartmentFieldData } from "@/lib/process-page/department";
import type { About } from "@/lib/process-page/about";
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
  title,
  rating = null,
  numbers,
}: {
  name: string;
  /** The title itself: the process switcher (an h1 that opens every process). Omitted: the name as a plain h1. */
  title?: ReactNode;
  /** The worst rating on the process's steps, as a pill; null when nothing is rated. */
  rating?: Rating | null;
  /** More key numbers after the steps and roles: the hours and cost a month, from the run. */
  numbers?: ReactNode;
  about: About;
  department?: DepartmentFieldData;
  /** The Department select (a server action behind it), for the Owner and Agency admins; absent for everyone else. */
  departmentEditor?: ReactNode;
  /** Saves a new category (a server action); absent for people who may not edit. */
  editCategory?: (category: ProcessCategory) => Promise<ProcessAdminResult>;
  /** Replaces the Live or Draft pill: the notice of an earlier version, with its way back. */
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
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <div
      data-testid="about-process"
      data-page-header
      role="region"
      aria-label="Process"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-background px-4 py-2"
    >
      <div className="flex min-w-0 max-w-full items-center">{title ?? <h1 className="min-w-0 truncate font-display text-base font-semibold">{name}</h1>}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {status ?? (
          <span className="inline-flex items-center gap-1.5" data-process-status={about.version === null ? "draft" : "live"}>
            {about.version === null ? (
              <span className={`inline-flex rounded-full border border-warn bg-warn-soft font-medium text-fg ${PILL}`}>Draft</span>
            ) : (
              <span className={`inline-flex rounded-full bg-good-soft font-medium text-fg ${PILL}`}>Live</span>
            )}
            <span className="text-xs text-muted-foreground">{about.version === null ? "not published yet" : `Version ${about.version}`}</span>
          </span>
        )}
        {rating && <RatingPill rating={rating} />}
        {pills}
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground tabular-nums" data-process-numbers>
        <span>
          {plural(about.steps, "step", "steps")} · {plural(about.roles, "role", "roles")}
        </span>
        {numbers}
      </p>
      {inside}
      <div className="ml-auto flex flex-wrap items-center gap-2" role="group" aria-label="Process actions" data-page-actions>
        {actions}
      </div>
    </div>
  );
}
