"use client";

// The import wizard (issue #40, C1) on Settings → Historical data: choose a file, match its columns (suggested, correctable), check
// the rows. Three steps inline in a card. The file is read in a Web Worker, so 50,000 rows don't freeze the page. Client and person
// values are never shown (the mapper counts them, the preview labels them) and amounts are shown only to owners and editors; nothing
// from the file is stored (D27, #30). The card around it decides what the rows are used for.

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  IMPORT_KINDS,
  applyNameMap,
  columnMapValue,
  importDetails,
  suggestMapping,
  suggestNameMap,
  type ImportDetails,
  type ImportKind,
  type ImportRead,
  type MatchHow,
  type ShapeRow,
} from "@transpera-flow/db/csv-import";
import type { DateOrder } from "@transpera-flow/db/calibration";
import { Help, HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { DelimiterChoice } from "@/lib/calibration/import-worker-types";
import { mappingProblems, previewTable, sampleLine } from "@/lib/calibration/import-view";
import { useCsvImport } from "@/lib/calibration/use-csv-import";
import { formatNumber } from "@/lib/format";

export type ImportMode = "live" | "readonly" | "demo";

export interface ImportWizardProps {
  /** For headings, radio groups and input ids. */
  id: string;
  /** The kinds this card takes; a picker shows when there is more than one. */
  kinds: readonly ImportKind[];
  /**
   * Names in the model the name column is matched to (step names, active services, servicing processes, lead sources). Keep its
   * `names` array's identity while its content is the same (build it with `useMemo`).
   */
  targets: { label: string; names: readonly string[] } | null;
  /** The latest column map of each kind, offered first. */
  previous: Partial<Record<ImportKind, Record<string, string>>>;
  /** The demo's sample files. */
  sample?: Partial<Record<ImportKind, { name: string; text: string }>>;
  /** Owners and editors see amounts; viewers and members don't. */
  mode: ImportMode;
  /** Called with the rows to use, or null when the person starts again. */
  onReady: (ready: ImportReady | null) => void;
}

export interface ImportReady {
  kind: ImportKind;
  fileName: string;
  /** Column id to the header it was matched to. */
  columnMap: Record<string, string>;
  /** Converted and name-matched. */
  rows: ShapeRow[];
  /** For the card's own summary lines. */
  read: ImportRead;
  /** Counts only. The card adds the summary for leads and invoices. */
  details: ImportDetails;
}

const DELIMITERS: { value: DelimiterChoice; label: string }[] = [
  { value: "auto", label: "Automatic" },
  { value: ",", label: "Comma" },
  { value: ";", label: "Semicolon" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Vertical bar" },
];

const BADGES: Record<MatchHow, string> = { previous: "From your last import", name: "Suggested", partial: "Suggested" };

/** A select that is only a select: its callers carry its label and (i). */
function ColumnSelect(props: React.ComponentProps<typeof NativeSelect>) {
  return <NativeSelect {...props} />;
}

export function ImportWizard(props: ImportWizardProps) {
  const { id, kinds, targets, previous, sample, mode, onReady } = props;
  const canSeeAmounts = mode !== "readonly";
  const hook = useCsvImport();
  const { state, loaded } = hook;
  const [kind, setKind] = useState<ImportKind>(kinds[0]!);
  const [delimiter, setDelimiter] = useState<DelimiterChoice>("auto");
  const [headerRow, setHeaderRow] = useState(1);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  // The rows shown are of an earlier choice of columns, kind or file: hidden until the file is read again.
  const [stale, setStale] = useState(false);
  const [used, setUsed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const spec = IMPORT_KINDS[kind];
  const headingId = useId();

  // The suggested columns, until the person changes one.
  const suggested = useMemo(() => (loaded ? suggestMapping(loaded.headers, kind, previous[kind]) : null), [loaded, kind, previous]);
  const [edit, setEdit] = useState<{ base: unknown; index: Record<string, number | null>; how: Record<string, MatchHow | null> } | null>(null);
  const mapping = suggested ? (edit && edit.base === suggested ? edit : { base: suggested, ...suggested }) : null;
  const problems = mapping ? mappingProblems(spec, mapping.index) : {};
  const blocked = Object.keys(problems).length > 0;

  const read = state.phase === "read" ? state.read : null;
  const showRows = read !== null && !stale;

  // Names in the file matched to the model's, until the person changes one.
  const suggestedNames = useMemo(() => (read && targets && spec.nameColumn ? suggestNameMap(read.names, targets.names) : null), [read, targets, spec.nameColumn]);
  const [nameEdit, setNameEdit] = useState<{ base: unknown; map: Record<string, string | null> } | null>(null);
  const nameMap = suggestedNames ? (nameEdit && nameEdit.base === suggestedNames ? nameEdit.map : suggestedNames) : null;
  const kept = useMemo(() => (read ? (nameMap ? applyNameMap(read, nameMap) : read.rows) : null), [read, nameMap]);

  const ready = (r: ImportReady | null) => {
    setUsed(r !== null);
    onReady(r);
  };
  const unuse = () => {
    if (used) ready(null);
  };

  const options = (next: Partial<{ delimiter: DelimiterChoice; headerRow: number }> = {}) => ({ delimiter: next.delimiter ?? delimiter, headerRow: next.headerRow ?? headerRow });
  const loadFile = (file: File | undefined) => {
    if (!file) return;
    unuse();
    setStale(false);
    setFileName(file.name);
    setText("");
    hook.load(file, options());
  };
  const loadText = (body: string, name: string) => {
    unuse();
    setStale(false);
    setFileName(name);
    hook.load(body, options());
  };
  const pickKind = (next: ImportKind) => {
    unuse();
    // The file is read as another kind: its columns are matched again.
    setStale(true);
    setKind(next);
  };
  const startAgain = () => {
    hook.reset();
    setStale(false);
    setText("");
    setFileName("");
    setEdit(null);
    setNameEdit(null);
    ready(null);
  };

  const setColumn = (columnId: string, value: string) => {
    if (!mapping) return;
    unuse();
    setStale(true);
    const index = { ...mapping.index, [columnId]: value === "" ? null : Number(value) };
    setEdit({ base: suggested, index, how: { ...mapping.how, [columnId]: null } });
  };
  const goOn = (dateOrder?: DateOrder) => {
    if (!mapping) return;
    unuse();
    setStale(false);
    hook.read(kind, mapping.index, dateOrder);
  };

  const useRows = () => {
    if (!read || !loaded || !mapping || !kept) return;
    const columnMap: Record<string, string> = {};
    for (const c of spec.columns) {
      const i = mapping.index[c.id];
      if (i !== null && i !== undefined && loaded.headers[i] !== undefined) columnMap[c.id] = columnMapValue(c, loaded.headers[i]!, i);
    }
    ready({
      kind,
      fileName: fileName || "Pasted rows",
      columnMap,
      rows: kept,
      read,
      details: importDetails(read, {
        delimiter: loaded.delimiter,
        encoding: loaded.encoding,
        headerRow,
        nameMatches: { matched: kept.length, leftOut: read.rows.length - kept.length },
        rows: kept,
      }),
    });
  };

  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(spec.template)}`;
  const kindSample = sample?.[kind];
  const loading = state.phase === "loading";
  const reading = state.phase === "reading";

  return (
    <div className="flex flex-col gap-4" data-import-wizard={id}>
      <section data-import-step="file" aria-labelledby={`${headingId}-file`} className="flex flex-col gap-3">
        <h3 id={`${headingId}-file`} className="text-sm font-semibold">
          Choose the file
        </h3>
        {kinds.length > 1 && (
          <label className="flex max-w-md flex-col gap-1">
            <HelpLabel label="What's in the file" description={spec.help.description} example={spec.help.example} />
            <NativeSelect id={`${id}-kind`} value={kind} onChange={(e) => pickKind(e.target.value as ImportKind)}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {IMPORT_KINDS[k].label}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
        {kinds.length === 1 && (
          <p className="flex items-center text-sm text-muted-foreground">
            {spec.label}
            <Help label={spec.label} description={spec.help.description} example={spec.help.example} />
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" type="button" onClick={() => fileInput.current?.click()}>
            Choose a CSV file
          </Button>
          <Help
            label="CSV file"
            description="A CSV, TSV or TXT file, up to 20 MB and 200,000 rows. It is read in your browser. Only its name, its columns and counts are kept, never the rows."
            example="Save an Excel sheet with File → Save as → CSV UTF-8, then choose it here."
          />
          <input
            ref={fileInput}
            id={`${id}-file`}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain"
            className="sr-only"
            aria-label={`${spec.label} CSV file`}
            onChange={(e) => {
              loadFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <a className="text-sm text-accent underline-offset-4 hover:underline" download={`${kind.replace("_", "-")}-template.csv`} href={template}>
            Download the template
          </a>
          {kindSample && (
            <Button variant="ghost" size="sm" type="button" onClick={() => loadText(kindSample.text, kindSample.name)}>
              Use a sample
            </Button>
          )}
        </div>
        <label htmlFor={`${id}-paste`} className="flex flex-col gap-1">
          <HelpLabel
            label="Or paste the rows"
            description="Paste rows copied from a spreadsheet or a CSV, with the column names in the first row. Columns can be in any order; other columns are ignored."
            example={spec.template.split("\n")[1] ?? ""}
          />
          <Textarea
            id={`${id}-paste`}
            value={text}
            rows={5}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder={spec.template.split("\n").slice(0, 3).join("\n")}
            onChange={(e) => {
              setText(e.target.value);
              setFileName("");
            }}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={!text.trim() || loading} onClick={() => loadText(text, "Pasted rows")}>
            Read the rows
          </Button>
          {fileName && <span className="truncate text-sm text-muted-foreground">{fileName}</span>}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex w-48 flex-col gap-1">
            <HelpLabel
              label="Columns are split by"
              description="The character between the columns. Automatic works out which from the first line: a tab, then a semicolon or a comma."
              example="Files saved in European settings often use a semicolon, so 1,5 can be one number."
            />
            <NativeSelect
              id={`${id}-delimiter`}
              value={delimiter}
              onChange={(e) => {
                const next = e.target.value as DelimiterChoice;
                setDelimiter(next);
                if (loaded || loading) hook.load(null, options({ delimiter: next }));
              }}
            >
              {DELIMITERS.map((d) => (
                <option key={d.label} value={d.value}>
                  {d.label}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="flex w-40 flex-col gap-1">
            <HelpLabel
              label="Column names are on row"
              description="Which row holds the column names. Use a later row when the file has titles above them. Blank rows aren't counted."
              example="A report with a title and a date on the first two rows has its column names on row 3."
            />
            <Input
              id={`${id}-header-row`}
              type="number"
              min={1}
              max={20}
              value={headerRow}
              onChange={(e) => {
                const next = Math.min(20, Math.max(1, Math.floor(Number(e.target.value)) || 1));
                setHeaderRow(next);
                if (loaded || loading) hook.load(null, options({ headerRow: next }));
              }}
            />
          </label>
        </div>
        {loading && (
          <p role="status" className="text-sm text-muted-foreground">
            Reading the file…
          </p>
        )}
        {state.phase === "error" && state.during === "load" && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </section>

      {loaded && mapping && (
        <section data-import-step="columns" aria-labelledby={`${headingId}-columns`} className="flex flex-col gap-3">
          <h3 id={`${headingId}-columns`} className="text-sm font-semibold">
            Match the columns
          </h3>
          <p className="text-sm text-muted-foreground">
            {fileName || "Pasted rows"}: {formatNumber(loaded.lines, 0)} rows as {spec.label.toLowerCase()}. Check which column of the file holds what; change any that
            are wrong.
          </p>
          {loaded.note && <p className="text-sm text-muted-foreground">{loaded.note}</p>}
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {spec.columns.map((c) => {
              const index = mapping.index[c.id] ?? null;
              const how = mapping.how[c.id] ?? null;
              const fieldId = `${id}-col-${c.id}`;
              return (
                <li key={c.id} data-column={c.id} className="grid gap-x-4 gap-y-1 px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.4fr)]">
                  <span className="flex flex-wrap items-center gap-1.5 text-sm">
                    <label htmlFor={fieldId} className="font-medium">
                      {c.label}
                    </label>
                    <Help label={c.label} description={c.help.description} example={c.help.example} />
                    {c.required && <span className="text-xs text-muted-foreground">Required</span>}
                    {how && <span className="inline-block rounded-token border border-line bg-panel-2 px-1.5 text-[11px] leading-4 text-fg-2">{BADGES[how]}</span>}
                  </span>
                  <span className="flex flex-col gap-1">
                    <ColumnSelect id={fieldId} value={index === null ? "" : String(index)} onChange={(e) => setColumn(c.id, e.target.value)} aria-invalid={problems[c.id] !== undefined}>
                      <option value="">{c.required ? "Choose a column" : "Not in this file"}</option>
                      {loaded.headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h}
                        </option>
                      ))}
                    </ColumnSelect>
                    {problems[c.id] && <span className="text-xs text-destructive">{problems[c.id]}</span>}
                  </span>
                  <span className="min-w-0 text-xs break-words text-muted-foreground">{sampleLine(c, loaded.samples, index, canSeeAmounts)}</span>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            {reading ? (
              <>
                <span role="status" className="text-sm text-muted-foreground">
                  Reading… {formatNumber(state.done, 0)} of {formatNumber(state.total || loaded.lines, 0)} rows
                </span>
                <Button type="button" variant="outline" size="sm" onClick={hook.stop}>
                  Stop
                </Button>
              </>
            ) : (
              <>
                <Button type="button" disabled={blocked} onClick={() => goOn()}>
                  Continue
                </Button>
              </>
            )}
            {blocked && !reading && <span className="text-sm text-muted-foreground">Fix the columns marked above to continue.</span>}
          </div>
          {state.phase === "error" && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
        </section>
      )}

      {showRows && loaded && mapping && read && kept && (
        <section data-import-step="rows" aria-labelledby={`${headingId}-rows`} className="flex flex-col gap-3">
          <h3 id={`${headingId}-rows`} className="text-sm font-semibold">
            Check the rows
          </h3>
          <RowsStep
            id={id}
            kind={kind}
            read={read}
            loaded={loaded}
            fileName={fileName || "Pasted rows"}
            mapping={mapping.index}
            canSeeAmounts={canSeeAmounts}
            targets={targets}
            nameMap={nameMap}
            onName={(value, target) => {
              if (!suggestedNames || !nameMap) return;
              unuse();
              setNameEdit({ base: suggestedNames, map: { ...nameMap, [value]: target } });
            }}
            kept={kept.length}
            used={used}
            onDateOrder={(order) => goOn(order)}
            onUse={useRows}
            onStartAgain={startAgain}
          />
          {reading && <p role="status" className="text-sm text-muted-foreground">Reading…</p>}
        </section>
      )}
    </div>
  );
}

function RowsStep(props: {
  id: string;
  kind: ImportKind;
  read: ImportRead;
  loaded: { note: string | null };
  fileName: string;
  mapping: Record<string, number | null>;
  canSeeAmounts: boolean;
  targets: ImportWizardProps["targets"];
  nameMap: Record<string, string | null> | null;
  onName: (value: string, target: string | null) => void;
  kept: number;
  used: boolean;
  onDateOrder: (order: DateOrder) => void;
  onUse: () => void;
  onStartAgain: () => void;
}) {
  const { id, kind, read, targets, nameMap } = props;
  const spec = IMPORT_KINDS[kind];
  const matched = useMemo(() => new Set(spec.columns.filter((c) => props.mapping[c.id] !== null && props.mapping[c.id] !== undefined).map((c) => c.id)), [spec, props.mapping]);
  const table = useMemo(() => previewTable(spec, matched, read.preview, props.canSeeAmounts), [spec, matched, read.preview, props.canSeeAmounts]);
  const leftByName = read.rows.length - props.kept;

  let body: ReactNode;
  if (read.dateProblem === "mixed") {
    body = (
      <div role="alert" className="rounded-lg border border-crit bg-crit-soft p-3 text-sm">
        Some dates in the file can only be day first (like 13/03/2026) and others only month first (like 03/13/2026). Make them all the same way round, or use
        2026-03-13, and read it again.
      </div>
    );
  } else if (read.dateProblem === "ambiguous") {
    body = (
      <fieldset className="flex flex-col gap-2 rounded-lg border border-warn bg-warn-soft p-3 text-sm">
        <legend className="sr-only">Day and month order</legend>
        <span className="flex items-center gap-1 font-medium">
          Is 02/03/2026 in the file the 2nd of March or the 3rd of February?
          <Help
            label="Day and month order"
            description="Every date in this file reads both ways round, so say which it is. All the dates are then read the same way."
            example="Files from Australia and the UK are usually day first: 02/03/2026 is 2 March."
          />
        </span>
        <span className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2">
            <input type="radio" name={`${id}-order`} onChange={() => props.onDateOrder("dmy")} /> Day first (2 March)
            <Help label="Day first" description="Read every date as day, then month, then year." example="02/03/2026 is 2 March 2026." />
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name={`${id}-order`} onChange={() => props.onDateOrder("mdy")} /> Month first (3 February)
            <Help label="Month first" description="Read every date as month, then day, then year, as in the US." example="02/03/2026 is 3 February 2026." />
          </label>
        </span>
      </fieldset>
    );
  } else {
    body = (
      <>
        <p className="text-sm">
          Read <strong className="tabular-nums">{formatNumber(read.rows.length, 0)}</strong> rows. {formatNumber(read.errorCount, 0)} left out.
          {read.dateOrder && ` Dates read ${read.dateOrder === "dmy" ? "day first" : "month first"}.`}
          {leftByName > 0 && ` ${formatNumber(leftByName, 0)} more left out because their name isn't matched.`}
        </p>
        {read.note && <p className="text-sm text-muted-foreground">{read.note}</p>}
        {props.loaded.note && <p className="text-sm text-muted-foreground">{props.loaded.note}</p>}
        {table.rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm" data-import-preview>
              <caption className="px-3 py-2 text-left text-xs text-muted-foreground">
                The first {table.rows.length} rows. Client and person names are never shown or kept. They are used only to count.
              </caption>
              <thead>
                <tr className="border-y border-line text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                  {table.columns.map((c) => (
                    <th key={c.id} className="px-3 py-1.5">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {table.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} className="px-3 py-1.5 whitespace-nowrap">
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {read.errorCount > 0 && (
          <details data-import-errors>
            <summary className="cursor-pointer text-sm text-muted-foreground">Rows left out ({formatNumber(read.errorCount, 0)})</summary>
            <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
              {read.errors.map((e) => (
                <li key={e.line}>
                  Line {e.line}: {e.message}
                </li>
              ))}
              {read.errorCount > read.errors.length && <li>and {formatNumber(read.errorCount - read.errors.length, 0)} more.</li>}
            </ul>
          </details>
        )}
        {nameMap && targets && read.names.length > 0 && (
          <section aria-labelledby={`${id}-names`} data-import-names className="flex flex-col gap-2">
            <h4 id={`${id}-names`} className="flex items-center text-sm font-semibold">
              Match the names
              <Help
                label="Match the names"
                description={`Each name in the file is matched to one in your model (${targets.label.toLowerCase()}). A name that is the same apart from case and spacing is matched for you. Rows with a name set to Leave out are not used.`}
                example="Qualified lead → Qualify"
              />
            </h4>
            <ul className="flex max-h-80 flex-col divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {read.names.map((n, i) => (
                <li key={n.value} className="grid items-center gap-x-4 gap-y-1 px-3 py-2 text-sm md:grid-cols-2">
                  <label htmlFor={`${id}-name-${i}`} className="min-w-0 break-words">
                    {n.value} <span className="text-muted-foreground">({formatNumber(n.rows, 0)} rows)</span>
                  </label>
                  <ColumnSelect id={`${id}-name-${i}`} value={nameMap[n.value] ?? ""} onChange={(e) => props.onName(n.value, e.target.value === "" ? null : e.target.value)}>
                    <option value="">Leave out</option>
                    {targets.names.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </ColumnSelect>
                </li>
              ))}
            </ul>
          </section>
        )}
      </>
    );
  }

  return (
    <>
      {body}
      <div className="flex flex-wrap items-center gap-2">
        {read.dateProblem === null && (
          <>
            {props.used ? (
              <span role="status" className="text-sm font-medium">
                Using {formatNumber(props.kept, 0)} rows from {props.fileName}.
              </span>
            ) : (
              <Button type="button" disabled={props.kept === 0} onClick={props.onUse}>
                Use these rows
              </Button>
            )}
            <Help
              label="Use these rows"
              description="Use the rows that were read, with the names as matched, for what is below. Nothing is saved yet: only the file's name, its columns and counts are kept when you save, never the rows."
              example="Use 312 rows, then check what they would change before applying anything."
            />
          </>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={props.onStartAgain}>
          Start again
        </Button>
        {read.dateProblem === null && props.kept === 0 && <span className="text-sm text-muted-foreground">No rows to use.</span>}
      </div>
    </>
  );
}
