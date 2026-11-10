"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The width of an element in CSS pixels, kept up to date as it resizes: the one hook the hand-drawn SVG charts (Sandbox, Capacity, Forecast) size
 * themselves with, so their text stays at its real size instead of being scaled with a viewBox. 0 until the element has been measured.
 */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
