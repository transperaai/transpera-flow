"use client";

// The Editor's written tour (issue #176, B18): 5 to 8 short steps that highlight each area of the Editor in turn. It opens by
// itself the first time someone opens the Editor, can be started again from "Take the tour", and once dismissed (skipped,
// finished or closed with Escape) it never opens by itself again; that is remembered per user in the database (so on any device),
// with the browser's storage as a fast copy for the same device.
// The steps and the rules are in lib/editor/tour.ts. Hook-up: `useEditorTour` in the Editor, `onTour` on its bar.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { dismissEditorTour } from "@/app/w/[slug]/tour-actions";
import { Button } from "@/components/ui/button";
import { browserStorage, dismiss, isDismissed, presentSteps, resolveTarget, tourVariant, type TourStep } from "@/lib/editor/tour";

const GAP = 10;
const PAD = 6;

interface Placement {
  /** The highlighted area, in viewport pixels. */
  box: { top: number; left: number; width: number; height: number };
  /** Where the card goes. On a narrow screen it sits at the bottom edge instead. */
  card: { top: number; left: number } | null;
}

/** Where the card goes next to a highlighted box: below it if there is room, else above, else over its top. */
function place(el: Element, cardWidth: number, cardHeight: number): Placement {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Clip the highlight to what is on screen: a tall side column shouldn't push the card off it.
  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, vh);
  const box = { top: top - PAD, left: Math.max(r.left, 0) - PAD, width: Math.min(r.right, vw) - Math.max(r.left, 0) + PAD * 2, height: Math.max(bottom - top, 24) + PAD * 2 };
  if (vw < 640) return { box, card: null };
  const clampX = (x: number) => Math.min(Math.max(x, 12), vw - cardWidth - 12);
  const below = box.top + box.height + GAP;
  const above = box.top - cardHeight - GAP;
  const beside = r.right + GAP + cardWidth + 12 <= vw ? r.right + GAP : r.left - GAP - cardWidth >= 12 ? r.left - GAP - cardWidth : null;
  if (below + cardHeight <= vh - 12) return { box, card: { top: below, left: clampX(r.left) } };
  if (above >= 12) return { box, card: { top: above, left: clampX(r.left) } };
  if (beside !== null) return { box, card: { top: Math.min(Math.max(top, 12), vh - cardHeight - 12), left: beside } };
  return { box, card: { top: Math.max(vh - cardHeight - 12, 12), left: clampX(r.left) } };
}

export interface EditorTour {
  /** Open the tour from its first step ("Take the tour"). */
  start: () => void;
  /** The tour's card and highlight: render it once, anywhere in the Editor. */
  node: React.ReactNode;
}

/**
 * The tour for an Editor: `userId` is who is signed in (null on the demo), `company` picks the shorter tour for the company map,
 * `dismissed` is whether the database says this person has already dismissed it.
 */
export function useEditorTour({ userId, company, dismissed = false }: { userId: string | null; company: boolean; dismissed?: boolean }): EditorTour {
  const variant = tourVariant(company);
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [index, setIndex] = useState(0);

  const start = useCallback(() => {
    const present = presentSteps(variant, document);
    if (!present.length) return;
    setIndex(0);
    setSteps(present);
  }, [variant]);

  // First time in the Editor: open by itself, once the screen has drawn the areas the steps point at.
  useEffect(() => {
    if (dismissed || isDismissed(browserStorage(), userId, variant)) return;
    const id = requestAnimationFrame(() => start());
    return () => cancelAnimationFrame(id);
  }, [userId, variant, dismissed, start]);

  const close = useCallback(() => {
    dismiss(browserStorage(), userId, variant);
    // Signed in: remember it on the account too. If that fails the browser's copy still holds on this device.
    if (userId) void dismissEditorTour(variant).catch(() => undefined);
    setSteps(null);
    // Focus goes back to where the tour was started from.
    requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-take-tour]")?.focus());
  }, [userId, variant]);

  return { start, node: steps ? <TourCard steps={steps} index={index} setIndex={setIndex} onClose={close} /> : null };
}

function TourCard({ steps, index, setIndex, onClose }: { steps: TourStep[]; index: number; setIndex: (i: number) => void; onClose: () => void }) {
  const step = steps[index]!;
  const last = index === steps.length - 1;
  const cardRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const measure = useCallback(() => {
    const el = resolveTarget(step, document);
    const card = cardRef.current;
    if (!el || !card) return setPlacement(null);
    setPlacement(place(el, card.offsetWidth, card.offsetHeight));
  }, [step]);

  // Bring the area into view, then outline it; follow it as the page scrolls or resizes.
  useLayoutEffect(() => {
    const el = resolveTarget(step, document);
    // "instant", not smooth: the outline is measured straight away.
    if (step.reveal && el instanceof HTMLDetailsElement) el.open = true;
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" as ScrollBehavior });
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step, measure]);

  // Escape closes the tour wherever focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus moves to the card for each step, so the keyboard carries on from there.
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>("[data-tour-next]")?.focus({ preventScroll: true });
  }, [index]);

  return (
    <>
      {placement && (
        <div
          aria-hidden
          data-tour-highlight={step.id}
          className="pointer-events-none fixed z-[60] rounded-lg ring-2 ring-accent transition-[top,left,width,height] duration-150"
          style={{ ...placement.box, boxShadow: "0 0 0 9999px var(--scrim)" }}
        />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-label="Editor tour"
        aria-describedby="editor-tour-body"
        data-tour-card
        data-tour-step={step.id}
        style={placement?.card ? { top: placement.card.top, left: placement.card.left } : undefined}
        className={`fixed z-[61] flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 rounded-lg border border-line bg-panel p-3.5 text-sm text-fg shadow-lg ${placement?.card ? "" : "right-3 bottom-3 left-3 w-auto sm:left-auto sm:w-88"}`}
      >
        <p className="text-xs font-semibold text-fg-2" data-tour-count>
          Step {index + 1} of {steps.length}
        </p>
        <h2 className="text-base font-bold">{step.title}</h2>
        <p id="editor-tour-body" className="text-fg-2">
          {step.body}
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="text-xs text-fg-2 underline" onClick={onClose} data-tour-skip>
            {last ? "Close" : "Skip the tour"}
          </button>
          <span className="flex gap-2">
            {index > 0 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setIndex(index - 1)} data-tour-back>
                Back
              </Button>
            )}
            <Button type="button" size="sm" data-tour-next onClick={() => (last ? onClose() : setIndex(index + 1))}>
              {last ? "Done" : "Next"}
            </Button>
          </span>
        </div>
      </div>
    </>
  );
}
