"use client";

// Settings → Historical data (issue #41, C2 part 1): read a step log for one process, show what it measures beside the
// values the model has now, and apply the changes a person ticks. Nothing changes until they apply, and values someone
// entered or measured are never ticked for them. Step values go into the process's draft (published as usual); lead
// volumes change live. On the demo nothing is saved.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { calibrate, type CalibrationProposal, type CalibrationResult } from "@transpera-flow/engine";
import { calibrationInput, parseStepLog, STEP_LOG_TEMPLATE, type CalibrationRows, type ParsedStepLog } from "@transpera-flow/db/calibration";
import { Help, HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { applySummary, formatValue, formatWindow, groupProposals, initiallySelected, KIND_LABELS, selectable, SOURCE_LABELS } from "@/lib/calibration/view";
import { formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { applyCalibration } from "@/app/w/[slug]/settings/calibration/actions";

export type CalibrationMode = "live" | "readonly" | "demo";

export interface CalibrationPanelProps {
  mode: CalibrationMode;
  workspaceId: string | null;
  /** Where the process's pages are (`/w/<slug>`), for the Editor link; null on the demo. */
  base: string | null;
  processes: { id: string; name: string; kind: string }[];
  process: { id: string; name: string; kind: string };
  hasDraft: boolean;
  stored: CalibrationRows;
  history: { id: string; createdAt: string; fileName: string; rowCount: number; proposals: number; applied: number }[];
  /** A log to try (the demo's sample). */
  sample?: { name: string; text: string };
}

type Read = { fileName: string; log: ParsedStepLog; result: CalibrationResult | null };
type Done = { tone: "ok" | "error"; message: string; editor: boolean };

const SOURCE_TONE = {
  estimated: "border-warn bg-warn-soft",
  entered: "border-line bg-panel-2",
  measured: "border-good bg-good-soft",
} as const;

export function CalibrationPanel(props: CalibrationPanelProps) {
  const { mode, process, stored } = props;
  const canApply = mode !== "readonly";
  const router = useRouter();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [read, setRead] = useState<Read | null>(null);
  const [reading, setReading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Done | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);

  const readLog = (body: string, name: string) => {
    setReading(true);
    setDone(null);
    // Let the page show "Reading…" before a big log is parsed.
    setTimeout(() => {
      const log = parseStepLog(body);
      const result = log.missing.length || !log.rows.length ? null : calibrate(calibrationInput(stored, log.rows));
      setRead({ fileName: name || "Pasted log", log, result });
      setSelected(new Set(result ? result.proposals.filter(initiallySelected).map((p) => p.key) : []));
      setApplied(new Set());
      setReading(false);
    }, 0);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 20_000_000) {
      setDone({ tone: "error", message: "That file is over 20 MB. Split it by date and read each part.", editor: false });
      return;
    }
    const body = await file.text();
    setFileName(file.name);
    setText("");
    readLog(body, file.name);
  };

  const toggle = (key: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const apply = () => {
    if (!read?.result) return;
    const keys = [...selected].filter((k) => !applied.has(k));
    if (!keys.length) return;
    const subjects = new Map(read.result.proposals.map((p) => [p.key, `${p.subject} (${KIND_LABELS[p.kind].title.toLowerCase()})`]));
    if (mode === "demo") {
      setApplied(new Set([...applied, ...keys]));
      setSelected(new Set());
      setDone({
        tone: "ok",
        message: `Demo: nothing is saved. In a workspace, ${keys.length} change${keys.length === 1 ? "" : "s"} would be applied: changes to steps go into the process's draft to publish, and lead volumes change straight away.`,
        editor: false,
      });
      return;
    }
    start(async () => {
      const out = await applyCalibration({
        workspaceId: props.workspaceId,
        processId: process.id,
        fileName: read.fileName,
        columnMap: read.log.columns,
        rowCount: read.log.rows.length,
        results: read.result,
        keys,
      });
      if (out.status === "error") {
        setDone({ tone: "error", message: out.message, editor: false });
        return;
      }
      const ok = out.results.filter((r) => r.status === "applied").map((r) => r.key);
      setApplied(new Set([...applied, ...ok]));
      setSelected(new Set());
      setDone({
        tone: "ok",
        message: applySummary(out.results, subjects, out.draft?.number ?? null),
        editor: ok.some((k) => !k.startsWith("arrivals:")),
      });
    });
  };

  const groups = useMemo(() => (read?.result ? groupProposals(read.result.proposals) : []), [read]);
  const chosen = [...selected].filter((k) => !applied.has(k)).length;
  const editorHref = props.base ? `${props.base}/p/${process.id}/edit` : null;

  return (
    <div className="flex flex-col gap-6">
      <Card role="region" aria-labelledby="cal-process-heading">
        <CardHeader>
          <h2 id="cal-process-heading" className="font-heading text-base font-medium">
            1. Choose the process
          </h2>
          <CardDescription>The log is read against this process&apos;s steps, by their names.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <label className="flex max-w-md flex-col gap-1">
            <HelpLabel
              label="Process"
              description="The process the log comes from. Each row's step must have the same name as a step on its map. Lead volumes are measured only for the process where new leads arrive."
              example="Pick “Lead to live client” for a log of deals from your CRM."
            />
            <NativeSelect
              value={process.id}
              disabled={props.processes.length < 2}
              onChange={(e) => {
                if (props.base) router.push(`${props.base}/settings/calibration?process=${e.target.value}`);
              }}
            >
              {props.processes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          {props.hasDraft && (
            <p className="text-sm text-muted-foreground">
              This process has a draft. The log is compared with the draft, and changes you apply are added to it.
            </p>
          )}
        </CardContent>
      </Card>

      <Card role="region" aria-labelledby="cal-log-heading">
        <CardHeader>
          <h2 id="cal-log-heading" className="font-heading text-base font-medium">
            2. Add the log
          </h2>
          <CardDescription>
            One row for each item at each step it went through: a CSV file, or rows pasted from a spreadsheet. It is read in your browser. Only its
            name, its columns and the results are kept, not the rows.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="font-mono text-xs leading-5">item</dt>
            <dd className="text-muted-foreground">What went through: a deal, a job or a report. Any id.</dd>
            <dt className="font-mono text-xs leading-5">step</dt>
            <dd className="text-muted-foreground">The step&apos;s name as on the map. Log end steps such as Won and Lost too.</dd>
            <dt className="font-mono text-xs leading-5">started</dt>
            <dd className="text-muted-foreground">When it started: 2026-03-02 09:30, or day first 02/03/2026 09:30.</dd>
            <dt className="font-mono text-xs leading-5">finished</dt>
            <dd className="text-muted-foreground">Optional. When it finished. Needed for waiting times.</dd>
            <dt className="font-mono text-xs leading-5">hours</dt>
            <dd className="text-muted-foreground">Optional. Hands-on hours spent. Needed for hands-on time.</dd>
            <dt className="font-mono text-xs leading-5">source</dt>
            <dd className="text-muted-foreground">Optional. The lead source, as named in Settings. Needed for leads a week.</dd>
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" type="button" onClick={() => fileInput.current?.click()}>
              Choose a CSV file
            </Button>
            <input ref={fileInput} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sr-only" aria-label="CSV file" onChange={(e) => onFile(e.target.files?.[0])} />
            <a
              className="text-sm text-accent underline-offset-4 hover:underline"
              download="step-log-template.csv"
              href={`data:text/csv;charset=utf-8,${encodeURIComponent(STEP_LOG_TEMPLATE)}`}
            >
              Download the template
            </a>
            {props.sample && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => {
                  setText(props.sample!.text);
                  setFileName(props.sample!.name);
                  readLog(props.sample!.text, props.sample!.name);
                }}
              >
                Use a sample log
              </Button>
            )}
          </div>
          <label className="flex flex-col gap-1">
            <HelpLabel
              label="Or paste the rows"
              description="Paste rows copied from a spreadsheet or a CSV, with the column names in the first row. Columns can be in any order; other columns are ignored."
              example="item, step, started, finished, hours: D-101, Proposal, 2026-03-03 13:00, 2026-03-03 17:00, 4"
            />
            <Textarea
              value={text}
              rows={6}
              spellCheck={false}
              className="font-mono text-xs"
              placeholder={STEP_LOG_TEMPLATE.split("\n").slice(0, 3).join("\n")}
              onChange={(e) => {
                setText(e.target.value);
                setFileName("");
              }}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={!text.trim() || reading} onClick={() => readLog(text, fileName)}>
              {reading ? "Reading…" : "Read the log"}
            </Button>
            {fileName && <span className="text-sm text-muted-foreground">{fileName}</span>}
          </div>
        </CardContent>
      </Card>

      {read && <LogSummary read={read} />}

      {read?.result && (
        <Card role="region" aria-labelledby="cal-diff-heading">
          <CardHeader>
            <h2 id="cal-diff-heading" className="font-heading text-base font-medium">
              3. Check the changes
            </h2>
            <CardDescription>
              What the log measured, beside what {process.name} has now. Tick the ones to apply. Values you entered or measured before are never
              ticked for you. Fewer than {read.result.minSample} items is too few to measure, so nothing is proposed.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {groups.map((g) => (
              <ProposalGroup
                key={g.kind}
                kind={g.kind}
                proposals={g.proposals}
                selected={selected}
                applied={applied}
                canApply={canApply}
                onToggle={toggle}
              />
            ))}
            {groups.length === 0 && <p className="text-sm text-muted-foreground">Nothing in the log matches a step of {process.name}.</p>}
            {canApply ? (
              <div className="sticky bottom-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-2 shadow-xs">
                <span className="text-sm">
                  <span className="tabular-nums font-medium">{chosen}</span> ticked
                </span>
                <Help
                  label="Apply"
                  description="Changes to steps go into this process's draft: check them in the Editor, then publish to use them. Lead volumes change straight away, as an edit in Settings does. Each is marked as measured, with this log as where it came from."
                  example="Applying a hands-on time of 6.4 hours for Audit & proposal opens a draft with 6.4 hours, marked Measured."
                />
                <span className="grow" />
                <Button type="button" disabled={!chosen || pending} onClick={apply}>
                  {pending ? "Applying…" : `Apply ${chosen || ""} ticked`.replace("  ", " ")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">You can see what the log measures here; owners and editors can apply it.</p>
            )}
            {done && (
              <div
                role="status"
                className={cn("rounded-lg border p-3 text-sm", done.tone === "ok" ? "border-good bg-good-soft" : "border-crit bg-crit-soft")}
              >
                {done.message}
                {done.editor && editorHref && (
                  <>
                    {" "}
                    <Link href={editorHref} className="font-medium text-accent underline-offset-4 hover:underline">
                      Open the draft in the Editor
                    </Link>
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {props.history.length > 0 && (
        <Card role="region" aria-labelledby="cal-history-heading">
          <CardHeader>
            <h2 id="cal-history-heading" className="font-heading text-base font-medium">
              Earlier logs for {process.name}
            </h2>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y divide-line text-sm">
              {props.history.map((h) => (
                <li key={h.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
                  <span className="min-w-0 truncate font-medium">{h.fileName}</span>
                  <span className="text-muted-foreground">
                    {new Date(h.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} ·{" "}
                    {formatNumber(h.rowCount, 0)} rows · applied {h.applied} of {h.proposals}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function LogSummary({ read }: { read: Read }) {
  const { log, result } = read;
  if (log.missing.length) {
    return (
      <div role="alert" className="rounded-lg border border-crit bg-crit-soft p-3 text-sm">
        The log has no {log.missing.join(", ")} column. The first row must name the columns: item, step and started at least.
      </div>
    );
  }
  return (
    <section aria-label="What was read" className="flex flex-col gap-2 rounded-lg border border-line bg-panel-2 p-3 text-sm">
      <p>
        Read <strong className="tabular-nums">{formatNumber(log.rows.length, 0)}</strong> rows
        {result && (
          <>
            {" "}
            about <strong className="tabular-nums">{formatNumber(result.items, 0)}</strong> items, over {formatWindow(result.window)}
          </>
        )}
        .
        {log.errors.length > 0 && ` ${log.errors.length} row${log.errors.length === 1 ? " was" : "s were"} left out.`}
      </p>
      {log.errors.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Rows left out</summary>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {log.errors.slice(0, 20).map((e) => (
              <li key={e.line}>
                Line {e.line}: {e.message}
              </li>
            ))}
            {log.errors.length > 20 && <li>and {log.errors.length - 20} more.</li>}
          </ul>
        </details>
      )}
      {result && result.unmatchedSteps.length > 0 && (
        <p className="text-muted-foreground">
          Not a step of this process, so left out: {result.unmatchedSteps.map((u) => `${u.name} (${u.rows})`).join(", ")}. Rename them in the log to
          match the map.
        </p>
      )}
      {result && result.unmatchedSources.length > 0 && (
        <p className="text-muted-foreground">
          Not a lead source in Settings: {result.unmatchedSources.map((u) => `${u.name} (${u.items})`).join(", ")}.
        </p>
      )}
    </section>
  );
}

function ProposalGroup({
  kind,
  proposals,
  selected,
  applied,
  canApply,
  onToggle,
}: {
  kind: CalibrationProposal["kind"];
  proposals: CalibrationProposal[];
  selected: Set<string>;
  applied: Set<string>;
  canApply: boolean;
  onToggle: (key: string, on: boolean) => void;
}) {
  const label = KIND_LABELS[kind];
  const offered = proposals.filter(selectable);
  const rest = proposals.filter((p) => !selectable(p));
  return (
    <section aria-labelledby={`cal-${kind}`} className="flex flex-col gap-2">
      <h3 id={`cal-${kind}`} className="flex items-center gap-1 text-sm font-semibold">
        {label.title}
        <Help label={label.title} description={label.description} example={label.example} />
      </h3>
      <div className="hidden grid-cols-[1.5rem_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_4.5rem] gap-x-3 px-2 text-2xs font-semibold tracking-wider text-muted-foreground uppercase sm:grid">
        <span />
        <span>{kind === "arrivals" ? "Lead source" : "Step"}</span>
        <span>Now</span>
        <span>From the log</span>
        <span className="text-right">Items</span>
      </div>
      {offered.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {offered.map((p) => (
            <ProposalRow key={p.key} p={p} checked={selected.has(p.key)} applied={applied.has(p.key)} canApply={canApply} onToggle={onToggle} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No changes to propose.</p>
      )}
      {rest.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Not proposed: {rest.length} ({rest.filter((p) => p.enough && !p.changed).length} already match, {rest.filter((p) => !p.set).length} can&apos;t be
            measured)
          </summary>
          <ul className="mt-2 flex flex-col divide-y divide-line rounded-lg border border-dashed border-line">
            {rest.map((p) => (
              <li key={p.key} className="flex flex-wrap justify-between gap-x-4 gap-y-1 px-3 py-2">
                <span className="font-medium">{p.subject}</span>
                <span className="text-muted-foreground">{p.blocked ?? `Matches what the model has (${p.n} items).`}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function SourceBadge({ source }: { source: CalibrationProposal["currentSource"] }) {
  return (
    <span data-provenance={source} className={cn("inline-block rounded-token border px-1.5 text-[11px] leading-4 text-fg-2", SOURCE_TONE[source])}>
      {SOURCE_LABELS[source]}
    </span>
  );
}

function ProposalRow({
  p,
  checked,
  applied,
  canApply,
  onToggle,
}: {
  p: CalibrationProposal;
  checked: boolean;
  applied: boolean;
  canApply: boolean;
  onToggle: (key: string, on: boolean) => void;
}) {
  const id = `cal-${p.key}`;
  const known = p.currentSource !== "estimated";
  return (
    <li className={cn("grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-2 py-2.5 sm:grid-cols-[1.5rem_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_4.5rem]", applied && "bg-good-soft")}>
      <span className="flex h-5 items-center">
        {canApply && !applied ? (
          <input id={id} type="checkbox" className="size-4 accent-accent" checked={checked} onChange={(e) => onToggle(p.key, e.target.checked)} />
        ) : applied ? (
          <span aria-label="Applied" className="text-good">
            ✓
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <label htmlFor={id} className="font-medium">
            {p.subject}
          </label>
          <SourceBadge source={p.currentSource} />
          <Help label={`${p.subject}, from the log`} description={p.note} example={exampleFor(p)} />
        </span>
        {known && !applied && <span className="text-xs text-muted-foreground">Now {SOURCE_LABELS[p.currentSource].toLowerCase()}: tick it only to replace it.</span>}
        {applied && <span className="text-xs text-muted-foreground">Applied.</span>}
      </span>
      <Values p={p} />
      <span className="col-start-2 text-xs text-muted-foreground tabular-nums sm:col-start-auto sm:text-right sm:text-sm">
        <span className="sm:hidden">From </span>
        {formatNumber(p.n, 0)}
        <span className="sm:hidden"> items</span>
      </span>
    </li>
  );
}

function Values({ p }: { p: CalibrationProposal }) {
  if (p.kind === "routing") {
    return (
      <span className="col-start-2 flex flex-col gap-0.5 text-sm sm:col-span-2 sm:col-start-auto">
        {p.branches!.map((b) => (
          <span key={b.edgeId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 sm:grid-cols-2">
            <span className="min-w-0 break-words">
              <span className="text-muted-foreground">to {b.toName}</span> <span className="tabular-nums">{b.current === null ? "—" : formatPercent(b.current)}</span>
            </span>
            <span className="tabular-nums font-medium">
              <span aria-hidden className="mr-1 text-muted-foreground sm:hidden">→</span>
              {b.proposed === null ? "—" : formatPercent(b.proposed)}
            </span>
          </span>
        ))}
      </span>
    );
  }
  return (
    <>
      <span className="col-start-2 text-sm tabular-nums sm:col-start-auto">
        <span className="text-muted-foreground sm:hidden">Now </span>
        {formatValue(p.kind, p.current, p.currentCv)}
      </span>
      <span className="col-start-2 text-sm font-medium tabular-nums sm:col-start-auto">
        <span className="font-normal text-muted-foreground sm:hidden">From the log </span>
        {formatValue(p.kind, p.proposed, p.proposedCv)}
      </span>
    </>
  );
}

function exampleFor(p: CalibrationProposal): string {
  if (p.kind === "routing") return `Applying sets the odds out of ${p.subject} to ${p.branches!.map((b) => `${b.proposed === null ? "—" : formatPercent(b.proposed)} to ${b.toName}`).join(", ")}.`;
  return `Applying changes ${p.subject} from ${formatValue(p.kind, p.current, p.currentCv)} to ${formatValue(p.kind, p.proposed, p.proposedCv)}.`;
}
