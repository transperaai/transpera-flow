"use client";

// Evidence on the process page (issue #21, docs/PRD.md §4.1 "Sources and
// evidence", §7.1b): what each value cites in the step inspector, with a
// form to cite a source, and the draft's checklist rail, which lists every
// conflict and then every assumption for confirming or editing inline.

import { useId, useState } from "react";
import { Help } from "@/components/help";
import {
  EVIDENCE_COLUMNS,
  EVIDENCE_LABELS,
  checklistItems,
  columnProvenance,
  conflictRange,
  evidenceOf,
  formatParameter,
  isOpenAssumption,
  openConflict,
  stepValue,
  type ChecklistItem,
  type ConflictValue,
  type EvidenceCitation,
  type EvidenceColumn,
  type EvidenceStamp,
  type ProcessBundle,
  type SourceRow,
  type StepRow,
} from "@transpera-flow/db";
import { updateStep } from "@/lib/editor/commands";
import type { ProcessEditor } from "@/lib/editor/editor";
import { citeEdit, confirmEdit, removeCitationEdit } from "@/lib/editor/evidence";

const button = "rounded-token border border-line bg-panel px-1.5 py-0.5 font-semibold hover:bg-panel-2";
const primary = "rounded-token bg-accent px-2 py-0.5 font-semibold text-accent-fg disabled:opacity-50";
const inputClass = "w-full rounded-token border border-line bg-panel px-2 py-1";

