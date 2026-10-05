// The Editor's written tour (issue #176, B18): the steps, their words, and whether someone has dismissed it. Pure apart from the
// storage it is handed, so the steps and the "shown once" rule are unit-tested. The tour itself is components/editor/editor-tour.tsx.
//
// Each step points at a real element of the Editor by a CSS selector. A step whose element isn't on the screen (Simulate on the
// company map, Publish in a solution) is left out rather than pointing at nothing. Words are plain, per D34.

export type TourVariant = "process" | "company";

export interface TourStep {
  id: string;
  /** Open the element first if it is a folded-away list. */
  reveal?: boolean;
  /** What the step points at: the first element that matches is highlighted. Several selectors are tried in order. */
  target: string[];
  title: string;
  body: string;
}

/** The Editor's areas, in the order the tour visits them. */
const STEPS: Record<string, TourStep> = {
  palette: {
    id: "palette",
    target: ['aside[aria-label="Palette"]'],
    title: "The palette",
    body: "This is where you add things. Press + Step, + Decision or + Wait and it appears where you are looking on the map. You can also group steps, or insert a saved block.",
  },
  canvas: {
    id: "canvas",
    target: ["[data-tour=canvas]"],
    title: "The canvas",
    body: "This is the map. Drag a step to move it. To connect two steps, drag from the dot on the edge of one to the other. Double-click an empty spot to add a step there.",
  },
  inspector: {
    id: "inspector",
    target: ['aside[aria-label="Inspector"]'],
    title: "The inspector",
    body: "Click a step and its details show here: its name, who does it, how long it takes and how it is cited. Change a value and it saves to your draft straight away.",
  },
  checklist: {
    id: "checklist",
    target: ["[data-missing-for-simulation]"],
    // The list is folded away until it is opened: the tour opens it so the step shows what it talks about.
    reveal: true,
    title: "The assumptions checklist",
    body: "Missing for simulation lists what the map still has no real figure for: a role, a time, a wait, odds on a branch or how many arrive. Click one to go to that step, then fill it in or cite a source.",
  },
  draft: {
    id: "draft",
    target: ["[data-tour=draft]"],
    title: "Your draft",
    body: "You are working on a draft. The live map doesn't change until you publish. Steps you have added or changed are marked on the map; select one to see what changed in the inspector, and undo it if you like.",
  },
  simulate: {
    id: "simulate",
    target: ["[data-tour=simulate]"],
    title: "Simulate",
    body: "Press Simulate to run your draft 30 times and compare it with the live version. Nothing is published. Use it to check a change helps before you commit to it.",
  },
  publish: {
    id: "publish",
    target: ["[data-tour=publish]"],
    title: "Publish",
    body: "Publish makes your draft the new live version. You are asked first, and nothing is lost: the old version is kept.",
  },
  publishCompany: {
    id: "publish",
    target: ["[data-tour=publish]"],
    title: "Publish",
    body: "Publish makes your draft the new live company map. You are asked first, and the old version is kept in History so you can restore it.",
  },
  history: {
    id: "history",
    target: ["[data-tour=history]"],
    title: "History",
    body: "History keeps every published version, with what changed. If a change turns out wrong, open History here, pick an older version and restore it.",
  },
  historyCompany: {
    id: "history",
    target: ["[data-tour=history]"],
    title: "History",
    body: "History keeps every published version of the map, with what changed. If a change turns out wrong, open History here, pick an older version and restore it.",
  },
};

const ORDER: Record<TourVariant, string[]> = {
  process: ["palette", "canvas", "inspector", "checklist", "draft", "simulate", "publish", "history"],
  // The company map is a picture of the business: nothing to simulate and no assumptions to check, so the tour is shorter.
  company: ["palette", "canvas", "inspector", "draft", "publishCompany", "historyCompany"],
};

export const tourVariant = (company: boolean): TourVariant => (company ? "company" : "process");

/** The tour's steps for a variant, in order. */
export const tourSteps = (variant: TourVariant): TourStep[] => ORDER[variant].map((k) => STEPS[k]!);

/** The first selector of a step that matches something, and what it matched; null when the step points at nothing. */
export function resolveTarget(step: TourStep, root: Pick<ParentNode, "querySelector">): Element | null {
  for (const selector of step.target) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

/** The steps that point at something on the screen now. */
export const presentSteps = (variant: TourVariant, root: Pick<ParentNode, "querySelector">): TourStep[] => tourSteps(variant).filter((s) => resolveTarget(s, root));

/** The slice of `Storage` the tour uses. */
export type TourStorage = Pick<Storage, "getItem" | "setItem">;

/** Dismissal is stored per user (and per variant: the company map's shorter tour is its own): a signed-out demo is "demo". */
export const tourKey = (userId: string | null, variant: TourVariant) => `transpera.editor-tour.v1.${userId ?? "demo"}.${variant}`;

/** Whether this user has dismissed this tour. Storage that can't be read counts as not dismissed. */
export function isDismissed(storage: TourStorage | null, userId: string | null, variant: TourVariant): boolean {
  try {
    return storage?.getItem(tourKey(userId, variant)) === "dismissed";
  } catch {
    return false;
  }
}

/** Remember that this user dismissed the tour, so it doesn't open by itself again. */
export function dismiss(storage: TourStorage | null, userId: string | null, variant: TourVariant): void {
  try {
    storage?.setItem(tourKey(userId, variant), "dismissed");
  } catch {
    // Private windows and blocked storage: the tour will open again next time, which is harmless.
  }
}

/** The browser's storage, or null where it isn't there or throws on access. */
export function browserStorage(): TourStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
