// A map as an image (issue #39, B10): the process map or the company map drawn as a standalone SVG with a title and a
// legend, from the same steps, lines, ratings and badges the canvas is fed, with groups open or closed as they are on
// screen. PNG is that SVG drawn at 2x in the browser. Pure and string-in, string-out: every piece of text is escaped, so a
// step named `</text><script>` is only ever text.
//
// Colours are the page's own tokens, read at export time (`readPalette` in the browser), so the image matches the theme
// on screen; `LIGHT_PALETTE` is the fallback and what the tests use.

import { childrenOf, isGroup, type EdgeRow, type StepRow } from "@transpera-flow/db";
import { RATING_LABELS, type Rating } from "@transpera-flow/engine";
import { formatHours } from "@/lib/format";
import { CARD_SIZE, GROUP_CARD, GROUP_PADDING, TERMINAL_SIZE, openGroupSize, type Size } from "@/lib/map/groups";
import { LEGEND_ORDER } from "@/lib/map/rating";

export interface MapPalette {
  background: string;
  panel: string;
  panel2: string;
  line: string;
  line2: string;
  fg: string;
  fg2: string;
  fg3: string;
  crit: string;
  rate: Record<Rating, { stripe: string; soft: string }>;
}

/** The light theme's tokens (src/styles/tokens.css), as plain colours. */
export const LIGHT_PALETTE: MapPalette = {
  background: "#ffffff",
  panel: "#ffffff",
  panel2: "#f7f7f7",
  line: "#e5e5e5",
  line2: "#d4d4d4",
  fg: "#0a0a0a",
  fg2: "#525252",
  fg3: "#6f6f6f",
  crit: "#e34948",
  rate: {
    great: { stripe: "#2f9e60", soft: "#e6f4ec" },
    good: { stripe: "#c9a227", soft: "#faf3d9" },
    bad: { stripe: "#e0781f", soft: "#fcebdb" },
    risk: { stripe: "#e34948", soft: "#fbe4e4" },
  },
};

export interface MapImageInput {
  /** The map's name, drawn above it ("Intake", "Company map"). */
  title: string;
  /** What the canvas draws: its steps (groups included) and lines. */
  steps: readonly StepRow[];
  edges: readonly EdgeRow[];
  /** Groups drawn open (`"all"` for every one); the rest are closed cards with a roll-up. */
  expanded?: ReadonlySet<string> | "all";
  /** A step's rating colour, from its confirmed issues (a closed group takes the worst inside it); null: plain. */
  rating?: (stepId: string) => Rating | null;
  /** Confirmed open issues per step: the red number on a card. */
  issues?: Readonly<Record<string, number>>;
  /** Who does a step: a role or person name by id. */
  who?: (step: StepRow) => string | null;
  /** The company map's lines are handoffs with a label; a process's are shares of the work. */
  handoffs?: boolean;
  /** Shown under the title, e.g. "Live, version 3". */
  subtitle?: string;
  /** The date drawn in the footer, ISO. */
  date: string;
  palette?: MapPalette;
}

export interface MapImage {
  svg: string;
  width: number;
  height: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const PAD = 32;
const HEADER = 56;
const LEGEND = 56;
/** The legend's items, in order, and how wide the row is (each swatch, its label, a gap). The image is never narrower than the row. */
const LEGEND_LABELS = [...LEGEND_ORDER.map((r) => RATING_LABELS[r]), "Nothing to fix", "Confirmed issues"];
const legendWidth = (): number => LEGEND_LABELS.reduce((n, l) => n + 18 + l.length * 6.6 + 18, 0);
const FOOTER = (date: string) => `Coloured by the worst rating among a step's confirmed open issues. Exported ${date} from Transpera Flow.`;

/** Words wrapped to lines of at most `chars` characters (a long word is cut), at most `max` lines, the last ending in an ellipsis. */
export function wrapText(text: string, chars: number, max: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (let w of words) {
    while (w.length > chars) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      lines.push(w.slice(0, chars));
      w = w.slice(chars);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= chars) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > max) {
    const kept = lines.slice(0, max);
    const last = kept[max - 1]!;
    kept[max - 1] = `${last.length >= chars ? last.slice(0, chars - 1) : last}…`;
    return kept;
  }
  return lines;
}

interface Box {
  step: StepRow;
  x: number;
  y: number;
  w: number;
  h: number;
  open: boolean;
  /** The group it sits in, for drawing order. */
  depth: number;
}