/** Units a person states a value in: hours, a percentage, items. */
const UNITS: Record<EvidenceColumn, { unit: string; scale: number }> = {
  work_hours: { unit: "h", scale: 1 },
  wait_hours: { unit: "h", scale: 1 },
  sla_hours: { unit: "h", scale: 1 },
  rework_rate: { unit: "%", scale: 100 },
  current_wip: { unit: "items", scale: 1 },
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const show = (column: EvidenceColumn, v: number | null) => (v === null ? "not entered" : formatParameter(column, v));
const who = (v: ConflictValue) => v.speaker ?? (v.source_id ? "a source" : "entered value");

/** "Strategy walkthrough", or a note that the source is gone. */
function sourceTitle(sources: readonly SourceRow[], id: string) {
  return sources.find((s) => s.id === id)?.title ?? "a deleted source";
}

/** One value's quotes: “…” — speaker, source, timestamp, what they said. */
export function CitationList({
  column,
  citations,
  sources,
  onRemove,
}: {
  column: EvidenceColumn;
  citations: readonly EvidenceCitation[];
  sources: readonly SourceRow[];
  onRemove?: (index: number) => void;
}) {
  if (!citations.length) return null;
  return (
    <ul className="flex flex-col gap-1">
      {citations.map((c, i) => (
        <li key={i} className="flex items-start justify-between gap-2 rounded-token bg-panel-2 px-1.5 py-1">
          <blockquote className="min-w-0">
            <span className="text-fg">“{c.quote}”</span>
            <span className="block text-fg-3">
              {[c.speaker, sourceTitle(sources, c.source_id), c.timestamp, typeof c.value === "number" && `says ${formatParameter(column, c.value)}`]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </blockquote>
          {onRemove && (
            <button type="button" className="shrink-0 text-fg-3 hover:text-crit" aria-label={`Remove the citation “${c.quote}”`} onClick={() => onRemove(i)}>
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A conflict's values and the ways to settle it: keep the range, or use one side's number. */
function ConflictChoices({
  column,
  values,
  onKeepRange,
  onUse,
}: {
  column: EvidenceColumn;
  values: readonly ConflictValue[];
  onKeepRange: (() => void) | null;
  onUse: ((value: number) => void) | null;
}) {
  const range = conflictRange(values.map((v) => Number(v.value)));
  const duration = column === "work_hours" || column === "wait_hours";
  return (
    <div className="flex flex-col gap-1">
      <p>
        Sources disagree: {values.map((v) => `${capital(who(v))} ${formatParameter(column, Number(v.value))}`).join(" vs ")}.{" "}
        {duration
          ? `Simulated as a range from ${formatParameter(column, range.min)} to ${formatParameter(column, range.max)}, most likely ${formatParameter(column, range.mode)}.`
          : `Simulated at ${formatParameter(column, range.mode)}; robustness checks the whole range.`}
      </p>
      {(onKeepRange || onUse) && (
        <div className="flex flex-wrap gap-1">
          {onKeepRange && (
            <button type="button" className={button} onClick={onKeepRange}>
              {duration ? "Keep the range" : "Keep this value"}
            </button>
          )}
          {onUse &&
            values.map((v, i) => (
              <button key={i} type="button" className={button} onClick={() => onUse(Number(v.value))}>
                Use {formatParameter(column, Number(v.value))} ({who(v)})
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** Set a value inline: a number in the column's units, then Set. */
function InlineValue({ column, current, onSet }: { column: EvidenceColumn; current: number | null; onSet: (value: number) => void }) {
  const id = useId();
  const { unit, scale } = UNITS[column];
  const [text, setText] = useState("");
  const value = text.trim() === "" ? NaN : Number(text) / scale;
  const valid = Number.isFinite(value) && value >= 0 && (column !== "rework_rate" || value <= 0.95) && (column !== "current_wip" || Number.isInteger(value));
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSet(value);
        setText("");
      }}
    >
      <label htmlFor={id} className="sr-only">
        New {EVIDENCE_LABELS[column]} ({unit})
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={text}
        placeholder={current === null ? "" : String(Math.round(current * scale * 100) / 100)}
        onChange={(e) => setText(e.target.value)}
        className="w-20 rounded-token border border-line bg-panel px-1.5 py-0.5 tabular-nums"
      />
      <span className="text-fg-3">{unit}</span>
      <Help
        label="New value"
        description="Settle the disagreement by choosing the number to use for this step, once you have decided which source is right."
        example="Two sources say 6 h and 12 h, and the strategist confirms 9 h: enter 9."
      />
      <button type="submit" disabled={!valid} className={button}>
        Set
      </button>
    </form>
  );
}

/** A step's evidence in the inspector: per value, its quotes, conflict and assumption, and a form to cite a source. */
export function EvidencePanel({
  step,
  editor,
  sources,
  stamp,
  sourcesHref,
}: {
  step: StepRow;
  editor: ProcessEditor;
  sources: readonly SourceRow[];
  stamp: () => EvidenceStamp;
  sourcesHref?: string;
}) {
  const id = step.id;
  const columns = EVIDENCE_COLUMNS.filter((c) => evidenceOf(step, c).length || openConflict(step, c) || isOpenAssumption(step, c));
  return (
    <section aria-label="Evidence" className="flex flex-col gap-2 border-t border-line pt-3 text-xs">
      <p className="flex items-center font-semibold text-fg">
        Evidence
        <Help
          label="Evidence"
          description="Where a number on this step came from: a quote from a transcript, a note or a document. It is how someone else can check the number."
          example="“A proper audit takes a day” from the strategy walkthrough backs the 9 h hands-on time."
        />
      </p>
      {columns.length === 0 && <p className="text-fg-3">No value cites a source yet.</p>}
      {columns.map((column) => {
        const conflict = openConflict(step, column);
        const entry = columnProvenance(step, column);
        const assumption = isOpenAssumption(step, column);
        return (
          <div
            key={column}
            className={`flex flex-col gap-1 rounded-token border p-1.5 ${conflict ? "border-crit bg-crit-soft" : assumption ? "border-warn bg-warn-soft" : "border-line"}`}
          >
            <p className="flex flex-wrap items-baseline justify-between gap-1">
              <span>
                <strong>{capital(EVIDENCE_LABELS[column])}</strong> {show(column, stepValue(step, column))}
              </span>
              <span className="text-fg-3">
                {conflict ? "Conflict" : assumption ? "Assumption" : entry?.source === "entered" ? "Entered" : "Estimated"}
              </span>
            </p>
            {conflict && (
              <ConflictChoices
                column={column}
                values={conflict.values}
                onKeepRange={() => editor.run((b) => confirmEdit(b, id, column, stamp()))}
                onUse={(v) => editor.run((b) => confirmEdit(b, id, column, stamp(), v))}
              />
            )}
            {entry?.note && <p className="text-fg-2">Reasoning: {entry.note}</p>}
            {assumption && (
              <button type="button" className={`${primary} self-start`} onClick={() => editor.run((b) => confirmEdit(b, id, column, stamp()))}>
                Confirm {show(column, stepValue(step, column))}
              </button>
            )}
            <CitationList
              column={column}
              citations={evidenceOf(step, column)}
              sources={sources}
              onRemove={(i) => editor.run((b) => removeCitationEdit(b, id, column, i, stamp()))}
            />
          </div>
        );
      })}
      <CiteForm step={step} sources={sources} sourcesHref={sourcesHref} onCite={(column, citation) => editor.run((b) => citeEdit(b, id, column, citation, stamp()))} />
    </section>
  );
}

function CiteForm({
  step,
  sources,
  sourcesHref,
  onCite,
}: {
  step: StepRow;
  sources: readonly SourceRow[];
  sourcesHref?: string;
  onCite: (column: EvidenceColumn, citation: EvidenceCitation) => void;
}) {
  const [open, setOpen] = useState(false);
  const [column, setColumn] = useState<EvidenceColumn>("work_hours");
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [speaker, setSpeaker] = useState("");
  const [quote, setQuote] = useState("");
  const [timestamp, setTimestamp] = useState("");
  const [value, setValue] = useState("");
  const listId = useId();
  const { unit, scale } = UNITS[column];
  const source = sources.find((s) => s.id === sourceId);
  const stated = value.trim() === "" ? null : Number(value) / scale;
  const valid = !!source && quote.trim().length > 0 && (stated === null || (Number.isFinite(stated) && stated >= 0));

  if (!open) {
    return (
      <button type="button" className={`${button} self-start`} onClick={() => setOpen(true)}>
        Cite a source…
      </button>
    );
  }
  if (!sources.length) {
    return (
      <p className="text-fg-2">
        No sources yet. {sourcesHref ? <a href={sourcesHref} className="underline">Add the audit&apos;s transcripts and notes</a> : "Add them"} first.
      </p>
    );
  }
  return (
    <form
      aria-label="Cite a source"
      className="flex flex-col gap-1.5 rounded-token border border-line p-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onCite(column, {
          source_id: sourceId,
          speaker: speaker.trim() || null,
          quote: quote.trim(),
          timestamp: timestamp.trim() || null,
          ...(stated === null ? {} : { value: column === "current_wip" ? Math.round(stated) : stated }),
        });
        setQuote("");
        setTimestamp("");
        setValue("");
        setOpen(false);
      }}
    >
      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex flex-col gap-0.5">
          <span className="flex items-center text-fg-2">
            Value
            <Help label="Value" description="Which number on this step the source backs up." example="Hands-on time, if the quote is about how long the work takes." />
          </span>
          <select className={inputClass} value={column} onChange={(e) => setColumn(e.target.value as EvidenceColumn)}>
            {EVIDENCE_COLUMNS.map((c) => (
              <option key={c} value={c}>
                {capital(EVIDENCE_LABELS[c])}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="flex items-center text-fg-2">
            Source
            <Help label="Source" description="The transcript, note or document the quote comes from. Add sources on the Sources page." example="“Strategy walkthrough, 12 Sep”." />
          </span>
          <select className={inputClass} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="flex items-center text-fg-2">
            Speaker
            <Help label="Speaker" description="Who said it, so you can weigh how close they are to the work." example="Maya Collins, the strategist who does the audits." />
          </span>
          <input className={inputClass} list={listId} value={speaker} onChange={(e) => setSpeaker(e.target.value)} maxLength={200} />
          <datalist id={listId}>
            {source?.speakers.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="flex items-center text-fg-2">
            Where (time or page)
            <Help label="Where" description="The moment in a recording or the page in a document, so the quote can be found again." example="00:14:05 in a call, or page 3 of a report." />
          </span>
          <input className={inputClass} value={timestamp} onChange={(e) => setTimestamp(e.target.value)} placeholder="00:14:05" maxLength={100} />
        </label>
      </div>
      <label className="flex flex-col gap-0.5">
        <span className="flex items-center text-fg-2">
          Quote
          <Help label="Quote" description="The exact words from the source that support the number." example="“A proper audit and proposal is a day's work, call it six hours.”" />
        </span>
        <textarea className={inputClass} rows={2} value={quote} onChange={(e) => setQuote(e.target.value)} maxLength={2000} required />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="flex items-center text-fg-2">
          The value they stated ({unit}, optional; current {show(column, stepValue(step, column))})
          <Help
            label="The value they stated"
            description="The number the speaker gave. If it differs from another source's number, the step is marked as a conflict and simulated as the range between them."
            example="Maya says 6 hours and Rosa says 12: the step is simulated between 6 and 12."
          />
        </span>
        <input className={inputClass} type="number" inputMode="decimal" min={0} step="any" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <p className="text-fg-3">A stated value that differs from another source&apos;s makes the value a conflict, simulated as the range between them.</p>
      <div className="flex gap-1.5">
        <button type="submit" disabled={!valid} className={primary}>
          Cite
        </button>
        <button type="button" className={button} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The draft's checklist rail (docs/PRD.md §7.1b): conflicts first, then
 * every assumption, each with its value, the reasoning and the quote.
 * Confirming one makes it `entered`; editing sets a new value, also entered.
 */
export function AssumptionChecklist({
  bundle,
  editor,
  sources,
  stamp,
  onSelect,
}: {
  bundle: ProcessBundle;
  /** Null when read-only. */
  editor: ProcessEditor | null;
  sources: readonly SourceRow[];
  stamp: () => EvidenceStamp;
  onSelect: (stepId: string) => void;
}) {
  const items = checklistItems(bundle.steps);
  if (!items.length) return null;
  const conflicts = items.filter((i) => i.kind === "conflict").length;
  const assumptions = items.length - conflicts;
  return (
    <section aria-label="Assumptions to confirm" className="flex flex-col gap-2 rounded-token border border-line bg-panel p-3 text-xs shadow-token">
      <h2 className="text-sm font-bold">
        To confirm ({[conflicts && `${conflicts} conflict${conflicts === 1 ? "" : "s"}`, assumptions && `${assumptions} assumption${assumptions === 1 ? "" : "s"}`].filter(Boolean).join(", ")})
      </h2>
      <p className="text-fg-3">Publishing waits until these are settled, or accepted as estimates.</p>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={`${item.stepId}:${item.column ?? "step"}`}>
            <ChecklistEntry item={item} bundle={bundle} editor={editor} sources={sources} stamp={stamp} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChecklistEntry({
  item,
  editor,
  sources,
  stamp,
  onSelect,
}: {
  item: ChecklistItem;
  bundle: ProcessBundle;
  editor: ProcessEditor | null;
  sources: readonly SourceRow[];
  stamp: () => EvidenceStamp;
  onSelect: (stepId: string) => void;
}) {
  const { stepId: id, column } = item;
  const conflict = item.kind === "conflict";
  return (
    <div className={`flex flex-col gap-1 rounded-token border p-1.5 ${conflict ? "border-crit" : "border-warn"}`}>
      <p className="flex flex-wrap items-baseline gap-1">
        <span
          className={`rounded-full border px-1 text-2xs font-semibold ${conflict ? "border-crit bg-crit-soft" : "border-warn bg-warn-soft"}`}
        >
          {conflict ? "Conflict" : "Assumption"}
        </span>
        <button type="button" className="font-semibold hover:underline" onClick={() => onSelect(id)}>
          {item.stepName}
        </button>
        {column && (
          <span className="text-fg-2">
            {EVIDENCE_LABELS[column]} {show(column, item.value)}
          </span>
        )}
      </p>
      {column && conflict && item.values && (
        <ConflictChoices
          column={column}
          values={item.values}
          onKeepRange={editor ? () => editor.run((b) => confirmEdit(b, id, column, stamp())) : null}
          onUse={editor ? (v) => editor.run((b) => confirmEdit(b, id, column, stamp(), v)) : null}
        />
      )}
      {item.reasoning && <p className="text-fg-2">Reasoning: {item.reasoning}</p>}
      {column ? (
        <CitationList column={column} citations={item.evidence} sources={sources} />
      ) : (
        <p className="text-fg-2">The step&apos;s values are estimates nobody has confirmed.</p>
      )}
      {editor && (
        <div className="flex flex-wrap items-center gap-1.5">
          {column ? (
            <>
              {!conflict && (
                <button type="button" className={primary} onClick={() => editor.run((b) => confirmEdit(b, id, column, stamp()))}>
                  Confirm
                </button>
              )}
              <InlineValue column={column} current={item.value} onSet={(v) => editor.run((b) => confirmEdit(b, id, column, stamp(), v))} />
            </>
          ) : (
            <button type="button" className={primary} onClick={() => editor.run((b) => updateStep(b, id, { assumption: false }))}>
              Confirm values
            </button>
          )}
        </div>
      )}
    </div>
  );
}
