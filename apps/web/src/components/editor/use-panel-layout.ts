"use client";

// The Editor's side panels (palette on the left, inspector on the right): whether each is folded to a narrow rail, and how wide
// the inspector is. Kept per browser in localStorage, so the Editor opens the way it was left. Storage that is missing or throws
// (private windows, blocked site data) just means the default layout.

import { useCallback, useEffect, useState } from "react";

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

export function usePanelLayout() {
  const [layout, setLayout] = useState<PanelLayout>(DEFAULT);
  // Read after the first render, so the server's HTML and the first client render agree.
  useEffect(() => {
    try {
      setLayout(readLayout(window.localStorage.getItem(KEY)));
    } catch {
      // No storage: keep the default.
    }
  }, []);
  // The new layout is stored as it is set. Writing to storage from the updater is idempotent, so a doubled call in Strict Mode is harmless.
  const update = useCallback((change: (was: PanelLayout) => Partial<PanelLayout>) => {
    setLayout((was) => {
      const next = { ...was, ...change(was) };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Not remembered this time; harmless.
      }
      return next;
    });
  }, []);
  return {
    layout,
    togglePalette: useCallback(() => update((was) => ({ paletteCollapsed: !was.paletteCollapsed })), [update]),
    toggleInspector: useCallback(() => update((was) => ({ inspectorCollapsed: !was.inspectorCollapsed })), [update]),
    setInspectorWidth: useCallback((px: number) => update(() => ({ inspectorWidth: clampInspector(px) })), [update]),
  };
}
