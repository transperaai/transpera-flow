// The Editor's three modes (issue #104): one screen, with the hint under the title and the save buttons depending on
// what is being edited. `draft`, `block` (A51) and `solution` (A49) are all built: the draft is the process's single draft,
// and a block or a solution edits a copy in memory that is saved on its own, never into the draft (D18).

import { horizonWeeks, isHorizonMonths } from "@/lib/horizon";

export const EDITOR_MODES = ["draft", "solution", "block"] as const;
export type EditorMode = (typeof EDITOR_MODES)[number];

export interface ModeInfo {
  /** The screen's title: what is being edited. */
  title: (subject: string) => string;
  /** The line under the title: what the mode is and what it won't change. */
  hint: string;
  /** The buttons that save, in order; "draft" has two, the others one. */
  save: { id: "save-draft" | "publish" | "save-solution" | "save-block"; label: string; primary: boolean }[];
  /** Whether the mode is built yet. */
  available: boolean;
  /** Where its save buttons come from when it isn't (a ticket), for the tooltip. */
  arrivesWith?: string;
}

export const MODE_INFO: Record<EditorMode, ModeInfo> = {
  draft: {
    title: (subject) => `Draft of ${subject}`,
    hint: "You're editing a draft. The live map doesn't change until you publish. Publishing keeps the old version in History.",
    save: [
      { id: "save-draft", label: "Save draft", primary: false },
      { id: "publish", label: "Publish…", primary: true },
    ],
    available: true,
  },
  solution: {
    title: (subject) => `New solution · ${subject}`,
    hint: "Change the steps, then save. Every solution fixes an issue, so pick the issue first. Solutions never change the live map.",
    save: [{ id: "save-solution", label: "Save solution", primary: true }],
    available: true,
  },
  block: {
    title: () => "New block",
    hint: "Build a bundle of steps. Save it to the library and reuse it in any solution or process.",
    save: [{ id: "save-block", label: "Save to library", primary: true }],
    available: true,
  },
};

/** Solution mode built for an issue (A49): the title names the issue, and the hint says what the red outline is. */
export const SOLUTION_FOR_ISSUE = {
  title: (issue: { number: number | null; title: string }) => `Solution for ${issue.number == null ? "issue" : `#${issue.number}`} · ${issue.title}`,
  hint: "The red outline is the area this issue touches. Select a step or group, then replace it with a block or edit it. Solutions are saved on their own and never change the live map.",
};

/** What a save says when the solution is linked to no issue (Q12: every solution starts from an issue). */
export const NO_ISSUE_REFUSAL =
  "Pick the issue this solution fixes. To change the process without an issue, edit the process itself (a new draft), or save the steps to the Block library.";

/** The issue a `?issue=` names, if it looks like an id. */
export function parseIssueParam(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
}

/** The months a `?horizon=` names (the map's picker, carried into the Editor), or null for the model's own horizon. */
export function parseHorizon(value: string | string[] | undefined): number | null {
  const v = Array.isArray(value) ? value[0] : value;
  const n = Number(v);
  return v && isHorizonMonths(n) ? n : null;
}

/** The Editor's address with the map's horizon kept, if one was picked. */
export function withHorizon(href: string, months: number | null): string {
  return months === null ? href : `${href}${href.includes("?") ? "&" : "?"}horizon=${months}`;
}

/** The mode a `?mode=` parameter names; anything else is a draft. */
export function parseEditorMode(value: string | string[] | undefined): EditorMode {
  const v = Array.isArray(value) ? value[0] : value;
  return (EDITOR_MODES as readonly string[]).includes(v ?? "") ? (v as EditorMode) : "draft";
}

/**
 * Where Exit editor goes: the page the editor was opened from (`?from=`) if it is a page of this app, else `fallback`.
 * Only a path on this site is followed, never another address.
 */
export function exitHref(from: string | string[] | undefined, fallback: string): string {
  const v = Array.isArray(from) ? from[0] : from;
  if (!v) return fallback;
  // Resolve the way a browser does (it drops tabs and newlines, reads `\` as `/`), and follow only what stays on this site.
  const base = "http://self.invalid";
  try {
    const u = new URL(v, base);
    return u.origin === base && u.pathname.startsWith("/") && !u.pathname.startsWith("//") ? u.pathname + u.search + u.hash : fallback;
  } catch {
    return fallback;
  }
}

/** `/demo/edit` and `/w/<workspace>/p/<process>/edit`: the pages that are the Editor, which show no sidebar. */
export const isEditorPath = (path: string | null): boolean => !!path && /^\/(demo|w\/[^/]+\/p\/[^/]+)\/edit\/?$/.test(path);

/**
 * The horizon the Editor simulates at, in weeks, or null for the model's own. A solution is always simulated at the model's own, as the
 * server checks it when it is saved, so the footer's verdict matches the stored one; the map's picked horizon applies to drafts and blocks.
 */
export const editorHorizonWeeks = (mode: EditorMode, months: number | null): number | null => (mode === "solution" || months === null ? null : horizonWeeks(months));
