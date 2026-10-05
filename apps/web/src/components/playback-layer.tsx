"use client";

// The playback overlay (issue #14): tokens on the edges and queues in front of
// steps, drawn from the trace index for the clock's time. One SVG layer between
// the edges and the cards holds every token as a pooled <circle>, and one layer
// above the cards holds a count badge per step; both are updated in place from
// requestAnimationFrame, never by re-rendering React. Both sit in React Flow's
// viewport, so they pan and zoom with the map for free, and token positions
// come from the edge paths React Flow drew (curved, back edges, swimlanes).

import { EdgeLabelRenderer, ViewportPortal, useStoreApi } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import type { PlaybackClock } from "@/lib/playback/clock";
import { QUEUE_MAX_DRAWN, pointAlong, queueSlot, samplePath, type SampledPath } from "@/lib/playback/paths";
import type { PlaybackIndex } from "@/lib/playback/trace-index";
import { countsOf, type PlaybackStep } from "@/lib/playback/use-playback";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Reduced motion: the clock moves in whole steps this often, never smoothly. */
const REDUCED_STEP_SECONDS = 0.5;

interface LayerProps {
  clock: PlaybackClock;
  index: PlaybackIndex;
  steps: PlaybackStep[];
  bottleneck: string | null;
  /** No moving tokens: queues and counts only, frame by frame. */
  reducedMotion: boolean;
}

