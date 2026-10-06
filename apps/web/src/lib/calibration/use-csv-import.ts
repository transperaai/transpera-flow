"use client";

// A file read for the import wizard, in its own Web Worker (issue #40). `load` decodes and splits a file (or pasted text) and the worker keeps
// the table; `read` reads it as a kind from the columns the person matched. A newer request supersedes an older one: answers for older
// requests are dropped. `stop` terminates the worker (a new one starts on the next call) and goes back to matching the columns; the file
// is read again from the same source when needed. Nothing runs without a call, and nothing leaves the browser.

import { useCallback, useEffect, useRef, useState } from "react";
import type { DurationUnit, ImportKind, ImportRead } from "@transpera-flow/db/csv-import";
import type { DateOrder } from "@transpera-flow/db/calibration";
import type { DelimiterChoice, ImportMessage, ImportRequest, LoadedFile } from "./import-worker-types";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type CsvImportState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded" }
  | { phase: "reading"; done: number; total: number }
  | { phase: "read"; read: ImportRead }
  | { phase: "error"; error: string; during: "load" | "read" };

export interface LoadOptions {
  delimiter: DelimiterChoice;
  headerRow: number;
}

type Source = { kind: "file"; file: File } | { kind: "text"; text: string };

export interface UseCsvImport {
  state: CsvImportState;
  /** The loaded file's columns and first rows, kept while it is read, stopped or read again. */
  loaded: LoadedFile | null;
  /** A file or pasted text; null loads the same source again with other options. */
  load: (source: File | string | null, options: LoadOptions) => void;
  read: (kind: ImportKind, index: Record<string, number | null>, dateOrder?: DateOrder, durationUnit?: DurationUnit) => void;
  stop: () => void;
  reset: () => void;
}

export function useCsvImport(): UseCsvImport {
  const [state, setState] = useState<CsvImportState>({ phase: "idle" });
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const worker = useRef<Worker | null>(null);
  const current = useRef(0);
  const source = useRef<Source | null>(null);
  const options = useRef<LoadOptions>({ delimiter: "auto", headerRow: 1 });
  // Whether the running worker holds the table of the current source and options.
  const held = useRef(false);
  // A load made only so a read can follow (after Stop): its answer changes nothing the person sees.
  const quiet = useRef(false);
  // Whether the request in flight is a read (else a load): which of the two an error belongs to.
  const reading = useRef(false);

  const stopWorker = useCallback(() => {
    worker.current?.terminate();
    worker.current = null;
    held.current = false;
    quiet.current = false;
    reading.current = false;
  }, []);

  useEffect(() => stopWorker, [stopWorker]);

  /** A file that couldn't be loaded has no table, so no columns; a read that failed leaves the file as it was. */
  const fail = useCallback((error: string) => {
    const during = reading.current ? "read" : "load";
    reading.current = false;
    if (during === "load") setLoaded(null);
    setState({ phase: "error", error, during });
  }, []);

  const spawn = useCallback((): Worker => {
    if (worker.current) return worker.current;
    const w = new Worker(new URL("../../workers/csv-import.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (event: MessageEvent<ImportMessage>) => {
      const m = event.data;
      // An answer to a request that has been replaced is dropped.
      if (m.id !== current.current) return;
      if (m.kind === "loaded") {
        held.current = true;
        if (quiet.current) {
          quiet.current = false;
          return;
        }
        setLoaded({ headers: m.headers, samples: m.samples, lines: m.lines, delimiter: m.delimiter, encoding: m.encoding, note: m.note });
        setState({ phase: "loaded" });
      } else if (m.kind === "progress") setState({ phase: "reading", done: m.done, total: m.total });
      else if (m.kind === "read") {
        reading.current = false;
        setState({ phase: "read", read: m.read });
      } else fail(m.error);
    };
    w.onerror = (e) => fail(e.message || "The file couldn't be read.");
    worker.current = w;
    return w;
  }, [fail]);

  /** Posts a `load` for the current source; resolves false when it was replaced meanwhile. */
  const postLoad = useCallback(
    async (id: number): Promise<boolean> => {
      const src = source.current;
      if (!src) return false;
      const w = spawn();
      let req: ImportRequest;
      let transfer: Transferable[] = [];
      if (src.kind === "file") {
        const bytes = await src.file.arrayBuffer();
        if (id !== current.current) return false;
        req = { id, op: "load", bytes, text: null, ...options.current };
        transfer = [bytes];
      } else req = { id, op: "load", bytes: null, text: src.text, ...options.current };
      w.postMessage(req, transfer);
      return true;
    },
    [spawn],
  );

  const load = useCallback(
    (next: File | string | null, opts: LoadOptions) => {
      options.current = opts;
      if (next !== null) {
        if (typeof next !== "string") {
          if (/\.xlsx?$/i.test(next.name)) {
            current.current++;
            stopWorker();
            source.current = null;
            setLoaded(null);
            setState({ phase: "error", error: "Save it as CSV UTF-8 from Excel and choose that file.", during: "load" });
            return;
          }
          if (next.size > MAX_FILE_BYTES) {
            current.current++;
            stopWorker();
            source.current = null;
            setLoaded(null);
            setState({ phase: "error", error: "That file is over 20 MB. Split it by date and read each part.", during: "load" });
            return;
          }
        }
        source.current = typeof next === "string" ? { kind: "text", text: next } : { kind: "file", file: next };
      }
      if (!source.current) return;
      const id = ++current.current;
      held.current = false;
      quiet.current = false;
      reading.current = false;
      setState({ phase: "loading" });
      void postLoad(id).catch(() => {
        if (id === current.current) setState({ phase: "error", error: "The file couldn't be read.", during: "load" });
      });
    },
    [postLoad, stopWorker],
  );

  const read = useCallback(
    (kind: ImportKind, index: Record<string, number | null>, dateOrder?: DateOrder, durationUnit?: DurationUnit) => {
      const id = ++current.current;
      reading.current = true;
      setState({ phase: "reading", done: 0, total: 0 });
      void (async () => {
        // After Stop the worker is new and holds no table: load the same source again first. Its answer is dropped as older.
        if (!held.current) {
          held.current = true;
          quiet.current = true;
          if (!(await postLoad(id))) return;
        }
        if (id !== current.current) return;
        worker.current?.postMessage({ id, op: "read", kind, index, dateOrder, durationUnit } satisfies ImportRequest);
      })().catch(() => {
        if (id === current.current) setState({ phase: "error", error: "The file couldn't be read.", during: "read" });
      });
    },
    [postLoad],
  );

  const stop = useCallback(() => {
    current.current++;
    stopWorker();
    setState(source.current ? { phase: "loaded" } : { phase: "idle" });
  }, [stopWorker]);

  const reset = useCallback(() => {
    current.current++;
    stopWorker();
    source.current = null;
    setLoaded(null);
    setState({ phase: "idle" });
  }, [stopWorker]);

  return { state, loaded, load, read, stop, reset };
}
