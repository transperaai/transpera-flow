"use client";

// The Issue page (issue #113, A48; prototype: "Issue"): where the issue sits on the map, what is wrong, the solutions
// tested, AI ideas and the history on the left; its target, owners, links and sources on the right. Edit reuses the
// Acknowledge dialog, Mark resolved opens the Resolve dialog, and a resolved issue offers Reopen and shows a
// "Resolved <date> · by …" bar. The history is kept after resolving.

import { isReadOnly, type ScreenMode } from "@/lib/mode";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IssueEventRow, IssueRow, ProcessBundle, SourceRow } from "@transpera-flow/db";
import type { StepBadge } from "@/lib/issues/register";
import { AcknowledgeDialog } from "@/components/acknowledge-dialog";
import { Help, HelpLabel } from "@/components/help";
import { ISSUE_PAGE_HELP } from "@/lib/issues/help";
import { ResolveDialog } from "@/components/issues/resolve-dialog";
import { StatusChip } from "@/components/issues-page";
import { RatingPill } from "@/components/overview/rating-pill";
import { LinkedSources, useSourceLinking } from "@/components/sources/linking-context";
import { StepIssueBadges } from "@/components/step-issue-badges";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { MapSkeleton } from "@/components/map/map-placeholder";
import { draftFromIssue, issueFormOptions, toSaveInput } from "@/lib/issues/draft";
import { historyLines, isOpenIssue, issueHref, loggedLine, resolvedBar, type HistoryNames, type SolutionTest } from "@/lib/issues/pages";
import { mapFeed, registerEntries, stepRatingOf } from "@/lib/issues/register";
import { useIssues } from "@/lib/issues/use-issues";
import { editSourceIds } from "@/lib/sources/links";
import { NO_SOLUTIONS_DATA, effectiveVerdict, solutionHref, solutionTests, solutionsForIssue, type SolutionsData } from "@/lib/solutions/cards";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { ratingOfStored } from "@transpera-flow/engine";
import { namedForViewer, viewerOf } from "@/lib/viewer";
import { EDIT_ONLY } from "@/lib/phone";

// The map is heavy; load it when the page has drawn.
const ProcessCanvas = dynamic(() => import("@/components/process-canvas").then((m) => m.ProcessCanvas), {
  ssr: false,
  loading: () => <MapSkeleton height={256} />,
});


const CARD_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";
const EYEBROW = "flex items-center text-2xs font-semibold tracking-wider text-muted-foreground uppercase";

export interface IssuePageProps {
  issue: IssueRow;
  /** Every issue of the workspace, so the map shows the other open ones as badges. */
  issues: IssueRow[];
  /** The issue's process, live version. */
  bundle: ProcessBundle;
  processes: { id: string; name: string }[];
  sources: SourceRow[];
  /** The history as loaded; refreshed after each change. */
  events: IssueEventRow[];
  mode: ScreenMode;
  /** Where the workspace's pages live: `/w/<slug>` or `/demo`. */
  base: string;
  /** The Editor in solution mode for this issue (A49). Until A49 builds it the Editor says "Coming soon". */
  buildHref: string;
  /** The signed-in person's id, so their entries in the history say "You". */
  viewerId?: string | null;
  liveRevisions?: Record<string, string>;
  /** The "AI ideas" section's content (A52): the ideas waiting for this issue, each with Build it and Dismiss. Without it the section says there are none. */
  ideas?: ReactNode;
  /** The workspace's solutions and which issues they solve (the demo keeps its own in this tab). */
  solutions?: SolutionsData;
  /** Member names by user id (the person linked to each membership), so the history says who by name. */
  memberNames?: Readonly<Record<string, string>>;
  /** The Share button (owners and editors, B3), made by the page that knows what is shared. */
  share?: ReactNode;
}

