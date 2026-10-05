// Input checks behind the Sources page's Server Actions
// (app/w/[slug]/source-actions.ts) and the in-memory demo store. They only
// reject malformed input early: the database checks kind, title, speakers and
// the link again, and RLS decides who may write.

import type { SourceKind } from "@transpera-flow/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const URL_SHAPE = /^https?:\/\/\S+$/;

export const SOURCE_KINDS = ["transcript", "notes", "sop", "spreadsheet", "data", "screenshot", "other"] as const satisfies readonly SourceKind[];
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = { transcript: "Transcript", notes: "Notes", sop: "SOP", spreadsheet: "Spreadsheet", data: "Data", screenshot: "Screenshot", other: "Other" };
export const MAX_TITLE = 200;
export const MAX_BODY = 500_000;
export const MAX_SPEAKERS = 50;

export type Scalar = string | number | boolean | null;
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isKind = (v: unknown): v is SourceKind => (SOURCE_KINDS as readonly unknown[]).includes(v);
const isDate = (v: unknown): v is string => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v));

/** "Maya Collins, Rosa Diaz" → ["Maya Collins", "Rosa Diaz"]: trimmed, blanks and repeats dropped. */
export function parseSpeakers(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const s of (text ?? "").split(/[,;\n]/)) {
    const name = s.trim().slice(0, 200);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export const formatSpeakers = (speakers: readonly string[]) => speakers.join(", ");

/** What the "Add a source" form sends. */
export interface SourceInput {
  kind: SourceKind;
  title: string;
  speakers: string[];
  recorded_at: string | null;
  body: string | null;
  file_url: string | null;
}

/** Source fields edited one at a time. `speakers` travels as "a, b" text. */
export const SOURCE_FIELDS = ["kind", "title", "speakers", "recorded_at", "body", "file_url"] as const;
export type SourceField = (typeof SOURCE_FIELDS)[number];
export const isSourceField = (v: unknown): v is SourceField => (SOURCE_FIELDS as readonly unknown[]).includes(v);

const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());

/** One field's value, cleaned (trimmed; blank optional text is null), or null if it isn't valid. */
export function cleanSourceField(field: SourceField, value: unknown): { value: string | string[] | null } | null {
  switch (field) {
    case "kind":
      return isKind(value) ? { value } : null;
    case "title":
      return typeof value === "string" && value.trim() && value.trim().length <= MAX_TITLE ? { value: value.trim() } : null;
    case "speakers": {
      if (Array.isArray(value)) return value.every((v) => typeof v === "string") ? cleanSourceField(field, value.join(",")) : null;
      if (!blank(value) && typeof value !== "string") return null;
      const speakers = parseSpeakers(value as string | null);
      return speakers.length <= MAX_SPEAKERS ? { value: speakers } : null;
    }
    case "recorded_at":
      return blank(value) ? { value: null } : isDate(value) ? { value } : null;
    case "body":
      return blank(value) ? { value: null } : typeof value === "string" && value.length <= MAX_BODY ? { value } : null;
    case "file_url":
      return blank(value) ? { value: null } : typeof value === "string" && URL_SHAPE.test(value.trim()) && value.length <= 2000 ? { value: value.trim() } : null;
  }
}

/** A new source, if every field is valid. */
export function parseSourceInput(input: unknown): Parsed<SourceInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "That source isn't valid." };
  const o = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of SOURCE_FIELDS) {
    const raw = field === "kind" ? (o.kind ?? "transcript") : o[field];
    const clean = cleanSourceField(field, raw ?? null);
    if (!clean) {
      const what: Record<SourceField, string> = {
        kind: "Pick transcript, notes, SOP, spreadsheet, data, screenshot or other.",
        title: `Give the source a title (up to ${MAX_TITLE} characters).`,
        speakers: `List up to ${MAX_SPEAKERS} speakers, separated by commas.`,
        recorded_at: "Enter the date as YYYY-MM-DD.",
        body: "The text is too long.",
        file_url: "The link must start with http:// or https://.",
      };
      return { ok: false, error: what[field] };
    }
    out[field] = clean.value;
  }
  return { ok: true, value: out as unknown as SourceInput };
}