/** Every drawn box in absolute map coordinates, and the nearest drawn ancestor of each step (a hidden step maps to its closed group). */
function layout(steps: readonly StepRow[], expanded: ReadonlySet<string> | "all"): { boxes: Box[]; at: Map<string, Box> } {
  const kids = childrenOf(steps);
  const boxes: Box[] = [];
  const at = new Map<string, Box>();
  const isOpen = (id: string) => expanded === "all" || expanded.has(id);
  const place = (s: StepRow, ox: number, oy: number, depth: number, hiddenIn: Box | null, seen: ReadonlySet<string>): void => {
    if (hiddenIn) {
      at.set(s.id, hiddenIn);
      if (isGroup(s) && !seen.has(s.id)) for (const k of kids.get(s.id) ?? []) place(k, 0, 0, depth + 1, hiddenIn, new Set([...seen, s.id]));
      return;
    }
    const x = ox + Number(s.x);
    const y = oy + Number(s.y);
    if (isGroup(s)) {
      const open = isOpen(s.id) && !seen.has(s.id);
      const size: Size = open ? openGroupSize(steps, s.id, expanded) : GROUP_CARD;
      const box: Box = { step: s, x, y, w: size.width, h: size.height, open, depth };
      boxes.push(box);
      at.set(s.id, box);
      const next = new Set([...seen, s.id]);
      for (const k of kids.get(s.id) ?? []) place(k, x, y, depth + 1, open ? null : box, next);
      return;
    }
    const size = s.kind === "start" || s.kind === "end" ? TERMINAL_SIZE : CARD_SIZE;
    const box: Box = { step: s, x, y, w: size.width, h: size.height, open: false, depth };
    boxes.push(box);
    at.set(s.id, box);
  };
  for (const s of kids.get(null) ?? []) place(s, 0, 0, 0, null, new Set());
  return { boxes, at };
}

/** How many steps are inside a group, at any depth (not counting groups themselves). */
function stepsInside(kids: Map<string | null, StepRow[]>, id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  return (kids.get(id) ?? []).reduce((n, s) => n + (isGroup(s) ? stepsInside(kids, s.id, seen) : 1), 0);
}

const rank = (r: Rating): number => LEGEND_ORDER.length - 1 - LEGEND_ORDER.indexOf(r);

/** Every step inside a group, at any depth. */
function descendants(kids: Map<string | null, StepRow[]>, id: string, seen = new Set<string>()): string[] {
  if (seen.has(id)) return [];
  seen.add(id);
  return (kids.get(id) ?? []).flatMap((s) => [s.id, ...descendants(kids, s.id, seen)]);
}

