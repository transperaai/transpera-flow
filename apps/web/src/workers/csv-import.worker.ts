/// <reference lib="webworker" />
// Reading a file for the import wizard, off the main thread (issue #40): `load` decodes and splits it and keeps the table in
// memory; `read` reads it as a kind from the columns the person matched, posting progress. A file of 50,000 rows reads without
// freezing the page, and Stop terminates this worker. Nothing leaves the browser.
import { decodeImportFile, loadTable, readImport, type ImportEncoding, type LoadedTable } from "@transpera-flow/db/csv-import";
import type { ImportMessage, ImportRequest } from "@/lib/calibration/import-worker-types";

let table: LoadedTable | null = null;
let headerRow = 1;
const post = (m: ImportMessage) => self.postMessage(m);

self.onmessage = (event: MessageEvent<ImportRequest>) => {
  const req = event.data;
  try {
    if (req.op === "load") {
      let text: string;
      let note: string | null = null;
      let encoding: ImportEncoding = "utf-8";
      if (req.bytes) {
        const decoded = decodeImportFile(new Uint8Array(req.bytes));
        if ("error" in decoded) {
          table = null;
          post({ id: req.id, kind: "error", error: decoded.error });
          return;
        }
        ({ text, note, encoding } = decoded);
      } else text = req.text ?? "";
      const loaded = loadTable(text, req.delimiter, req.headerRow);
      if ("error" in loaded) {
        table = null;
        post({ id: req.id, kind: "error", error: loaded.error });
        return;
      }
      table = loaded;
      headerRow = req.headerRow;
      post({ id: req.id, kind: "loaded", headers: loaded.headers, samples: loaded.samples, lines: loaded.lines, delimiter: loaded.delimiter, encoding, note });
      return;
    }
    if (!table) {
      post({ id: req.id, kind: "error", error: "No file is loaded." });
      return;
    }
    const read = readImport(table.table, req.kind, req.index, {
      dateOrder: req.dateOrder,
      durationUnit: req.durationUnit,
      headerRow,
      onProgress: (done, total) => post({ id: req.id, kind: "progress", done, total }),
    });
    post({ id: req.id, kind: "read", read });
  } catch (err) {
    post({ id: req.id, kind: "error", error: err instanceof Error ? err.message : String(err) });
  }
};
