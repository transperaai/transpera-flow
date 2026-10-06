// The messages between the import wizard's hook and its Web Worker (issue #40). Types only, so the worker and the hook share them.

import type { ImportEncoding, ImportKind, ImportRead } from "@transpera-flow/db/csv-import";
import type { DateOrder } from "@transpera-flow/db/calibration";

export type DelimiterChoice = "auto" | "," | ";" | "\t" | "|";

export type ImportRequest =
  | {
      id: number;
      op: "load";
      /** The file's bytes, transferred. */
      bytes: ArrayBuffer | null;
      /** Pasted text, when there are no bytes. */
      text: string | null;
      delimiter: DelimiterChoice;
      headerRow: number;
    }
  | { id: number; op: "read"; kind: ImportKind; index: Record<string, number | null>; dateOrder?: DateOrder };

export type ImportMessage =
  | {
      id: number;
      kind: "loaded";
      headers: string[];
      /** The first 5 data rows. */
      samples: string[][];
      lines: number;
      delimiter: string;
      encoding: ImportEncoding;
      note: string | null;
    }
  | { id: number; kind: "progress"; done: number; total: number }
  | { id: number; kind: "read"; read: ImportRead }
  | { id: number; kind: "error"; error: string };

/** What a loaded file looks like, for matching its columns. */
export interface LoadedFile {
  headers: string[];
  samples: string[][];
  lines: number;
  delimiter: string;
  encoding: ImportEncoding;
  note: string | null;
}
