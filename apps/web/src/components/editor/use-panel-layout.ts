"use client";

// The Editor's side panels (palette on the left, inspector on the right): whether each is folded to a narrow rail, and how wide
// the inspector is. Kept per browser in localStorage, so the Editor opens the way it was left. Storage that is missing or throws
// (private windows, blocked site data) just means the default layout.

import { useCallback, useMemo, useSyncExternalStore } from "react";

/** The inspector's width can be dragged between these (px). */
export const INSPECTOR_MIN = 320;
export const INSPECTOR_MAX = 420;
const INSPECTOR_DEFAULT = 360;
const KEY = "transpera.editor-panels.v1";

export interface PanelLayout {
  paletteCollapsed: boolean;
  inspectorCollapsed: boolean;
  inspectorWidth: number;
}

const DEFAULT: PanelLayout = { paletteCollapsed: false, inspectorCollapsed: false, inspectorWidth: INSPECTOR_DEFAULT };

export const clampInspector = (px: number) => Math.round(Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, px)));

/** What was stored, checked field by field; anything odd falls back to the default. */
export function readLayout(raw: string | null): PanelLayout {
  if (!raw) return DEFAULT;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof PanelLayout, unknown>>;
    return {
      paletteCollapsed: v.paletteCollapsed === true,
      inspectorCollapsed: v.inspectorCollapsed === true,
      inspectorWidth: typeof v.inspectorWidth === "number" && Number.isFinite(v.inspectorWidth) ? clampInspector(v.inspectorWidth) : INSPECTOR_DEFAULT,
    };
  } catch {
    return DEFAULT;
  }
}

// The layout as stored, held here too so it still changes where storage throws. `undefined` until first read.
let held: string | null | undefined;
const listeners = new Set<() => void>();

function stored(): string | null {
  if (held === undefined) {
    try {
      held = window.localStorage.getItem(KEY);
    } catch {
      held = null;
    }
  }
  return held;
}

function store(next: PanelLayout) {
  held = JSON.stringify(next);
  try {
    window.localStorage.setItem(KEY, held);
  } catch {
    // Not remembered past this page; harmless.
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function usePanelLayout() {
  // The server (and the first client render, while hydrating) draws the default layout; the stored one follows.
  const raw = useSyncExternalStore(subscribe, stored, () => null);
  const layout = useMemo(() => readLayout(raw), [raw]);
  const update = useCallback((change: (was: PanelLayout) => Partial<PanelLayout>) => {
    const was = readLayout(stored());
    store({ ...was, ...change(was) });
  }, []);
  return {
    layout,
    togglePalette: useCallback(() => update((was) => ({ paletteCollapsed: !was.paletteCollapsed })), [update]),
    toggleInspector: useCallback(() => update((was) => ({ inspectorCollapsed: !was.inspectorCollapsed })), [update]),
    setInspectorWidth: useCallback((px: number) => update(() => ({ inspectorWidth: clampInspector(px) })), [update]),
  };
}