export function PlaybackLayer({ clock, index, steps, bottleneck, reducedMotion }: LayerProps) {
  const store = useStoreApi();
  // The portals mount once React Flow has its DOM, so the layers arrive after the first render.
  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const [badgeRoot, setBadgeRoot] = useState<HTMLDivElement | null>(null);
  // Latest props for the loop, without restarting it.
  const props = useRef({ index, steps, bottleneck, reducedMotion });
  const redrawRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    props.current = { index, steps, bottleneck, reducedMotion };
    // A new run, a change of steps or of motion preference: draw again.
    redrawRef.current?.();
  }, [index, steps, bottleneck, reducedMotion]);

  useEffect(() => {
    if (!svg || !badgeRoot) return;
    const pool: SVGCircleElement[] = [];
    const paths = new Map<string, { el: SVGPathElement; sampled: SampledPath | null }>();
    const badges = new Map<string, { el: HTMLDivElement; text: string; x: number; y: number; crit: boolean }>();
    const pt = { x: 0, y: 0 };

    const circle = (i: number): SVGCircleElement => {
      let c = pool[i];
      if (!c) {
        c = document.createElementNS(SVG_NS, "circle");
        c.setAttribute("r", "5");
        svg.appendChild(c);
        pool.push(c);
      }
      if (c.style.display) c.style.display = "";
      return c;
    };
    const place = (c: SVGCircleElement, x: number, y: number, cls: string) => {
      c.setAttribute("cx", x.toFixed(1));
      c.setAttribute("cy", y.toFixed(1));
      if (c.getAttribute("class") !== cls) c.setAttribute("class", cls);
    };

    /** The drawn path of an edge, sampled; re-sampled when React Flow redraws it. */
    const pathOf = (edge: string): SampledPath | null => {
      let entry = paths.get(edge);
      if (!entry || !entry.el.isConnected) {
        const el = store
          .getState()
          .domNode?.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${CSS.escape(edge)}"] path.react-flow__edge-path`);
        if (!el) return null;
        entry = { el, sampled: null };
        paths.set(edge, entry);
      }
      const d = entry.el.getAttribute("d") ?? "";
      if (!entry.sampled || entry.sampled.d !== d) entry.sampled = d ? samplePath(entry.el, d) : null;
      return entry.sampled;
    };

    const badge = (id: string) => {
      let b = badges.get(id);
      if (!b) {
        const el = document.createElement("div");
        el.className = "playback-badge";
        badgeRoot.appendChild(el);
        b = { el, text: "", x: NaN, y: NaN, crit: false };
        badges.set(id, b);
      }
      return b;
    };

    const draw = () => {
      const { index, steps, bottleneck, reducedMotion } = props.current;
      // Steps inside a closed group queue on the card that holds them.
      const drawnAs = new Map<string, string>();
      for (const s of steps) for (const m of s.members ?? []) drawnAs.set(m, s.id);
      const { active } = clock.getState();
      svg.style.display = active ? "" : "none";
      badgeRoot.style.display = active ? "" : "none";
      if (!active) return;
      const t = clock.t;
      const frame = index.frame(t, reducedMotion ? 0 : clock.hop);
      const { nodeLookup } = store.getState();
      let n = 0;
      // Reduced motion: nothing travels; waits and queues show as counts and stacked dots.
      for (const tok of reducedMotion ? [] : frame.moving) {
        const path = pathOf(tok.edge);
        if (!path) continue;
        pointAlong(path, tok.progress, pt);
        place(circle(n++), pt.x, pt.y, tok.outcome === "lost" ? "playback-token lost" : "playback-token");
      }
      for (const [step, ids] of frame.queued) {
        const node = nodeLookup.get(drawnAs.get(step) ?? step);
        if (!node) continue;
        const { x, y } = node.internals.positionAbsolute;
        const height = node.measured.height ?? 0;
        const shown = Math.min(ids.length, QUEUE_MAX_DRAWN);
        for (let i = 0; i < shown; i++) {
          queueSlot(i, { x, y, height }, pt);
          place(circle(n++), pt.x, pt.y, "playback-token queued");
        }
      }
      for (let i = n; i < pool.length; i++) if (pool[i]!.style.display !== "none") pool[i]!.style.display = "none";

      const seen = new Set<string>();
      for (const s of steps) {
        const node = nodeLookup.get(s.id);
        if (!node) continue;
        let text: string;
        if (s.kind === "end") {
          const done = index.endedBy(s.id, t);
          text = done ? String(done) : "";
        } else {
          const c = countsOf(index, s, t);
          text = [c.queued && `${c.queued} queued`, c.service && `${c.service} active`, c.waiting && `${c.waiting} waiting`]
            .filter(Boolean)
            .join(" · ");
        }
        if (!text) continue;
        seen.add(s.id);
        const b = badge(s.id);
        const { x, y } = node.internals.positionAbsolute;
        if (b.text !== text) {
          b.el.textContent = text;
          b.text = text;
        }
        if (b.x !== x || b.y !== y) {
          b.el.style.transform = `translate(${x + 6}px, ${y}px) translateY(-60%)`;
          b.x = x;
          b.y = y;
        }
        const crit = s.id === bottleneck;
        if (b.crit !== crit) {
          b.el.classList.toggle("crit", crit);
          b.crit = crit;
        }
        if (b.el.style.display) b.el.style.display = "";
      }
      for (const [id, b] of badges) if (!seen.has(id) && b.el.style.display !== "none") b.el.style.display = "none";
    };

    let raf = 0;
    let last = 0;
    let pending = 0;
    let ticking = false;
    const loop = (now: number) => {
      raf = 0;
      if (!clock.getState().playing) return;
      // A long gap (a background tab) doesn't jump the clock.
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      const before = clock.t;
      ticking = true;
      if (props.current.reducedMotion) {
        pending += dt;
        if (pending >= REDUCED_STEP_SECONDS) {
          clock.advance(pending);
          pending = 0;
        }
      } else clock.advance(dt);
      ticking = false;
      if (clock.t !== before) draw();
      if (clock.getState().playing) raf = requestAnimationFrame(loop);
    };
    /** Draw once on the next frame (while paused: a scrub, a pan, an edit). */
    let queued = 0;
    const redraw = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        draw();
      });
    };
    const start = () => {
      if (clock.getState().playing && !raf) {
        last = 0;
        pending = 0;
        raf = requestAnimationFrame(loop);
      }
    };
    // A scrub; the loop draws its own ticks.
    const offTime = clock.onTime(() => {
      if (!ticking) redraw();
    });
    const offState = clock.subscribe(() => {
      start();
      redraw();
    });
    // Nodes moved, edges redrawn: draw again (paths are re-read then). The loop covers this while playing.
    const offStore = store.subscribe(() => {
      if (!raf) redraw();
    });
    start();
    redraw();
    redrawRef.current = redraw;
    return () => {
      offTime();
      offState();
      offStore();
      cancelAnimationFrame(raf);
      cancelAnimationFrame(queued);
      redrawRef.current = null;
      for (const c of pool) c.remove();
      for (const b of badges.values()) b.el.remove();
    };
  }, [clock, store, svg, badgeRoot]);

  return (
    <>
      <EdgeLabelRenderer>
        <svg ref={setSvg} aria-hidden className="playback-tokens" width={1} height={1} />
      </EdgeLabelRenderer>
      <ViewportPortal>
        <div ref={setBadgeRoot} aria-hidden className="playback-badges" />
      </ViewportPortal>
    </>
  );
}
