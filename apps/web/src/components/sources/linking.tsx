"use client";

// "+ Link" on the screens a source can be evidence for (issue #118, A53 slice 2): a page wraps what it shows in
// <SourceLinkingProvider> with the workspace's sources, links and link targets. It holds the one Add / Link source dialog the Sources
// blocks (./linking-context.tsx) open, and saves through Server Actions (live), the tab (demo) or nowhere (read only).

import { isReadOnly, type ScreenMode } from "@/lib/mode";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { linkTarget, sameTarget, type LinkTargets, type SourceLinkRow, type SourceLinkTarget, type SourceRow } from "@transpera-flow/db";
import { SourceLinkingContext, type SourceLinking } from "@/components/sources/linking-context";
import { SourceDialog, type SourceSubmission } from "@/components/sources/source-dialog";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { demoSourceStore } from "@/lib/sources/demo-store";
import { liveSourceStore } from "@/lib/sources/live-store";
import { MemorySourceStore, type SourceStore } from "@/lib/sources/store";

export interface SourceLinkingProviderProps {
  workspaceId: string;
  /** live: saved through Server Actions; demo: kept in the tab; readonly: the viewer can't change links. */
  mode: ScreenMode;
  sources: SourceRow[];
  links: SourceLinkRow[];
  targets: LinkTargets;
  children: ReactNode;
}

export function SourceLinkingProvider({ workspaceId, mode, sources: initialSources, links: initialLinks, targets: initialTargets, children }: SourceLinkingProviderProps) {
  const router = useRouter();
  const [store] = useState<SourceStore>(() =>
    mode === "live" ? liveSourceStore(workspaceId) : mode === "demo" ? demoSourceStore(workspaceId, initialSources, initialLinks) : new MemorySourceStore(workspaceId, initialSources, undefined, initialLinks),
  );
  // In the demo the store is shared by every page of the tab, so start from what it holds.
  const [state, setState] = useState(() => (mode === "demo" && store instanceof MemorySourceStore ? store.snapshot() : { sources: initialSources, links: initialLinks }));
  const [dialog, setDialog] = useState<{ target: SourceLinkTarget; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { sources, links } = state;

  // What the dialog may pick: this page's lists, plus the thing it was opened for (a step added a moment ago may not be in them yet).
  // The demo's solutions live in the tab, as on the Sources page.
  const demoSolutions = useDemoSolutions().solutions;
  const baseTargets = useMemo(
    () => (mode === "demo" ? { ...initialTargets, solutions: demoSolutions.map((x) => ({ id: x.id, name: x.name })) } : initialTargets),
    [mode, initialTargets, demoSolutions],
  );
  const targets = useMemo(() => withTarget(baseTargets, dialog), [baseTargets, dialog]);

  const linkedTo = useCallback(
    (target: SourceLinkTarget) =>
      links.flatMap((l) => {
        const t = linkTarget(l);
        const source = t && sameTarget(t, target) ? sources.find((s) => s.id === l.source_id) : undefined;
        return source ? [{ source, link: l }] : [];
      }),
    [links, sources],
  );

  const changed = () => {
    setError(null);
    // The sidebar's count comes from the server: ask for it again after a change.
    if (mode === "live") router.refresh();
  };

  const submit = async (s: SourceSubmission): Promise<string | null> => {
    if (s.kind === "add") {
      const r = await store.create(s.input, [s.link]);
      if (r.status === "error") return r.message;
      setState((c) => ({ sources: [r.source, ...c.sources], links: [...c.links, ...r.links] }));
    } else {
      const r = await store.link(s.source.id, s.link);
      if (r.status === "error") return r.message;
      setState((c) => ({ ...c, links: [...c.links, r.link] }));
    }
    changed();
    return null;
  };

  const unlink = useCallback(
    async (link: SourceLinkRow) => {
      setBusy(true);
      try {
        const r = await store.unlink(link.id);
        if (r.status === "error") return setError(r.message);
        setState((c) => ({ ...c, links: c.links.filter((l) => l.id !== link.id) }));
        changed();
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, mode],
  );

  const syncIssue = useCallback(
    async (issueId: string, sourceIds: readonly string[]) => {
      if (mode === "live") {
        // The save already took the links of removed sources away and the list's own additions make their links: ask the page again.
        router.refresh();
        return;
      }
      const target: SourceLinkTarget = { kind: "issue", issueId };
      const current = linkedTo(target);
      for (const c of current) {
        if (sourceIds.includes(c.source.id)) continue;
        const r = await store.unlink(c.link.id);
        if (r.status === "ok") setState((s) => ({ ...s, links: s.links.filter((l) => l.id !== c.link.id) }));
      }
      for (const id of sourceIds) {
        if (current.some((c) => c.source.id === id)) continue;
        const r = await store.link(id, target);
        if (r.status === "ok") setState((s) => ({ ...s, links: [...s.links, r.link] }));
      }
    },
    [mode, router, store, linkedTo],
  );

  const value = useMemo<SourceLinking>(
    () => ({
      canEdit: !isReadOnly(mode),
      sources,
      links,
      linkedTo,
      open: (target, label) => setDialog({ target, label }),
      unlink,
      syncIssue,
      error,
      busy,
    }),
    [mode, sources, links, linkedTo, unlink, syncIssue, error, busy],
  );

  const already = dialog ? new Set(linkedTo(dialog.target).map((x) => x.source.id)) : new Set<string>();
  return (
    <SourceLinkingContext.Provider value={value}>
      {children}
      {!isReadOnly(mode) && (
        <SourceDialog
          open={dialog !== null}
          targets={targets}
          preset={dialog?.target ?? null}
          presetLabel={dialog?.label}
          existingSources={sources.filter((s) => !already.has(s.id))}
          onSubmit={submit}
          onClose={() => setDialog(null)}
        />
      )}
    </SourceLinkingContext.Provider>
  );
}

/** The page's lists with the thing the dialog was opened for added when they don't have it. */
export function withTarget(targets: LinkTargets, open: { target: SourceLinkTarget; label: string } | null): LinkTargets {
  if (!open) return targets;
  const t = open.target;
  const name = open.label.replace(/^[A-Za-z ]+: /, "");
  switch (t.kind) {
    case "process":
      return targets.processes.some((p) => p.id === t.processId) ? targets : { ...targets, processes: [...targets.processes, { id: t.processId, name }] };
    case "step":
      return targets.steps.some((s) => s.id === t.stepId) ? targets : { ...targets, steps: [...targets.steps, { id: t.stepId, processId: t.processId, name }] };
    case "insight":
      return targets.insights.some((i) => i.key === t.insightKey) ? targets : { ...targets, insights: [...targets.insights, { key: t.insightKey, title: name }] };
    case "issue":
      return targets.issues.some((i) => i.id === t.issueId) ? targets : { ...targets, issues: [...targets.issues, { id: t.issueId, number: null, title: name }] };
    case "solution":
      return targets.solutions.some((s) => s.id === t.solutionId) ? targets : { ...targets, solutions: [...targets.solutions, { id: t.solutionId, name }] };
  }
}