export function buildMapImage(input: MapImageInput): MapImage {
  const p = input.palette ?? LIGHT_PALETTE;
  const expanded = input.expanded ?? new Set<string>();
  const kids = childrenOf(input.steps);
  const { boxes, at } = layout(input.steps, expanded);

  const minX = boxes.length ? Math.min(...boxes.map((b) => b.x)) : 0;
  const minY = boxes.length ? Math.min(...boxes.map((b) => b.y)) : 0;
  const maxX = boxes.length ? Math.max(...boxes.map((b) => b.x + b.w)) : 0;
  const maxY = boxes.length ? Math.max(...boxes.map((b) => b.y + b.h)) : 0;
  const mapW = Math.max(0, maxX - minX);
  const mapH = Math.max(0, maxY - minY);
  const width = Math.round(Math.max(legendWidth(), FOOTER(input.date).length * 5.8, mapW) + PAD * 2);
  const height = Math.round(HEADER + mapH + PAD + LEGEND + 24);
  // The map is centred when it is narrower than the legend row.
  const dx = PAD + (width - PAD * 2 - mapW) / 2 - minX;
  const dy = HEADER + PAD / 2 - minY;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(FONT)}">`);
  out.push(`<title>${esc(input.title)}</title>`);
  out.push(
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${p.line2}"/></marker></defs>`,
  );
  out.push(`<rect width="${width}" height="${height}" fill="${p.background}"/>`);
  out.push(`<text x="${PAD}" y="34" font-size="20" font-weight="700" fill="${p.fg}">${esc(input.title)}</text>`);
  if (input.subtitle) out.push(`<text x="${PAD}" y="52" font-size="12" fill="${p.fg2}">${esc(input.subtitle)}</text>`);

  // Open groups first (so what is inside draws over them), shallow before deep.
  const groupsOpen = boxes.filter((b) => b.open).sort((a, b) => a.depth - b.depth);
  for (const b of groupsOpen) {
    const x = b.x + dx;
    const y = b.y + dy;
    out.push(`<g data-group="${esc(b.step.id)}"><rect x="${x}" y="${y}" width="${b.w}" height="${b.h}" rx="10" fill="${p.panel2}" stroke="${p.line2}" stroke-dasharray="5 4"/>`);
    out.push(`<text x="${x + 14}" y="${y + 24}" font-size="13" font-weight="700" fill="${p.fg}">${esc(wrapText(b.step.name, Math.floor((b.w - 28) / 7.5), 1)[0] ?? "")}</text></g>`);
  }

  // Lines between what is drawn; a line into a closed group goes to the group's card. Duplicates and loops inside one card are dropped.
  const labels: string[] = [];
  const seenLine = new Set<string>();
  for (const e of input.edges) {
    const a = at.get(e.from_step_id);
    const z = at.get(e.to_step_id);
    if (!a || !z || a === z) continue;
    const key = `${a.step.id}>${z.step.id}>${e.label ?? ""}>${e.probability}`;
    if (seenLine.has(key)) continue;
    seenLine.add(key);
    const x1 = a.x + a.w + dx;
    const y1 = a.y + a.h / 2 + dy;
    const x2 = z.x + dx;
    const y2 = z.y + z.h / 2 + dy;
    const bend = Math.max(24, Math.abs(x2 - x1) / 2);
    out.push(`<path d="M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}" fill="none" stroke="${p.line2}" stroke-width="1.5" marker-end="url(#arrow)"/>`);
    const text = input.handoffs ? (e.label ?? "") : [Number(e.probability) < 1 ? `${Math.round(Number(e.probability) * 100)}%` : null, e.condition_tag].filter(Boolean).join(" · ");
    if (text) {
      const t = wrapText(text, 16, 1)[0] ?? "";
      // At the middle of the curve, where branches of one step have already parted; a halo keeps it readable over a line.
      labels.push(`<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" font-size="11" text-anchor="middle" fill="${p.fg2}" stroke="${p.background}" stroke-width="4" paint-order="stroke">${esc(t)}</text>`);
    }
  }

  for (const b of boxes) {
    if (b.open) continue;
    const s = b.step;
    const x = b.x + dx;
    const y = b.y + dy;
    // A closed group takes the worst rating and the sum of the issues of the steps inside it, as on the canvas.
    const ids = isGroup(s) ? [s.id, ...descendants(kids, s.id)] : [s.id];
    const rated = ids.map((id) => input.rating?.(id) ?? null).reduce<Rating | null>((worst, r) => (r && (!worst || rank(r) > rank(worst)) ? r : worst), null);
    const count = ids.reduce((n, id) => n + (input.issues?.[id] ?? 0), 0);
    if (s.kind === "start" || s.kind === "end") {
      out.push(`<g data-step="${esc(s.id)}"><rect x="${x}" y="${y}" width="${b.w}" height="${b.h}" rx="${b.h / 2}" fill="${p.panel2}" stroke="${p.line2}"/>`);
      out.push(`<text x="${x + b.w / 2}" y="${y + b.h / 2 + 4.5}" font-size="13" font-weight="600" text-anchor="middle" fill="${p.fg}">${esc(wrapText(s.name || (s.kind === "start" ? "Start" : "End"), 12, 1)[0] ?? "")}</text></g>`);
      continue;
    }
    const closedGroup = isGroup(s);
    const fill = rated ? p.rate[rated].soft : p.panel;
    out.push(`<g data-step="${esc(s.id)}"${rated ? ` data-rating="${rated}"` : ""}>`);
    out.push(`<rect x="${x}" y="${y}" width="${b.w}" height="${b.h}" rx="8" fill="${fill}" stroke="${p.line2}"/>`);
    if (rated) out.push(`<rect x="${x}" y="${y + 4}" width="5" height="${b.h - 8}" rx="2.5" fill="${p.rate[rated].stripe}"/>`);
    const tx = x + 16;
    const nameLines = wrapText(s.name, 20, 2);
    nameLines.forEach((l, i) => out.push(`<text x="${tx}" y="${y + 24 + i * 16}" font-size="13.5" font-weight="700" fill="${p.fg}">${esc(l)}</text>`));
    const below = y + 24 + (nameLines.length - 1) * 16;
    if (closedGroup) {
      const n = stepsInside(kids, s.id);
      out.push(`<text x="${tx}" y="${below + 20}" font-size="12" fill="${p.fg2}">${n} ${n === 1 ? "step" : "steps"} inside</text>`);
    } else {
      const who = input.who?.(s) ?? (s.kind === "decision" ? "Decision" : s.kind === "wait" ? "Wait" : null);
      if (who) out.push(`<text x="${tx}" y="${below + 19}" font-size="12" fill="${p.fg2}">${esc(wrapText(who, 26, 1)[0] ?? "")}</text>`);
      const work = Number(s.work_hours) ? `${formatHours(Number(s.work_hours))} work` : "";
      const wait = Number(s.wait_hours) ? `${formatHours(Number(s.wait_hours))} wait` : "";
      if (work || wait) out.push(`<text x="${tx}" y="${y + b.h - 10}" font-size="11.5" font-family="ui-monospace, Menlo, Consolas, monospace" fill="${p.fg2}">${esc([work, wait].filter(Boolean).join("  "))}</text>`);
    }
    if (count > 0) {
      out.push(`<circle cx="${x + b.w}" cy="${y}" r="10" fill="${p.crit}"/><text x="${x + b.w}" y="${y + 4}" font-size="11" font-weight="700" text-anchor="middle" fill="#ffffff">${count > 99 ? "99+" : count}</text>`);
    }
    out.push("</g>");
  }

  // Line labels last, so a card never hides one.
  out.push(...labels);

  // The legend: the four ratings, an uncoloured step, and the red badge.
  const ly = height - LEGEND + 8;
  out.push(`<line x1="${PAD}" y1="${ly - 12}" x2="${width - PAD}" y2="${ly - 12}" stroke="${p.line}"/>`);
  let lx = PAD;
  const item = (swatch: string, label: string, round: boolean) => {
    out.push(`<g data-legend="${esc(label)}">${round ? `<circle cx="${lx + 6}" cy="${ly + 8}" r="6" fill="${swatch}"/>` : `<rect x="${lx}" y="${ly + 2}" width="12" height="12" rx="3" fill="${swatch}"/>`}<text x="${lx + 18}" y="${ly + 12.5}" font-size="12" fill="${p.fg2}">${esc(label)}</text></g>`);
    lx += 18 + label.length * 6.6 + 18;
  };
  for (const r of LEGEND_ORDER) item(p.rate[r].stripe, RATING_LABELS[r], false);
  item(p.line2, "Nothing to fix", false);
  item(p.crit, "Confirmed issues", true);
  out.push(`<text x="${PAD}" y="${ly + 34}" font-size="11" fill="${p.fg3}">${esc(FOOTER(input.date))}</text>`);
  out.push("</svg>");
  return { svg: out.join(""), width, height };
}

