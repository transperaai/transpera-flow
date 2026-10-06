"use client";

// Settings → Historical data, "Clients and servicing work" (issue #41, C2 part 2): read a clients file and a servicing log, show
// each client group's normal churn as the file measures it (back-solved through today's churn drivers, so late work is not
// counted twice) beside the churn the model has now, and check the simulation's late work, response time and onboarding
// speed against what happened. The churn changes a person ticks are applied live, marked measured. The three checks are never
// applied. Both files are read in the browser; client ids and the rows are never stored. On the demo nothing is saved.

import { useMemo, useRef, useState, useTransition } from "react";
import { ModelError, toEngineModel, type ProcessBundle } from "@transpera-flow/db";
import { churnProposals, measureChurn, servicingChecks, type BackSolvedChurn, type CalibrationProposal, type ServicingCheckId } from "@transpera-flow/engine";
import {
  CLIENTS_TEMPLATE,
  SERVICING_LOG_TEMPLATE,
  clientCalibrationServices,
  decodeLogFile,
  parseClientsFile,
  parseServicingLog,
  servicingLinks,
  type ClientCalibrationRows,
  type DateOrder,
} from "@transpera-flow/db/calibration";
import { Help, HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { progressText, type ChurnJob } from "@/lib/calibration/backsolve";
import { CHECK_LABELS, CHECK_ORDER, CHURN_HELP, applySummary, formatAsOf, formatChurn, formatCheckValue, formatMultiplier, initiallySelected, selectable } from "@/lib/calibration/client-view";
import { useChurnBackSolve } from "@/lib/calibration/use-churn-backsolve";
import { SOURCE_LABELS } from "@/lib/calibration/view";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { recordClientCalibration } from "@/app/w/[slug]/settings/calibration/actions";

export type ClientCalibrationMode = "live" | "readonly" | "demo";

export interface ClientCalibrationPanelProps {
  mode: ClientCalibrationMode;
  workspaceId: string | null;
  /** Where the workspace's pages are (`/w/<slug>`), for the link to Client groups; null on the demo. */
  base: string | null;
  rows: ClientCalibrationRows;
  /** The live process that simulates each service's clients (the first is the default process), and the services it runs. */
  runs: { processId: string; processName: string; serviceIds: string[]; bundle: ProcessBundle | null }[];
  history: { id: string; createdAt: string; clientsFile: string | null; logFile: string | null; proposals: number; applied: number }[];
  /** The date the clients file is true on to start with: today, or the sample's date on the demo (YYYY-MM-DD). */
  defaultAsOf: string;
  /** Files to try (the demo's samples). */
  sample?: { clients: { name: string; text: string }; log: { name: string; text: string } };
}

/** A file that has been given to the page: its text, and which way round slashed dates were said to be. */
interface Source {
  fileName: string;
  text: string;
  note: string | null;
  order?: DateOrder;
}

type Done = { tone: "ok" | "error"; message: string };

const SOURCE_TONE = {
  estimated: "border-warn bg-warn-soft",
  entered: "border-line bg-panel-2",
  measured: "border-good bg-good-soft",
} as const;

const CANT_SIMULATE =
  "This workspace's live process can't be simulated yet, so today's driver pressure can't be measured. Fix it on the map first.";

/** The end of a YYYY-MM-DD day, as epoch milliseconds (a date with no time means the end of that day), or null. */
function endOfDay(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t).getUTCDate() === Number(m[3]) ? t + 86_400_000 - 1 : null;
}