export function IssuePage(props: IssuePageProps) {
  const { bundle, processes, sources, mode, base, buildHref, viewerId } = props;
  const router = useRouter();
  const state = useIssues(bundle.workspace.id, props.issues, mode, props.liveRevisions ?? { [bundle.process.id]: bundle.revision.id });
  const issue = state.issues.find((i) => i.id === props.issue.id) ?? props.issue;
  const canEdit = !isReadOnly(mode);
  const open = isOpenIssue(issue);

  const [events, setEvents] = useState(props.events);
  const refresh = useCallback(
    () =>
      void state.events(issue.id).then((e) => {
        if (e.length) setEvents(e);
      }),
    [state, issue.id],
  );
  // The demo's history lives in memory; load it once the store is there.
  useEffect(() => {
    if (mode === "demo") refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [edit, setEdit] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [linking, setLinking] = useState(false);
  // Where the page loads source links, Sources are the links (the Add / Link source dialog); otherwise the issue's own list and its small dialog.
  const sourceLinking = useSourceLinking();

  const allSteps = useMemo(() => [...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((p) => p.steps)], [bundle]);
  const options = useMemo(
    () => issueFormOptions({ processes, steps: allSteps, people: namedForViewer(viewerOf(bundle), bundle.people.filter((p) => p.active)), sources }),
    [processes, allSteps, bundle, sources],
  );
  const stepName = useMemo(() => new Map(allSteps.map((s) => [s.id, s.name])), [allSteps]);
  const processName = useMemo(() => new Map(processes.map((p) => [p.id, p.name])), [processes]);
  const personName = useMemo(() => new Map(namedForViewer(viewerOf(bundle), bundle.people).map((p) => [p.id, p.name])), [bundle]);
  const sourceTitle = useMemo(() => new Map(sources.map((s) => [s.id, s.title])), [sources]);

  // The map: only confirmed open issues badge a step, so a resolved issue (this one too) is gone from it.
  const feed = useMemo(() => mapFeed(registerEntries(state.issues, [])), [state.issues]);
  const openIssues = useMemo(() => Object.fromEntries(Object.entries(feed.badges).map(([id, b]) => [id, b.count])), [feed]);
  const rating = useMemo(() => stepRatingOf(feed.ratings), [feed]);
  const stepIds = issue.links.flatMap((l) => (l.step_id ? [l.step_id] : []));
  const highlight = stepIds.length ? stepIds : issue.step_id ? [issue.step_id] : null;
  // A badge on the map opens an open issue on that step: another one if there is one, else this one.
  const openBadge = (stepId: string) => {
    const there = state.issues.filter((i) => isOpenIssue(i) && i.links.some((l) => l.step_id === stepId));
    const target = there.find((i) => i.id !== issue.id) ?? there[0];
    if (target && target.id !== issue.id) router.push(issueHref(base, target));
  };

  const inTab = useDemoSolutions();
  const solutionData = mode === "demo" ? inTab : (props.solutions ?? NO_SOLUTIONS_DATA);
  const solutions: SolutionTest[] = solutionTests(issue.id, solutionData, base);
  // What the Resolve dialog can pick, and the one that fixed a resolved issue.
  const linked = solutionsForIssue(solutionData, issue.id).map(({ solution, link }) => ({ id: solution.id, name: solution.name, verdict: effectiveVerdict(link) }));
  const fixedBy = issue.resolved_solution_id ? (solutionData.solutions.find((s) => s.id === issue.resolved_solution_id) ?? null) : null;
  const names: HistoryNames = {
    step: (id) => stepName.get(id),
    person: (id) => personName.get(id),
    source: (id) => sourceTitle.get(id),
    who: (actor) => (actor && actor === viewerId ? "You" : mode === "demo" ? "You" : actor ? (props.memberNames?.[actor] ?? "A team member") : "System"),
  };
  const lines = historyLines(events, names);
  const bar = resolvedBar(issue, undefined, fixedBy?.name);
  const owners = issue.owner_ids.length ? issue.owner_ids : issue.owner_person_id ? [issue.owner_person_id] : [];
  const processIdOf = issue.links.find((l) => l.process_id)?.process_id ?? issue.process_id ?? bundle.process.id;

  return (
    <div className="flex flex-col gap-5" data-issue-page={issue.number ?? issue.id}>
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 max-w-prose flex-col gap-1.5">
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Link href={`${base}/issues`} className="hover:underline">
              Issues
            </Link>
            <span aria-hidden>/</span>
            <span>{issue.number ? `#${issue.number}` : "Issue"}</span>
          </nav>
          <h1 className="font-heading text-2xl leading-tight font-semibold tracking-tight">{issue.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <RatingPill rating={ratingOfStored(issue.severity)} />
            <StatusChip issue={issue} />
            <span className="text-sm text-muted-foreground">{loggedLine(issue)}</span>
          </div>
        </div>
        {canEdit && (
          <div className={`flex flex-wrap items-center gap-2 ${EDIT_ONLY}`} data-edit-entry>
            {props.share}
            <span className="flex items-center">
              <Button type="button" variant="outline" onClick={() => setEdit(true)}>
                Edit
              </Button>
              <Help {...ISSUE_PAGE_HELP.edit} />
            </span>
            {open ? (
              <>
                <span className="flex items-center">
                  <Button type="button" variant="outline" onClick={() => setResolving(true)}>
                    Mark resolved
                  </Button>
                  <Help {...ISSUE_PAGE_HELP.resolve} />
                </span>
                <span className="flex items-center">
                  <Button asChild className="bg-edit text-edit-fg hover:bg-edit/90">
                    <Link href={buildHref}>✎ Build solution</Link>
                  </Button>
                  <Help {...ISSUE_PAGE_HELP.build} />
                </span>
              </>
            ) : (
              <span className="flex items-center">
                <Button type="button" variant="outline" disabled={state.busy} onClick={() => void state.reopen(issue.id).then((r) => r && refresh())}>
                  Reopen
                </Button>
                <Help {...ISSUE_PAGE_HELP.reopen} />
              </span>
            )}
          </div>
        )}
      </header>

      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}

      {bar && (
        <div role="status" data-resolved-bar className="rounded-lg border border-good/40 bg-good/10 px-4 py-2.5 text-sm">
          <span aria-hidden>✓ </span>
          <b>{bar.split(" · ")[0]}</b>
          {bar.includes(" · ") ? ` · ${bar.split(" · ").slice(1).join(" · ")}` : ""}
          {fixedBy && (
            <>
              {" "}
              <Link href={solutionHref(base, fixedBy.id)} className="font-medium underline" data-resolved-solution>
                Open the solution
              </Link>
            </>
          )}
        </div>
      )}

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="flex min-w-0 flex-col gap-2" data-section="where">
            <h2 className={`${CARD_TITLE} flex items-center`}>
              Where this issue sits
              <Help {...ISSUE_PAGE_HELP.where} />
            </h2>
            {/* A plain block, not a Card: the map sizes itself to the width it is given. */}
            <MapWithBadges badges={feed.badges} onOpen={openBadge}>
              <ProcessCanvas
                // The highlight is opened into the map once, at the start.
                key={`${bundle.process.id}:${(highlight ?? []).join("|")}`}
                bundle={bundle}
                openIssues={openIssues}
                rating={rating}
                highlight={highlight}
                showPlayback={false}
                showLanes={false}
                height="auto"
                legend={false}
              />
            </MapWithBadges>
          </section>

          <Card className="gap-2 px-4 py-3" data-section="wrong">
            <h2 className={`${CARD_TITLE} flex items-center`}>
              What&apos;s wrong
              <Help {...ISSUE_PAGE_HELP.wrong} />
            </h2>
            <p className="text-sm whitespace-pre-line">{issue.evidence?.trim() || "Nothing written yet. Edit the issue to say what you saw."}</p>
          </Card>

          <section className="flex flex-col gap-2" data-section="solutions">
            <div>
              <h2 className={`${CARD_TITLE} flex items-center`}>
                Solutions tested
                <Help {...ISSUE_PAGE_HELP.solutions} />
              </h2>
              <p className="text-sm text-muted-foreground">Each solution lives on its own. Here is how each one did against this issue&apos;s target.</p>
            </div>
            {solutions.length ? <SolutionsTable solutions={solutions} /> : (
              <Card className="px-4 py-6 text-sm text-muted-foreground" data-empty="solutions">
                Nothing tested yet. Build solution opens the Editor with this issue&apos;s steps outlined.
              </Card>
            )}
          </section>

          <section className="flex flex-col gap-2" data-section="ideas">
            <div>
              <h2 className={`${CARD_TITLE} flex items-center`}>
                AI ideas
                <Help {...ISSUE_PAGE_HELP.ideas} />
              </h2>
              <p className="text-sm text-muted-foreground">Proposed by AI, not built or simulated yet.</p>
            </div>
            {props.ideas ?? (
              <Card className="px-4 py-6 text-sm text-muted-foreground" data-empty="ideas">
                No AI ideas for this issue yet.
              </Card>
            )}
          </section>

          <section className="flex flex-col gap-2" data-section="history">
            <div>
              <h2 className={`${CARD_TITLE} flex items-center`}>
                History
                <Help {...ISSUE_PAGE_HELP.history} />
              </h2>
              <p className="text-sm text-muted-foreground">Everything that happened to this issue, oldest first. Kept after it&apos;s resolved.</p>
            </div>
            <ol className="flex flex-col gap-1.5 border-l border-border pl-4" data-history>
              {lines.length ? (
                lines.map((l) => (
                  <li key={l.id} className="flex flex-wrap gap-x-3 text-sm" data-history-line>
                    <span className="w-14 shrink-0 text-muted-foreground tabular-nums">{l.when}</span>
                    <span className="shrink-0 font-medium">{l.who}</span>
                    <span className="min-w-0">{l.text}</span>
                  </li>
                ))
              ) : (
                <li className="text-sm text-muted-foreground">No history yet.</li>
              )}
            </ol>
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <Card className="gap-2 px-4 py-3" data-section="target">
            <span className={EYEBROW}>
              Target
              <Help {...ISSUE_PAGE_HELP.target} />
            </span>
            {issue.target_measure || issue.target_now || issue.target_goal ? (
              <>
                <b>{issue.target_measure || "Not named yet"}</b>
                <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  <dt className="text-xs text-muted-foreground">Now</dt>
                  <dd className="font-mono">{issue.target_now || "—"}</dd>
                  <dt className="text-xs text-muted-foreground">Goal</dt>
                  <dd className="font-mono">{issue.target_goal || "—"}</dd>
                </dl>
                <span className="text-xs text-muted-foreground">Solutions get an automatic pass or fail against this. You make the final call.</span>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">No target yet. Edit the issue to add one.</span>
            )}
          </Card>

          <Card className="gap-2 px-4 py-3" data-section="owners">
            <span className={EYEBROW}>
              Owners
              <Help {...ISSUE_PAGE_HELP.owners} />
            </span>
            {owners.length ? (
              <div className="flex flex-wrap gap-1.5">
                {owners.map((id) => (
                  <span key={id} className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-xs">
                    <span aria-hidden className="grid size-4 place-items-center rounded-full bg-muted text-[9px] font-semibold">
                      {initials(personName.get(id) ?? "?")}
                    </span>
                    {personName.get(id) ?? "Someone"}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">No owner yet.</span>
            )}
          </Card>

          <Card className="gap-2 px-4 py-3" data-section="linked">
            <span className={EYEBROW}>
              Linked to
              <Help {...ISSUE_PAGE_HELP.linked} />
            </span>
            <div className="flex flex-wrap gap-1.5">
              <Chip>Process: {processName.get(processIdOf) ?? bundle.process.name}</Chip>
              {stepIds.map((id) => (
                <Chip key={id}>Step: {stepName.get(id) ?? "A step"}</Chip>
              ))}
            </div>
          </Card>

          <Card className="gap-2 px-4 py-3" data-section="sources">
            {sourceLinking ? (
              <LinkedSources
                target={{ kind: "issue", issueId: issue.id }}
                label={issue.number ? `Issue #${issue.number}` : `Issue: ${issue.title}`}
                empty="None yet"
                className="flex flex-col gap-2"
              />
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className={EYEBROW}>
                    Sources
                    <Help {...ISSUE_PAGE_HELP.sources} />
                  </span>
                  {canEdit && (
                    <span className={`flex items-center ${EDIT_ONLY}`} data-edit-entry>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setLinking(true)}>
                        + Link
                      </Button>
                      <Help {...ISSUE_PAGE_HELP.link} />
                    </span>
                  )}
                </div>
                {issue.source_ids.length ? (
                  issue.source_ids.map((id) => (
                    <div key={id} className="text-sm font-medium">
                      {sourceTitle.get(id) ?? "A source"}
                    </div>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">None yet</span>
                )}
              </>
            )}
          </Card>
        </aside>
      </div>

      <AcknowledgeDialog
        open={edit}
        mode="edit"
        // Where the page loads source links, the sources it shows are the links (they change under "+ Link" and the x, which this
        // issue's copy from the page load doesn't see): the dialog starts from those, or saving would put back what was just removed.
        draft={{ ...draftFromIssue(issue), sourceIds: editSourceIds(issue.source_ids, sourceLinking ? sourceLinking.linkedTo({ kind: "issue", issueId: issue.id }).map((x) => x.source.id) : null) }}
        issueNumber={issue.number}
        options={options}
        busy={state.busy}
        error={state.error}
        onClose={() => setEdit(false)}
        onSubmit={(draft) => state.save(toSaveInput(draft, options)).then((r) => r && (void sourceLinking?.syncIssue(issue.id, draft.sourceIds), refresh(), r))}
      />
      <ResolveDialog
        open={resolving}
        issueNumber={issue.number}
        issueTitle={issue.title}
        solutions={linked}
        busy={state.busy}
        error={state.error}
        onClose={() => setResolving(false)}
        onSubmit={(how, note, solution) => state.resolve(issue.id, how, note, solution).then((r) => r && (refresh(), r))}
      />
      <LinkSourceDialog
        open={linking}
        sources={sources.filter((s) => !issue.source_ids.includes(s.id))}
        busy={state.busy}
        error={state.error}
        onClose={() => setLinking(false)}
        onSubmit={(sourceId) => state.save(toSaveInput({ ...draftFromIssue(issue), sourceIds: [...issue.source_ids, sourceId] }, options)).then((r) => r && (refresh(), r))}
      />
    </div>
  );
}

/**
 * The map in a plain block, with the red badges on it. The map is loaded after the page, and the badges find their
 * steps in it, so they are drawn once it is there.
 */
function MapWithBadges({ badges, onOpen, children }: { badges: Record<string, StepBadge>; onOpen: (stepId: string) => void; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const check = () => setReady(!!el.querySelector("[data-process-map]"));
    check();
    const observer = new MutationObserver(check);
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={host} className="min-w-0 overflow-hidden rounded-token border bg-card">
      {children}
      {ready && <StepIssueBadges badges={badges} onOpen={onOpen} />}
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex h-6 items-center rounded-full border border-border px-2 text-xs">{children}</span>;
}

const VERDICT_LABELS = { pass: "Pass", fail: "Fail", unchecked: "Not checked" } as const;
const Verdict = ({ v }: { v: keyof typeof VERDICT_LABELS | null }) => (v ? <span className="font-medium">{VERDICT_LABELS[v]}</span> : <span className="text-muted-foreground">—</span>);

/** The solutions tested for the issue, as the prototype's table. A49 supplies the rows. */
function SolutionsTable({ solutions }: { solutions: readonly SolutionTest[] }) {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[32rem] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
            <th className="px-4 py-2">Solution</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">Built</th>
            <th className="px-3 py-2">Automatic</th>
            <th className="px-3 py-2 text-right">Holds in</th>
            <th className="px-3 py-2">Yours</th>
          </tr>
        </thead>
        <tbody>
          {solutions.map((s) => (
            <tr key={s.id} className="border-b border-border last:border-0">
              <td className="px-4 py-2">
                <Link href={s.href} className="font-medium hover:underline">
                  {s.name}
                </Link>
              </td>
              <td className="px-3 py-2 text-xs">{s.type}</td>
              <td className="px-3 py-2 text-xs whitespace-nowrap">{s.built}</td>
              <td className="px-3 py-2">
                <Verdict v={s.auto} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{s.holds == null ? "—" : `${Math.round(s.holds * 100)}%`}</td>
              <td className="px-3 py-2">
                <Verdict v={s.yours} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function LinkSourceDialog({
  open,
  sources,
  onSubmit,
  onClose,
  busy,
  error,
}: {
  open: boolean;
  sources: readonly SourceRow[];
  onSubmit: (sourceId: string) => Promise<unknown>;
  onClose: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const [picked, setPicked] = useState("");
  const choice = picked || sources[0]?.id || "";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-link-source-dialog>
        <DialogHeader>
          <DialogTitle>Link a source</DialogTitle>
          <DialogDescription>Pick an interview, note or document that backs this issue up.</DialogDescription>
        </DialogHeader>
        {sources.length ? (
          <label className="flex flex-col gap-0.5">
            <HelpLabel {...ISSUE_PAGE_HELP.link} label="Source" />
            <NativeSelect aria-label="Source" value={choice} onChange={(e) => setPicked(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : (
          <p className="text-sm text-muted-foreground">Every source is already linked, or there are none yet. Add sources under Sources.</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!choice || busy} onClick={() => void onSubmit(choice).then((r) => r && onClose())}>
            Link source
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