/** A file name for an export: letters, digits and dashes only. */
export function exportFileName(name: string, ext: "png" | "svg" | "csv" | "json", date: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "map";
  return `${base}-${date}.${ext}`;
}

const TOKENS = {
  background: "--background",
  panel: "--panel",
  panel2: "--panel-2",
  line: "--line",
  line2: "--line-2",
  fg: "--fg",
  fg2: "--fg-2",
  fg3: "--fg-3",
  crit: "--crit",
} as const;

/** The page's colours now (light or dark), resolved to values an image can use. Browser only. */
export function readPalette(root: HTMLElement = document.documentElement): MapPalette {
  const probe = document.createElement("span");
  probe.style.display = "none";
  root.appendChild(probe);
  const resolve = (token: string, fallback: string): string => {
    probe.style.color = "";
    probe.style.color = `var(${token})`;
    const v = getComputedStyle(probe).color;
    return v && v !== "" ? v : fallback;
  };
  try {
    const rate = (r: Rating) => ({ stripe: resolve(`--rate-${r}`, LIGHT_PALETTE.rate[r].stripe), soft: resolve(`--rate-${r}-soft`, LIGHT_PALETTE.rate[r].soft) });
    const base = Object.fromEntries(Object.entries(TOKENS).map(([k, t]) => [k, resolve(t, LIGHT_PALETTE[k as keyof typeof TOKENS])])) as Pick<MapPalette, keyof typeof TOKENS>;
    return { ...base, rate: { great: rate("great"), good: rate("good"), bad: rate("bad"), risk: rate("risk") } };
  } finally {
    probe.remove();
  }
}

/** The SVG drawn onto a canvas at `scale` times its size, as a PNG. Browser only. */
export async function svgToPng(image: MapImage, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([image.svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("The map could not be drawn."));
      img.src = url;
    });
    // Browsers cap a canvas (about 16k px a side, and its area): shrink the scale rather than fail on a huge map.
    const s = Math.min(scale, 16000 / image.width, 16000 / image.height, Math.sqrt(120_000_000 / (image.width * image.height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * s));
    canvas.height = Math.max(1, Math.round(image.height * s));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't draw the image.");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be made."))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Saves a blob as a file. Browser only. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