export function ClientCalibrationPanel(props: ClientCalibrationPanelProps) {
  const { mode, rows } = props;
  const canApply = mode !== "readonly";
  const [clientsSource, setClientsSource] = useState<Source | null>(null);
  const [logSource, setLogSource] = useState<Source | null>(null);
  const [asOfText, setAsOfText] = useState(props.defaultAsOf);
  const [touched, setTouched] = useState<Map<string, boolean>>(new Map());
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Done | null>(null);
  const [pending, start] = useTransition();
  const asOf = endOfDay(asOfText);

  const services = useMemo(() => clientCalibrationServices(rows), [rows]);
  const links = useMemo(() => servicingLinks(rows), [rows]);

  const clients = useMemo(() => (clientsSource ? parseClientsFile(clientsSource.text, clientsSource.order ? { dateOrder: clientsSource.order } : {}) : null), [clientsSource]);
  const log = useMemo(() => (logSource ? parseServicingLog(logSource.text, logSource.order ? { dateOrder: logSource.order } : {}) : null), [logSource]);
  const clientRows = clients && clients.rows.length ? clients.rows : null;
  const logRows = log && log.rows.length ? log.rows : null;

  const measure = useMemo(() => (clientRows && asOf !== null ? measureChurn({ rows: clientRows, services, asOf }) : null), [clientRows, services, asOf]);
  const checks = useMemo(
    () => (logRows && asOf !== null ? servicingChecks({ log: logRows, clients: clientRows, links, services, hoursPerWeek: rows.hoursPerWeek, asOf }) : null),
    [logRows, clientRows, links, services, rows.hoursPerWeek, asOf],
  );

  // Each process's model, and why one can't be simulated.
  const models = useMemo(
    () =>
      props.runs.map((r) => {
        if (!r.bundle) return { run: r, model: null };
        try {
          return { run: r, model: toEngineModel(r.bundle) };
        } catch (err) {
          if (err instanceof ModelError) return { run: r, model: null };
          throw err;
        }
      }),
    [props.runs],
  );
  const unsolvable = useMemo(
    () => Object.fromEntries(models.filter((m) => !m.model).flatMap((m) => m.run.serviceIds.map((sid) => [sid, CANT_SIMULATE]))),
    [models],
  );

  // Today's driver pressure, from a simulation of each process: needed once there is something to compare (a file was read).
  const jobs = useMemo<ChurnJob[] | null>(() => {
    if (!measure && !checks) return null;
    const out: ChurnJob[] = [];
    for (const { run, model } of models) {
      if (!model) continue;
      const measured: Record<string, number> = {};
      for (const m of measure?.services ?? []) if (m.enough && m.monthly !== null && run.serviceIds.includes(m.serviceId)) measured[m.serviceId] = m.monthly;
      out.push({ processId: run.processId, model, measured });
    }
    return out;
  }, [models, measure, checks]);
  const solve = useChurnBackSolve(jobs);
  const solved: BackSolvedChurn | null = useMemo(() => {
    if (solve.status === "done") return { ...solve.solved, why: { ...unsolvable, ...solve.solved.why } };
    // Nothing could be simulated: every service says why.
    if (jobs && jobs.length === 0) return { bases: {}, multipliers: {}, why: unsolvable, runs: 0, converged: true, simulated: { late: null, resp: null, onb: null }, engineVersion: "", seed: 0, reps: 0, horizonWeeks: 0 };
    return null;
  }, [solve, jobs, unsolvable]);

  const { proposals, noGroup } = useMemo(() => (measure ? churnProposals(services, measure.services, solved) : { proposals: [] as CalibrationProposal[], noGroup: [] as string[] }), [measure, services, solved]);
  const isTicked = (p: CalibrationProposal) => touched.get(p.key) ?? initiallySelected(p);
  const chosen = proposals.filter((p) => selectable(p) && isTicked(p) && !applied.has(p.key));
  const solving = (measure || checks) && solve.status !== "done" && solve.status !== "error" && (jobs?.length ?? 0) > 0;
  const nothingRead = !clients && !log;

  const save = () => {
    if (nothingRead || asOf === null) return;
    const keys = chosen.map((p) => p.key);
    const subjects = new Map(proposals.map((p) => [p.key, `${p.subject} (normal churn)`]));
    if (mode === "demo") {
      setApplied(new Set([...applied, ...keys]));
      setDone({
        tone: "ok",
        message: keys.length
          ? `Demo: nothing is saved. In a workspace, normal churn would be updated for ${keys.length} service${keys.length === 1 ? "" : "s"}, straight away, marked as measured.`
          : "Demo: nothing is saved. In a workspace, the checks would be recorded.",
      });
      return;
    }
    start(async () => {
      const out = await recordClientCalibration({
        workspaceId: props.workspaceId,
        clients: clientRows && clientsSource && clients ? { fileName: clientsSource.fileName, columnMap: clients.columns, rowCount: clientRows.length } : null,
        log: logRows && logSource && log ? { fileName: logSource.fileName, columnMap: log.columns, rowCount: logRows.length } : null,
        results: {
          asOf,
          window: measure?.window ?? checks?.window ?? null,
          rows: measure?.rows ?? 0,
          clients: measure?.clients ?? 0,
          tasks: checks?.tasks ?? 0,
          startsAfterAsOf: measure?.startsAfterAsOf ?? 0,
          unmatchedServices: measure?.unmatchedServices.length ?? 0,
          unmatchedTasks: checks?.unmatchedTasks.length ?? 0,
          noGroup,
          proposals,
          checks: (checks?.checks ?? []).map((c) => ({ id: c.id, n: c.n, value: c.value, simulated: solved?.simulated[c.id] ?? null, enough: c.enough, blocked: c.blocked, note: c.note })),
          run: solved && solved.runs > 0 ? { engineVersion: solved.engineVersion, seed: solved.seed, reps: solved.reps, horizonWeeks: solved.horizonWeeks, runs: solved.runs, converged: solved.converged, processIds: props.runs.map((r) => r.processId) } : null,
        },
        keys,
      });
      if (out.status === "error") {
        setDone({ tone: "error", message: out.message });
        return;
      }
      setApplied(new Set([...applied, ...out.results.filter((r) => r.status === "applied").map((r) => r.key)]));
      setDone({ tone: "ok", message: keys.length ? applySummary(out.results, subjects) : "Saved the checks." });
    });
  };

  const groupsHref = props.base ? `${props.base}/settings#client-groups` : null;
  const noGroupsAtAll = services.length > 0 && services.every((s) => !s.group);

  return (
    <Card role="region" aria-labelledby="cc-heading">
      <CardHeader>
        <h2 id="cc-heading" className="font-heading text-base font-medium">
          Clients and servicing work
        </h2>
        <CardDescription>
          Add a clients file to measure each service&apos;s normal churn, and a servicing log to check how late work, response times and onboarding in the
          simulation compare with what happened. Both are read in your browser. Only their names, columns and the results are kept: never the rows or
          client ids.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <FileSource
            id="cc-clients"
            title="Clients file"
            columns={[
              ["client", "Any id or name. Only used for counting, never stored."],
              ["service", "The service's name as in Settings."],
              ["started", "The date they became a client of it: 2025-01-13."],
              ["ended", "Optional. The date they left. Blank means still a client."],
            ]}
            template={CLIENTS_TEMPLATE}
            templateName="clients-template.csv"
            helpLabel="Clients file"
            helpDescription="One row for each client of each service: who, which service, when they started and, if they left, when. Include the clients who left: a file of current clients only can't show churn."
            helpExample="C-014, SEO retainer, 2025-02-03, 2026-05-29"
            sample={props.sample?.clients}
            onRead={(s) => {
              setClientsSource(s);
              setDone(null);
              setTouched(new Map());
              setApplied(new Set());
            }}
          />
          <FileSource
            id="cc-log"
            title="Servicing log"
            columns={[
              ["task", "The servicing process's name, as on its map."],
              ["client", "The same ids as the clients file."],
              ["due", "When it was due. A date with no time is due at the end of that day."],
              ["done", "Optional. When it was done. Blank means not done."],
              ["requested", "Optional. When an ad-hoc request came in."],
            ]}
            template={SERVICING_LOG_TEMPLATE}
            templateName="servicing-log-template.csv"
            helpLabel="Servicing log"
            helpDescription="One row for each servicing task: which process, for which client, when it was due and when it was done. Used for the three checks only."
            helpExample="Monthly report, C-014, 2026-03-06, 2026-03-05 16:00"
            sample={props.sample?.log}
            onRead={(s) => {
              setLogSource(s);
              setDone(null);
            }}
          />
        </div>

        <label className="flex max-w-xs flex-col gap-1">
          <HelpLabel label="Counted up to" {...CHURN_HELP.countedUpTo} />
          <Input type="date" value={asOfText} onChange={(e) => setAsOfText(e.target.value)} aria-invalid={asOf === null} />
          {asOf === null && <span className="text-xs text-destructive">Pick a date.</span>}
        </label>

        {clientsSource && clients && (
          <ReadSummary
            what="clients file"
            source={clientsSource}
            parsed={clients}
            onOrder={(order) => setClientsSource({ ...clientsSource, order })}
            groupName="cc-clients-order"
            extra={
              measure && (
                <>
                  {measure.startsAfterAsOf > 0 && <p className="text-muted-foreground">{measure.startsAfterAsOf} row{measure.startsAfterAsOf === 1 ? "" : "s"} start after {formatAsOf(asOf!)}, so are left out.</p>}
                  {measure.unmatchedServices.length > 0 && (
                    <p className="text-muted-foreground">
                      Not a service in Settings, so left out: {measure.unmatchedServices.map((u) => `${u.name} (${u.rows})`).join(", ")}. Rename them in the file to match.
                    </p>
                  )}
                </>
              )
            }
          />
        )}
        {logSource && log && (
          <ReadSummary
            what="servicing log"
            source={logSource}
            parsed={log}
            onOrder={(order) => setLogSource({ ...logSource, order })}
            groupName="cc-log-order"
            extra={
              checks &&
              checks.unmatchedTasks.length > 0 && (
                <p className="text-muted-foreground">
                  Not a servicing process of the workspace, so not used for response times: {checks.unmatchedTasks.map((u) => `${u.name} (${u.rows})`).join(", ")}. They still count for late work.
                </p>
              )
            }
          />
        )}

        {measure && (
          <section aria-labelledby="cc-churn" className="flex flex-col gap-2">
            <h3 id="cc-churn" className="flex items-center text-sm font-semibold">
              Normal churn
              <Help label="Normal churn" description={CHURN_HELP.normal.description} example={CHURN_HELP.normal.example} />
            </h3>
            {solving && (
              <p role="status" className="text-sm text-muted-foreground">
                {progressText(solve.status === "running" ? solve.run : 0, solve.status === "running" ? solve.job : 0, solve.status === "running" ? solve.jobs : 1)}
              </p>
            )}
            {solve.status === "error" && (
              <p role="alert" className="text-sm text-destructive">
                The simulation failed: {solve.error}
              </p>
            )}
            {noGroupsAtAll && (
              <p className="text-sm text-muted-foreground">
                Count clients in{" "}
                {groupsHref ? (
                  <a className="text-accent underline-offset-4 hover:underline" href={groupsHref}>
                    Settings → Client groups
                  </a>
                ) : (
                  "Settings → Client groups"
                )}{" "}
                to calibrate churn.
              </p>
            )}
            {proposals.length > 0 && (
              <>
                <div className="hidden grid-cols-[1.5rem_minmax(0,1.6fr)_repeat(5,minmax(0,1fr))] gap-x-3 px-2 text-2xs font-semibold tracking-wider text-muted-foreground uppercase md:grid">
                  <span />
                  <span>Service</span>
                  <span>Now</span>
                  <span>Measured</span>
                  <span>Today&apos;s drivers</span>
                  <span>Proposed</span>
                  <span className="text-right">Clients</span>
                </div>
                <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
                  {proposals.map((p) => (
                    <ChurnRow key={p.key} p={p} checked={isTicked(p)} applied={applied.has(p.key)} canApply={canApply} onToggle={(on) => setTouched(new Map(touched).set(p.key, on))} />
                  ))}
                </ul>
              </>
            )}
            {noGroup.map((name) => (
              <p key={name} className="text-sm text-muted-foreground">
                Add a client group for {name} to calibrate its churn.
                {groupsHref && (
                  <>
                    {" "}
                    <a className="text-accent underline-offset-4 hover:underline" href={groupsHref}>
                      Client groups
                    </a>
                  </>
                )}
              </p>
            ))}
            {!proposals.length && !noGroup.length && !noGroupsAtAll && <p className="text-sm text-muted-foreground">Nothing in the file matches a service with a client group.</p>}
          </section>
        )}

        {(clients || log) && (
          <section aria-labelledby="cc-checks" className="flex flex-col gap-2">
            <h3 id="cc-checks" className="text-sm font-semibold">
              Checks
            </h3>
            <p className="text-sm text-muted-foreground">What happened, beside what the simulation gives now. They are never applied.</p>
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
              {CHECK_ORDER.map((id) => (
                <CheckRow key={id} id={id} check={checks?.checks.find((c) => c.id === id) ?? null} hasLog={Boolean(logRows)} solved={solved} solving={Boolean(solving)} />
              ))}
            </ul>
          </section>
        )}

        {!nothingRead &&
          (canApply ? (
            <div className="sticky bottom-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-2 shadow-xs">
              <span className="text-sm">
                <span className="tabular-nums font-medium">{chosen.length}</span> ticked
              </span>
              <Help
                label="Apply"
                description="Normal churn changes straight away for each ticked service, as an edit in Settings does, and is marked as measured with this file as where it came from. The checks are saved with it, and never change the model. With nothing ticked, only the checks are saved."
                example="Applying 1.8% for SEO retainer sets its client group's normal churn to 1.8%, marked Measured."
              />
              <span className="grow" />
              <Button type="button" disabled={pending || asOf === null || Boolean(solving)} onClick={save}>
                {pending ? "Saving…" : chosen.length ? `Apply ${chosen.length} ticked` : "Save the checks"}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">You can see what the files measure here; owners and editors can apply them.</p>
          ))}
        {done && (
          <div role="status" className={cn("rounded-lg border p-3 text-sm", done.tone === "ok" ? "border-good bg-good-soft" : "border-crit bg-crit-soft")}>
            {done.message}
          </div>
        )}

        {props.history.length > 0 && (
          <section aria-labelledby="cc-history" className="flex flex-col gap-2">
            <h3 id="cc-history" className="text-sm font-semibold">
              Earlier clients files and servicing logs
            </h3>
            <ul className="flex flex-col divide-y divide-line text-sm">
              {props.history.map((h) => (
                <li key={h.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
                  <span className="min-w-0 truncate font-medium">{[h.clientsFile, h.logFile].filter(Boolean).join(" and ") || "Files"}</span>
                  <span className="text-muted-foreground">
                    {new Date(h.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · applied {h.applied} of {h.proposals}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function FileSource({
  id,
  title,
  columns,
  template,
  templateName,
  helpLabel,
  helpDescription,
  helpExample,
  sample,
  onRead,
}: {
  id: string;
  title: string;
  columns: [string, string][];
  template: string;
  templateName: string;
  helpLabel: string;
  helpDescription: string;
  helpExample: string;
  sample?: { name: string; text: string };
  onRead: (source: Source) => void;
}) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const read = (body: string, name: string, note: string | null = null) => onRead({ fileName: name || `Pasted ${title.toLowerCase()}`, text: body, note });
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 20_000_000) {
      setError("That file is over 20 MB. Split it by date and read each part.");
      return;
    }
    setError(null);
    // Excel saves "CSV" as Windows text and "Unicode text" as UTF-16: read either, and say so when it isn't UTF-8.
    const { text: body, note } = decodeLogFile(new Uint8Array(await file.arrayBuffer()));
    setFileName(file.name);
    setText("");
    read(body, file.name, note);
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h3 className="flex items-center text-sm font-semibold">
        {title}
        <Help label={helpLabel} description={helpDescription} example={helpExample} />
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {columns.map(([name, what]) => (
          <div key={name} className="contents">
            <dt className="font-mono text-xs leading-5">{name}</dt>
            <dd className="text-muted-foreground">{what}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" type="button" onClick={() => input.current?.click()}>
          Choose a CSV file
        </Button>
        <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sr-only" aria-label={`${title} CSV file`} onChange={(e) => onFile(e.target.files?.[0])} />
        <a className="text-sm text-accent underline-offset-4 hover:underline" download={templateName} href={`data:text/csv;charset=utf-8,${encodeURIComponent(template)}`}>
          Download template
        </a>
        {sample && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => {
              setText(sample.text);
              setFileName(sample.name);
              read(sample.text, sample.name);
            }}
          >
            Use a sample
          </Button>
        )}
      </div>
      <label htmlFor={`${id}-text`} className="flex flex-col gap-1">
        <HelpLabel
          label="Or paste the rows"
          description="Paste rows copied from a spreadsheet or a CSV, with the column names in the first row. Columns can be in any order; other columns are ignored."
          example={template.split("\n")[1] ?? ""}
        />
        <Textarea
          id={`${id}-text`}
          value={text}
          rows={5}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={template.split("\n").slice(0, 3).join("\n")}
          onChange={(e) => {
            setText(e.target.value);
            setFileName("");
          }}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={!text.trim()} onClick={() => read(text, fileName)}>
          Read it
        </Button>
        {fileName && <span className="truncate text-sm text-muted-foreground">{fileName}</span>}
        {error && (
          <span role="alert" className="text-sm text-destructive">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

interface ParsedLike {
  rows: unknown[];
  missing: string[];
  errors: { line: number; message: string }[];
  dateOrder: DateOrder | null;
  dateProblem: "ambiguous" | "mixed" | null;
}

function ReadSummary({
  what,
  source,
  parsed,
  onOrder,
  groupName,
  extra,
}: {
  what: string;
  source: Source;
  parsed: ParsedLike;
  onOrder: (order: DateOrder) => void;
  groupName: string;
  extra?: React.ReactNode;
}) {
  if (parsed.missing.length) {
    return (
      <div role="alert" className="rounded-lg border border-crit bg-crit-soft p-3 text-sm">
        The {what} has no {parsed.missing.join(", ")} column. The first row must name the columns.
      </div>
    );
  }
  if (parsed.dateProblem === "mixed") {
    return (
      <div role="alert" className="rounded-lg border border-crit bg-crit-soft p-3 text-sm">
        Some dates in the {what} can only be day first (like 13/03/2026) and others only month first (like 03/13/2026). Make them all the same way round,
        or use 2026-03-13, and read it again.
      </div>
    );
  }
  if (parsed.dateProblem === "ambiguous") {
    return (
      <fieldset className="flex flex-col gap-2 rounded-lg border border-warn bg-warn-soft p-3 text-sm">
        <legend className="sr-only">Day and month order in the {what}</legend>
        <span className="flex items-center gap-1 font-medium">
          Is 02/03/2026 in the {what} the 2nd of March or the 3rd of February?
          <Help
            label="Day and month order"
            description="Every date in this file reads both ways round, so say which it is. All the dates are then read the same way."
            example="Files from Australia and the UK are usually day first: 02/03/2026 is 2 March."
          />
        </span>
        <span className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2">
            <input type="radio" name={groupName} onChange={() => onOrder("dmy")} /> Day first (2 March)
            <Help label="Day first" description="Read every date as day, then month, then year." example="02/03/2026 is 2 March 2026." />
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name={groupName} onChange={() => onOrder("mdy")} /> Month first (3 February)
            <Help label="Month first" description="Read every date as month, then day, then year, as in the US." example="02/03/2026 is 3 February 2026." />
          </label>
        </span>
      </fieldset>
    );
  }
  return (
    <section aria-label={`What was read from the ${what}`} className="flex flex-col gap-2 rounded-lg border border-line bg-panel-2 p-3 text-sm">
      <p>
        Read <strong className="tabular-nums">{formatNumber(parsed.rows.length, 0)}</strong> rows from the {what} ({source.fileName}).
        {parsed.errors.length > 0 && ` ${parsed.errors.length} row${parsed.errors.length === 1 ? " was" : "s were"} left out.`}
        {parsed.dateOrder && ` Dates read ${parsed.dateOrder === "dmy" ? "day first" : "month first"}.`}
      </p>
      {source.note && <p className="text-muted-foreground">{source.note}</p>}
      {parsed.errors.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Rows left out</summary>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {parsed.errors.slice(0, 20).map((e) => (
              <li key={e.line}>
                Line {e.line}: {e.message}
              </li>
            ))}
            {parsed.errors.length > 20 && <li>and {parsed.errors.length - 20} more.</li>}
          </ul>
        </details>
      )}
      {extra}
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

function ChurnRow({ p, checked, applied, canApply, onToggle }: { p: CalibrationProposal; checked: boolean; applied: boolean; canApply: boolean; onToggle: (on: boolean) => void }) {
  const id = `cc-${p.key}`;
  const offered = selectable(p);
  const known = p.currentSource !== "estimated";
  return (
    <li className={cn("grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-2 py-2.5 md:grid-cols-[1.5rem_minmax(0,1.6fr)_repeat(5,minmax(0,1fr))]", applied && "bg-good-soft")}>
      <span className="flex h-5 items-center">
        {canApply && offered && !applied ? (
          <input id={id} type="checkbox" className="size-4 accent-accent" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
        ) : applied ? (
          <span aria-label="Applied" className="text-good">
            ✓
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          {offered ? (
            <label htmlFor={id} className="font-medium">
              {p.subject}
            </label>
          ) : (
            <span className="font-medium">{p.subject}</span>
          )}
          <SourceBadge source={p.currentSource} />
          <Help label={`${p.subject}, from the file`} description={p.note || (p.blocked ?? "")} example={`${p.subject}: ${formatChurn(p.measured)} measured, ${formatMultiplier(p.multiplier)} today's drivers, ${formatChurn(p.proposed)} proposed as normal churn.`} />
        </span>
        {known && offered && !applied && <span className="text-xs text-muted-foreground">Now {SOURCE_LABELS[p.currentSource].toLowerCase()}: tick it only to replace it.</span>}
        {applied && <span className="text-xs text-muted-foreground">Applied.</span>}
      </span>
      {p.blocked ? (
        <span className="col-start-2 text-sm text-muted-foreground md:col-span-5 md:col-start-3">{p.blocked}</span>
      ) : (
        <>
          <span className="col-start-2 text-sm tabular-nums md:col-start-auto">
            <span className="text-muted-foreground md:hidden">Now </span>
            {formatChurn(p.current)}
          </span>
          <span className="col-start-2 text-sm tabular-nums md:col-start-auto">
            <span className="text-muted-foreground md:hidden">Measured </span>
            {formatChurn(p.measured)}
          </span>
          <span className="col-start-2 text-sm tabular-nums md:col-start-auto">
            <span className="text-muted-foreground md:hidden">Today&apos;s drivers </span>
            {formatMultiplier(p.multiplier)}
          </span>
          <span className="col-start-2 text-sm font-medium tabular-nums md:col-start-auto">
            <span className="font-normal text-muted-foreground md:hidden">Proposed </span>
            {formatChurn(p.proposed)}
          </span>
          <span className="col-start-2 text-xs text-muted-foreground tabular-nums md:col-start-auto md:text-right md:text-sm">
            {formatNumber(p.n, 0)} clients, {formatNumber(p.leavers ?? 0, 0)} left
          </span>
        </>
      )}
    </li>
  );
}

function CheckRow({ id, check, hasLog, solved, solving }: { id: ServicingCheckId; check: { n: number; value: number | null; enough: boolean; blocked: string | null; note: string } | null; hasLog: boolean; solved: BackSolvedChurn | null; solving: boolean }) {
  const label = CHECK_LABELS[id];
  const simulated = solved ? solved.simulated[id] : null;
  return (
    <li className="grid gap-x-4 gap-y-1 px-3 py-2.5 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,1.2fr)]">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{label.title}</span>
        <span className="inline-block rounded-token border border-line bg-panel-2 px-1.5 text-[11px] leading-4 text-fg-2">Check only</span>
        <Help label={label.title} description={label.description} example={label.example} />
      </span>
      <span className="text-sm">
        <span className="text-muted-foreground">History </span>
        {!hasLog ? (
          <span className="text-muted-foreground">Needs the servicing log.</span>
        ) : check?.blocked ? (
          <span className="text-muted-foreground">{check.blocked}</span>
        ) : check ? (
          <>
            <span className="font-medium tabular-nums">{formatCheckValue(id, check.value)}</span>
            <span className="text-muted-foreground tabular-nums"> ({formatNumber(check.n, 0)} {label.unit})</span>
          </>
        ) : (
          "—"
        )}
      </span>
      <span className="text-sm">
        <span className="text-muted-foreground">Simulated now </span>
        {solved ? (
          simulated === null ? (
            <span className="text-muted-foreground">{id === "resp" ? "The simulation measures none: no servicing work comes in as ad-hoc requests." : "The simulation measures none: no servicing work is mapped."}</span>
          ) : (
            <span className="font-medium tabular-nums">{formatCheckValue(id, simulated)}</span>
          )
        ) : (
          <span className="text-muted-foreground">{solving ? "Measuring…" : "—"}</span>
        )}
      </span>
      {check && !check.blocked && hasLog && <span className="text-xs text-muted-foreground md:col-span-3">{check.note}</span>}
    </li>
  );
}
