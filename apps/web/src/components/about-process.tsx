"use client";

// "About this process" (issue #174): the process's plain attributes in one line under its header. Worked out in
// lib/process-page/about.ts. Links to nothing and has no (i): each label says what it is.

import { aboutLine, type About } from "@/lib/process-page/about";

export function AboutProcess({ about }: { about: About }) {
  return (
    <section aria-labelledby="about-heading" className="min-w-0" data-testid="about-process">
      <h2 id="about-heading" className="sr-only">
        About this process
      </h2>
      <p className="mb-1.5 text-xs font-semibold tracking-wider text-fg-2 uppercase" aria-hidden>
        About this process
      </p>
      <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        {aboutLine(about).map((a) => (
          <div key={a.label} className="min-w-0">
            <dt className="text-xs text-fg-3">{a.label}</dt>
            <dd>{a.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
