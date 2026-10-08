"use client";

// Issue badges on the steps of the process map (issue #17). Rendered into
// React Flow's node elements through portals, so the canvas component itself
// needs no change: the badge finds each node by its `data-id` and follows it
// as nodes are added, removed or re-rendered.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { StepBadge } from "@/lib/issues/register";
import { ISSUE_PILL_CLASS } from "@/lib/map/tile";

export function StepIssueBadges({ badges, onOpen }: { badges: Record<string, StepBadge>; onOpen: (stepId: string) => void }) {
  const [hosts, setHosts] = useState<[string, HTMLElement][]>([]);
  const ids = Object.keys(badges).sort().join(",");

  useEffect(() => {
    const map = document.querySelector("[data-process-map]");
    if (!map) return;
    const wanted = new Set(ids ? ids.split(",") : []);
    const scan = () => {
      const found: [string, HTMLElement][] = [];
      map.querySelectorAll<HTMLElement>(".react-flow__node[data-id]").forEach((el) => {
        const id = el.dataset.id;
        if (id && wanted.has(id)) found.push([id, el]);
      });
      setHosts((prev) => (prev.length === found.length && prev.every(([id, el], i) => found[i]![0] === id && found[i]![1] === el) ? prev : found));
    };
    scan();
    // Nodes mount, unmount and re-render as the map changes; badges follow.
    const observer = new MutationObserver(scan);
    observer.observe(map, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [ids]);

  return hosts.map(([id, el]) => {
    const b = badges[id];
    if (!b) return null;
    const label = `${b.count} confirmed issue${b.count === 1 ? "" : "s"}: ${b.titles.join("; ")}`;
    return createPortal(
      <button
        type="button"
        data-issue-badge={id}
        title={label}
        aria-label={`${label}. Show in the Issues tab.`}
        // nodrag/nopan: React Flow leaves pointer events on the badge alone.
        className={`nodrag nopan ${ISSUE_PILL_CLASS}`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen(id);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {b.count} {b.count === 1 ? "issue" : "issues"}
      </button>,
      el,
      id,
    );
  });
}
