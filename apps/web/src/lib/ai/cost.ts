// What an AI analysis cost (issue #175, B17: "show the cost and model in an unobtrusive place"). Pure. Prices are the
// Anthropic list prices per million tokens for the model the app uses; a model it doesn't know (a fallback that answered
// instead) is not priced, and the page says so rather than guess.

import type { Json } from "@transpera-flow/db";

/** US dollars per million tokens: input, output, cache read, cache write (5-minute). */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/**
 * The prices of a model by the id the API served it under: the id asked for, or that id with a snapshot date or a
 * context-window suffix ("claude-opus-5-5-20261001", "claude-opus-5-5[1m]"). A fallback model that answered instead
 * isn't priced (undefined).
 */
export function pricesOf(model: string | null | undefined): (typeof PRICES)[string] | undefined {
  if (!model) return undefined;
  const id = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
  return Object.hasOwn(PRICES, id) ? PRICES[id] : undefined;
}

/** The cost of a stored analysis's model calls (its `usage` list), in US dollars; null when the model isn't priced or nothing was used. */
export function costOfUsage(model: string | null, usage: Json | unknown): number | null {
  const price = pricesOf(model);
  if (!price || !Array.isArray(usage) || !usage.length) return null;
  let total = 0;
  for (const u of usage) {
    if (!u || typeof u !== "object" || Array.isArray(u)) continue;
    const o = u as Record<string, unknown>;
    const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : 0);
    total += (n("inputTokens") * price.input + n("outputTokens") * price.output + n("cacheReadTokens") * price.cacheRead + n("cacheWriteTokens") * price.cacheWrite) / 1_000_000;
  }
  return total;
}

/** "about $0.06", "under $0.01": how the page prints it. */
export function formatCost(usd: number | null | undefined): string | null {
  if (usd == null) return null;
  if (usd < 0.01) return "under $0.01";
  return `about $${usd.toFixed(2)}`;
}
