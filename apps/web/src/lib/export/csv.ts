// CSV text (issue #39, B10): one place that writes it, safe to open in a spreadsheet. A text cell that starts with `=`, `+`,
// `-`, `@`, a tab or a carriage return would be run as a formula by Excel and Sheets (CSV injection), so it gets a leading
// apostrophe; a cell with a comma, quote or line break is quoted. Numbers are written as numbers. Lines end in CRLF and the
// file starts with a byte order mark so Excel reads it as UTF-8.

export type CsvCell = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell, as it is written. */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A whole file: the header, then a row per item. */
export function csvText(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
