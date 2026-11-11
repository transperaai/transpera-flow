"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The left sub-nav of the Settings page (docs/plans/ui-cleanup.md, SettingsLayout). The page is one scroll of eight sections, and every
 * entry links to a section's band (`/settings#<id>`, the id SettingsBand gives it). On the page, the entry for the section in view is
 * marked as current. Sticky beside the form from lg up; below lg, one row that scrolls sideways.
 */
export interface SettingsNavEntry {
  label: string;
  href: string;
  /** The section's id on the page (its band's id), for marking the one in view. */
  section: string;
}

/** The sections of the Settings page, in its order. */
export const SETTINGS_SECTIONS = [
  { label: "Workspace", section: "workspace" },
  { label: "Simulation", section: "simulation" },
  { label: "Purposes", section: "purposes" },
  { label: "Churn drivers", section: "churn-drivers" },
  { label: "Demand", section: "demand" },
  { label: "Tiers & clients", section: "tiers-clients" },
  { label: "People & roles", section: "people-roles" },
  // Access is for whoever manages the workspace (the page renders it only for them).
  { label: "Access", section: "access", managersOnly: true },
] as const;

export function settingsNavEntries(slug: string, canManage: boolean): SettingsNavEntry[] {
  return SETTINGS_SECTIONS.filter((s) => canManage || !("managersOnly" in s)).map((s) => ({ label: s.label, section: s.section, href: `/w/${slug}/settings#${s.section}` }));
}

/** The section of the page nearest the top of the window, as the page scrolls; the last one once the page is scrolled to its end. */
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
    const last = els[els.length - 1]!;
    const visible = new Map<string, boolean>();
    // A short last section never reaches the band below: once its end is on screen (the page can't scroll further), it is the one read.
    const atEnd = () => last.getBoundingClientRect().bottom <= window.innerHeight + 1 && last.getBoundingClientRect().top < window.innerHeight * 0.6;
    const pick = () => {
      if (atEnd()) return setCurrent(last.id);
      const first = els.find((el) => visible.get(el.id));
      if (first) setCurrent(first.id);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting);
        pick();
      },
      // A band just under the sticky top bar: the section whose top part is in it is the one being read.
      { rootMargin: "-56px 0px -60% 0px" },
    );
    for (const el of els) observer.observe(el);
    // Whatever scrolls (the window or the shell's column): capture catches a scroll on any element.
    document.addEventListener("scroll", pick, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", pick, { capture: true });
    };
  }, [key, on]);
  return on ? current : null;
}

export function SettingsNav({ slug, canManage }: { slug: string; canManage: boolean }) {
  const pathname = usePathname();
  const entries = settingsNavEntries(slug, canManage);
  const main = `/w/${slug}/settings`;
  const onMain = pathname === main;
  const sections = entries.map((e) => e.section);
  const inView = useSectionInView(sections, onMain);
  const isCurrent = (e: SettingsNavEntry) => onMain && (inView ?? sections[0]) === e.section;
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
                aria-current={current ? "location" : undefined}
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
