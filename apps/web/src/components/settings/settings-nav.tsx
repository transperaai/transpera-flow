"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The left sub-nav of every Settings page (docs/plans/ui-cleanup.md, SettingsLayout). The first five entries are sections of the main
 * Settings page and link to their headings (`#<section id>-heading`, the ids SettingsSection gives them); the last three are pages of
 * their own. On the main page the entry for the section in view is marked as current; on a sub-page, that page's entry is.
 */
export interface SettingsNavEntry {
  label: string;
  href: string;
  /** The section id on the main page (its card's id), for marking the one in view. */
  section?: string;
}

export function settingsNavEntries(slug: string, canManage: boolean): SettingsNavEntry[] {
  return [
    { label: "Workspace", href: `/w/${slug}/settings#workspace-heading`, section: "workspace" },
    { label: "Simulation", href: `/w/${slug}/settings#simulation-heading`, section: "simulation" },
    { label: "Purposes", href: `/w/${slug}/settings#purposes-heading`, section: "purposes" },
    { label: "Churn drivers", href: `/w/${slug}/settings#churn-drivers-heading`, section: "churn-drivers" },
    { label: "Demand", href: `/w/${slug}/settings#demand-heading`, section: "demand" },
    { label: "Tiers & clients", href: `/w/${slug}/settings/clients` },
    { label: "People & roles", href: `/w/${slug}/settings/people` },
    // Access is for whoever manages the workspace (its page answers 404 to anyone else).
    ...(canManage ? [{ label: "Access", href: `/w/${slug}/settings/access` }] : []),
  ];
}

/** The section of the main page nearest the top of the window, as the page scrolls. */
function useSectionInView(ids: string[], on: boolean): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  const key = ids.join(",");
  useEffect(() => {
    if (!on || typeof IntersectionObserver === "undefined") return;
    const els = key
      .split(",")
      .map((id) => document.getElementById(id))
      .filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting);
        const first = els.find((el) => visible.get(el.id));
        if (first) setCurrent(first.id);
      },
      // A band just under the sticky top bar: the section whose top part is in it is the one being read.
      { rootMargin: "-56px 0px -60% 0px" },
    );
    for (const el of els) observer.observe(el);
    return () => observer.disconnect();
  }, [key, on]);
  return on ? current : null;
}

export function SettingsNav({ slug, canManage }: { slug: string; canManage: boolean }) {
  const pathname = usePathname();
  const entries = settingsNavEntries(slug, canManage);
  const main = `/w/${slug}/settings`;
  const onMain = pathname === main;
  const sections = entries.flatMap((e) => (e.section ? [e.section] : []));
  const inView = useSectionInView(sections, onMain);
  const isCurrent = (e: SettingsNavEntry) => (e.section ? onMain && (inView ?? sections[0]) === e.section : pathname === e.href);
  return (
    <nav aria-label="Settings" data-settings-nav className="min-w-0 lg:sticky lg:top-16">
      {/* Below lg the entries run in one row that scrolls on its own; from lg up, a column beside the form. */}
      <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0 lg:pb-0">
        {entries.map((e) => {
          const current = isCurrent(e);
          return (
            <li key={e.href} className="shrink-0">
              <Link
                href={e.href}
                aria-current={current ? (e.section ? "location" : "page") : undefined}
                className={cn(
                  "block rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-fg-2 outline-none hover:bg-panel-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  current && "bg-accent-soft font-medium text-accent hover:bg-accent-soft hover:text-accent",
                )}
              >
                {e.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
