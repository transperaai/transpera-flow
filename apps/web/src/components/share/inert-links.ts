"use client";

import { useEffect, type RefObject } from "react";

/** A link to another page of the workspace: an empty address or one that starts with "/" (not "//", not "#"). */
export function isInternalHref(href: string | null): boolean {
  if (href === null) return false;
  if (href === "") return true;
  return href.startsWith("/") && !href.startsWith("//");
}

/**
 * In a share link's page, links to other pages of the workspace go nowhere: the visitor has no access to them. Marks each as
 * inert (plain text, out of the tab order) as the screen draws them, and swallows a click on one that was missed. External
 * links (`https://…`) and in-page ones (`#…`) are left alone.
 */
export function useInertLinks(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const mark = () => {
      for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        if (a.hasAttribute("data-share-inert") || !isInternalHref(a.getAttribute("href"))) continue;
        a.setAttribute("data-share-inert", "");
        a.setAttribute("tabindex", "-1");
        a.setAttribute("aria-disabled", "true");
      }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true });
    const swallow = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (a && isInternalHref(a.getAttribute("href"))) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    root.addEventListener("click", swallow, true);
    return () => {
      observer.disconnect();
      root.removeEventListener("click", swallow, true);
    };
  }, [ref]);
}
