// Input checks and derived figures for the demand settings (issue #13). Pure,
// so they can be unit tested. The checks only reject malformed input early:
// every write still runs as the signed-in user through RLS and the tables'
// check constraints.

import {
  qualifiedLeadsPerWeek,
  type LeadSourceRow,
  type ProvenanceMap,
  type ProvenanceSource,
  type ServiceRow,
} from "@transpera-flow/db";
import { isId, mixPercentages } from "./services";

type Scalar = string | number | boolean | null;
type Check = (v: unknown) => boolean;

const number: Check = (v) => typeof v === "number" && Number.isFinite(v);
const between = (min: number, max: number): Check => (v) => number(v) && (v as number) >= min && (v as number) <= max;

export const MAX_NAME = 200;
/** Upper bounds that catch typos, well inside what the database stores. */
export const MAX_VOLUME_WEEK = 100_000;
export const MAX_MULTIPLIER = 10;
/** Monthly growth between -50% and +100%. */
export const MIN_GROWTH = -0.5;
export const MAX_GROWTH = 1;

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Lead source columns saved one at a time, and what each accepts. */
export const LEAD_SOURCE_FIELDS = {
  name: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= MAX_NAME,
  volume_week: between(0, MAX_VOLUME_WEEK),
  conversion_to_qualified: between(0, 1),
} as const satisfies Record<string, Check>;

export type LeadSourceField = keyof typeof LEAD_SOURCE_FIELDS;

export const isMultiplier = (v: unknown): v is number => between(0, MAX_MULTIPLIER)(v);
export const isGrowth = (v: unknown): v is number => between(MIN_GROWTH, MAX_GROWTH)(v);
export const isMonth = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 12;

const isScalar = (v: unknown): v is Scalar => v === null || ["string", "number", "boolean"].includes(typeof v);

/** A single-field save of a lead source, if well formed (text trimmed). Null otherwise. */
export function parseLeadSourceField(
  sourceId: unknown,
  field: unknown,
  base: unknown,
  value: unknown,
): { sourceId: string; field: LeadSourceField; base: Scalar; value: Scalar } | null {
  if (!isId(sourceId) || typeof field !== "string" || !Object.hasOwn(LEAD_SOURCE_FIELDS, field)) return null;
  const f = field as LeadSourceField;
  const cleaned = typeof value === "string" ? value.trim() : value;
  if (!isScalar(base) || !LEAD_SOURCE_FIELDS[f](cleaned)) return null;
  return { sourceId, field: f, base, value: cleaned as Scalar };
}

export interface NewLeadSource {
  name: string;
  volume_week: number;
  conversion_to_qualified: number;
}

/** The add-lead-source form's fields (conversion typed as a percentage), or the sentence to show. */
export function parseNewLeadSource(form: { get(name: string): FormDataEntryValue | null }): NewLeadSource | { error: string } {
  const name = String(form.get("name") ?? "").trim();
  const volumeText = String(form.get("volume_week") ?? "").trim();
  const conversionText = String(form.get("conversion_pct") ?? "").trim();
  if (!LEAD_SOURCE_FIELDS.name(name)) return { error: "Enter a name." };
  const volume = volumeText === "" ? 0 : Number(volumeText);
  if (!LEAD_SOURCE_FIELDS.volume_week(volume)) return { error: `Enter leads a week from 0 to ${MAX_VOLUME_WEEK.toLocaleString("en-GB")}.` };
  const conversion = conversionText === "" ? 1 : Number(conversionText) / 100;
  if (!LEAD_SOURCE_FIELDS.conversion_to_qualified(conversion)) return { error: "Enter a conversion from 0 to 100%." };
  return { name, volume_week: volume, conversion_to_qualified: conversion };
}

/** A value's provenance source; a value with none recorded is an estimate. */
export function provenanceOf(provenance: ProvenanceMap | null | undefined, field: string): ProvenanceSource {
  const source = provenance?.[field]?.source;
  return source === "entered" ? source : "estimated";
}

export interface DemandSummary {
  /** Qualified leads a week from the lead sources; null when there are none. */
  fromSources: number | null;
  /** The rate the simulation uses: the sources' total, or the interim leads per week. */
  perWeek: number;
  /** Each active service's arrivals a week, by the mix; empty with no mix to split by. */
  byService: { id: string; name: string; share: number; perWeek: number }[];
}

/**
 * What the demand settings add up to: Σ volume × conversion over the lead
 * sources (or the interim leads per week), split by the services mix, as
 * model resolution does (docs/PRD.md §6.2).
 */
export function demandSummary(
  sources: readonly LeadSourceRow[],
  services: readonly ServiceRow[],
  interimLeadsPerWeek: number,
): DemandSummary {
  const fromSources = qualifiedLeadsPerWeek(sources);
  const perWeek = fromSources ?? interimLeadsPerWeek;
  const mix = mixPercentages(services);
  const byService = mix
    ? services.filter((sv) => mix.has(sv.id)).map((sv) => ({ id: sv.id, name: sv.name, share: mix.get(sv.id)!, perWeek: perWeek * mix.get(sv.id)! }))
    : [];
  return { fromSources, perWeek, byService };
}
