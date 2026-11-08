// Input checks for the services settings (issue #12). Pure, so they can be
// unit tested. They only reject malformed input early: every write still runs
// as the signed-in user through RLS and the table's check constraints.

import type { PricingModel } from "@transpera-flow/db";

type Scalar = string | number | boolean | null;
type Check = (v: unknown) => boolean;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const number: Check = (v) => typeof v === "number" && Number.isFinite(v);
const between = (min: number, max: number): Check => (v) => number(v) && (v as number) >= min && (v as number) <= max;

export const PRICING_MODELS = ["retainer", "one_off", "hourly"] as const satisfies readonly PricingModel[];

export const PRICING_LABELS: Record<PricingModel, string> = {
  retainer: "Monthly retainer",
  one_off: "One-off project",
  hourly: "Hourly",
};

export const isPricingModel = (v: unknown): v is PricingModel =>
  typeof v === "string" && (PRICING_MODELS as readonly string[]).includes(v);

/** Longest service name, tag, and most tags a service may carry. */
export const MAX_NAME = 200;
export const MAX_TAG = 100;
export const MAX_TAGS = 20;
/** Upper bounds that catch typos (an extra zero or three), well inside what the database stores. */
const MAX_PRICE = 1e8;
const MAX_TENURE_MONTHS = 600;
const MAX_MIX_SHARE = 1e6;

/** Service columns saved one at a time, and what each accepts. */
export const SERVICE_FIELDS = {
  name: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= MAX_NAME,
  pricing_model: isPricingModel,
  price: between(0, MAX_PRICE),
  // The fee range of a client won (sandbox phase 3, A5): blank is no range.
  price_low: (v) => v === null || between(0, MAX_PRICE)(v),
  price_high: (v) => v === null || between(0, MAX_PRICE)(v),
  margin: between(0, 1),
  tenure_months: between(0, MAX_TENURE_MONTHS),
  churn_monthly_base: between(0, 1),
  // How much poor client health raises churn (docs/PRD.md §6.3.5; issue #19).
  churn_health_sensitivity: between(0, 100),
  mix_share: between(0, MAX_MIX_SHARE),
  entry_process_id: (v) => v === null || isId(v),
  active: (v) => typeof v === "boolean",
} as const satisfies Record<string, Check>;

export type ServiceField = keyof typeof SERVICE_FIELDS;

const isScalar = (v: unknown): v is Scalar => v === null || ["string", "number", "boolean"].includes(typeof v);

/**
 * A single-field save's inputs, if well formed: a known field, a scalar base,
 * and a valid new value (text trimmed). Null otherwise.
 */
export function parseServiceField(
  serviceId: unknown,
  field: unknown,
  base: unknown,
  value: unknown,
): { serviceId: string; field: ServiceField; base: Scalar; value: Scalar } | null {
  if (!isId(serviceId) || typeof field !== "string" || !Object.hasOwn(SERVICE_FIELDS, field)) return null;
  const f = field as ServiceField;
  const cleaned = typeof value === "string" ? value.trim() : value;
  if (!isScalar(base) || !SERVICE_FIELDS[f](cleaned)) return null;
  return { serviceId, field: f, base, value: cleaned as Scalar };
}

/**
 * Condition tags as typed ("seo, PPC , seo") to the stored list: split on
 * commas, trimmed, blanks and repeats dropped, first spelling kept. Tags are
 * matched exactly against connections' condition tags, so case is kept.
 */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(",")) {
    const tag = raw.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export const formatTags = (tags: readonly string[]): string => tags.join(", ");

/** A tag list as stored: an array of distinct, trimmed, non-blank tags within the limits. */
export function isTagList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= MAX_TAGS &&
    v.every((t) => typeof t === "string" && t.length > 0 && t.length <= MAX_TAG && t === t.trim() && !t.includes(",")) &&
    new Set(v).size === v.length
  );
}

export interface NewService {
  name: string;
  pricing_model: PricingModel;
  price: number;
}

/** The add-service form's fields, or the sentence to show. */
export function parseNewService(form: { get(name: string): FormDataEntryValue | null }): NewService | { error: string } {
  const name = String(form.get("name") ?? "").trim();
  const pricing = String(form.get("pricing_model") ?? "retainer");
  const priceText = String(form.get("price") ?? "").trim();
  if (!SERVICE_FIELDS.name(name)) return { error: "Enter a name." };
  if (!isPricingModel(pricing)) return { error: "Pick a pricing model." };
  const price = priceText === "" ? 0 : Number(priceText);
  if (!SERVICE_FIELDS.price(price)) return { error: "Enter a price of 0 or more." };
  return { name, pricing_model: pricing, price };
}

/**
 * Each service's share of arrivals: its mix share over the total of the
 * active services. Null when the shares add up to nothing.
 */
export function mixPercentages(
  services: readonly { id: string; mix_share: number; active: boolean }[],
): Map<string, number> | null {
  const active = services.filter((s) => s.active);
  const total = active.reduce((sum, s) => sum + Number(s.mix_share), 0);
  if (!(total > 0)) return null;
  return new Map(active.map((s) => [s.id, Number(s.mix_share) / total]));
}
