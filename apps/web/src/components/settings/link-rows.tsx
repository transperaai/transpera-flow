import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

/** A list of pages as tidy rows: the name, one muted line saying what is there, and a chevron. Each row is one link. */
export function LinkRows({ items, label }: { items: { href: string; title: string; description: ReactNode }[]; label: string }) {
  return (
    <ul aria-label={label} className="-my-1 flex flex-col divide-y divide-line">
      {items.map((i) => (
        <li key={i.href}>
          <Link href={i.href} className="group flex items-center gap-3 rounded-md py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium text-accent group-hover:underline">{i.title}</span>
              <span className="text-sm text-fg-2">{i.description}</span>
            </span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-3" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
