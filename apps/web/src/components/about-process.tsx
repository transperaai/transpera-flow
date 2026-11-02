"use client";

// "About this process" (issue #174): the process's plain attributes in one line under its header. Worked out in
// lib/process-page/about.ts. Links to nothing and has no (i): each label says what it is. Type is the process's category (Q3);
// the Owner and Agency admins change it here with a select.

import { useState, useTransition } from "react";
import { PROCESS_CATEGORIES, PROCESS_CATEGORY_HELP, PROCESS_CATEGORY_LABELS, isProcessCategory, type ProcessCategory } from "@transpera-flow/db";
import { NativeSelect } from "@/components/ui/native-select";
import type { ProcessAdminResult } from "@/lib/processes/admin";
import { aboutLine, type About } from "@/lib/process-page/about";
import { EDIT_ONLY } from "@/lib/phone";

export function AboutProcess({ about, editCategory }: { about: About; /** Saves a new category (a server action); absent for people who may not edit. */ editCategory?: (category: ProcessCategory) => Promise<ProcessAdminResult> }) {
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
  return (
    <section aria-labelledby="about-heading" className="min-w-0" data-testid="about-process">
      <h2 id="about-heading" className="sr-only">
        About this process
      </h2>
      <p className="mb-1.5 text-xs font-semibold tracking-wider text-fg-2 uppercase" aria-hidden>
        About this process
      </p>
      <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        {aboutLine({ ...about, category }).map((a) => (
          <div key={a.label} className="min-w-0">
            <dt className="text-xs text-fg-3">{a.label}</dt>
            <dd>
              {a.label === "Type" && editCategory ? (
                <NativeSelect
                  aria-label="Type"
                  data-process-category
                  value={category}
                  disabled={pending}
                  onChange={(e) => change(e.target.value)}
                  title={PROCESS_CATEGORY_HELP[category]}
                  className={`h-7 w-auto py-0 ${EDIT_ONLY}`}
                >
                  {PROCESS_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {PROCESS_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                a.value
              )}
            </dd>
          </div>
        ))}
      </dl>
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
