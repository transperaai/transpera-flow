"use client";

// The Issue page (issue #113, A48; redesigned on the page kit in Q10; QA round 2; layout A of docs/plans/ui-cleanup.md): the breadcrumb, a
// flat header (the title, pills for the rating and status, its process and last change, Edit and Resolve or Reopen), then the main column
// (where the issue sits on the map, what is wrong, edited where it stands, with its sources, and the solutions tried) beside a metadata
// rail (rating, status, owners, process, dates, sources, solutions). The status is a pill dropdown that saves at once; choosing Resolved
// opens the Resolve dialog, to pick the solution that fixed it.

import { isReadOnly, type ScreenMode } from "@/lib/mode";
import { FlaskConical, Pencil } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IssueEventRow, IssueRow, IssueStatus, ProcessBundle, SolutionIssueRow, SolutionRow, SourceRow } from "@transpera-flow/db";
import { AcknowledgeDialog } from "@/components/acknowledge-dialog";
import { Help, HelpLabel } from "@/components/help";
import { ISSUE_PAGE_HELP } from "@/lib/issues/help";
import { ActionsHelp, DetailBreadcrumb, DetailLayout, EditMarker, MetaRail, RailItem } from "@/components/issues/detail-layout";
import { IssueStatusMenu } from "@/components/issues/status-pill";
import { ResolveDialog } from "@/components/issues/resolve-dialog";
import { EditableText, EmptyState, HEADER_PILL, PageHeader, SectionCard } from "@/components/page-kit";
import { RatingPill } from "@/components/overview/rating-pill";
import { VerdictWord } from "@/components/solutions/solution-cards";
import { SolutionStatusMenu } from "@/components/solutions/status-menu";
import { LinkedSources, useSourceLinking } from "@/components/sources/linking-context";
import { TagPill } from "@/components/tag-pill";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MapSkeleton } from "@/components/map/map-placeholder";
import { draftFromIssue, issueFormOptions, toSaveInput, WRONG_PROMPTS, wrongText } from "@/lib/issues/draft";
import { isOpenIssue, resolvedBar, shortDate } from "@/lib/issues/pages";
import { mapFeed, registerEntries, stepRatingOf } from "@/lib/issues/register";
import { useIssues } from "@/lib/issues/use-issues";
import { editSourceIds } from "@/lib/sources/links";
import { NO_SOLUTIONS_DATA, changesLine, effectiveVerdict, solutionHref, solutionsForIssue, type SolutionsData } from "@/lib/solutions/cards";
import { addDemoLink, setDemoNotes, useDemoSolutions } from "@/lib/solutions/demo";
import { linkSolutionToIssue } from "@/app/w/[slug]/solution-actions";
import { saveSolutionNotes } from "@/app/w/[slug]/solution-page-actions";
import { ratingOfStored } from "@transpera-flow/engine";
import { namedForViewer, viewerOf } from "@/lib/viewer";
import { EDIT_ONLY } from "@/lib/phone";

// The map is heavy; load it when the page has drawn.
const ProcessCanvas = dynamic(() => import("@/components/process-canvas").then((m) => m.ProcessCanvas), {
  ssr: false,
  loading: () => <MapSkeleton height={256} />,
});

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
  /** The Editor in solution mode for this issue: "+ Try a new solution" opens it. */
  buildHref: string;
  /** The signed-in person's id, so their entries in the history say "You". */
  viewerId?: string | null;
  liveRevisions?: Record<string, string>;
  /** The workspace's solutions and which issues they solve (the demo keeps its own in this tab). */
  solutions?: SolutionsData;
  /** Member names by user id (the person linked to each membership), so the history says who by name. */
  memberNames?: Readonly<Record<string, string>>;
}

export function IssuePage(props: IssuePageProps) {
  const { bundle, processes, sources, mode, base, buildHref } = props;
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
  const [linkingSolution, setLinkingSolution] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  // Where the page loads source links, Sources are the links (the Add / Link source dialog); otherwise the issue's own list and its small dialog.
  const sourceLinking = useSourceLinking();

  const allSteps = useMemo(() => [...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((p) => p.steps)], [bundle]);
  const options = useMemo(
    () => issueFormOptions({ processes, steps: allSteps, people: namedForViewer(viewerOf(bundle), bundle.people.filter((p) => p.active)), sources }),
    [processes, allSteps, bundle, sources],
  );
  const processName = useMemo(() => new Map(processes.map((p) => [p.id, p.name])), [processes]);
  const personName = useMemo(() => new Map(namedForViewer(viewerOf(bundle), bundle.people).map((p) => [p.id, p.name])), [bundle]);
  const sourceTitle = useMemo(() => new Map(sources.map((s) => [s.id, s.title])), [sources]);

  // The map: only confirmed open issues badge a step, so a resolved issue (this one too) is gone from it.
  const feed = useMemo(() => mapFeed(registerEntries(state.issues, [])), [state.issues]);
  const rating = useMemo(() => stepRatingOf(feed.ratings), [feed]);

  // The workspace's solutions as loaded, kept up to date as they change here; the demo reads what this tab has saved.
  const inTab = useDemoSolutions();
  const [local, setLocal] = useState<SolutionsData>(props.solutions ?? NO_SOLUTIONS_DATA);
  const [seen, setSeen] = useState(props.solutions);
  if (seen !== props.solutions) {
    setSeen(props.solutions);
    setLocal(props.solutions ?? NO_SOLUTIONS_DATA);
  }
  const solutionData = mode === "demo" ? inTab : local;
  const tried = solutionsForIssue(solutionData, issue.id);
  // What the Resolve dialog can pick, and the one that fixed a resolved issue.
  const linked = tried.map(({ solution, link }) => ({ id: solution.id, name: solution.name, verdict: effectiveVerdict(link) }));
  const fixedBy = issue.resolved_solution_id ? (solutionData.solutions.find((s) => s.id === issue.resolved_solution_id) ?? null) : null;
  const bar = resolvedBar(issue, undefined, fixedBy?.name);
  const owners = issue.owner_ids.length ? issue.owner_ids : issue.owner_person_id ? [issue.owner_person_id] : [];
  const processIdOf = issue.links.find((l) => l.process_id)?.process_id ?? issue.process_id ?? bundle.process.id;
  const lastChange = events.length ? events.reduce((a, e) => (e.at > a ? e.at : a), events[0]!.at) : issue.updated_at;

  // The draft the dialogs start from. Where source links are loaded, the sources it shows are the links (they change under "+ Link" and the x,
  // which this issue's copy from the page load doesn't see): it starts from those, or saving would put back what was just removed.
  const currentDraft = () => ({
    ...draftFromIssue(issue),
    sourceIds: editSourceIds(issue.source_ids, sourceLinking ? sourceLinking.linkedTo({ kind: "issue", issueId: issue.id }).map((x) => x.source.id) : null),
  });
  const saveDraft = (draft: ReturnType<typeof currentDraft>) =>
    state.save(toSaveInput(draft, options)).then((r) => r && (void sourceLinking?.syncIssue(issue.id, draft.sourceIds), refresh(), r));

  // The status pill: saves at once through the per-field status save; Resolved asks which solution fixed it first.
  const changeStatus = async (next: IssueStatus) => {
    if (next === issue.status) return;
    if (next === "resolved") return setResolving(true);
    setPageError(null);
    let from = issue.status;
    if (!open && (next === "open" || next === "testing")) {
      const reopened = await state.reopen(issue.id);
      if (!reopened) return;
      from = reopened.status;
      if (next === "open") return refresh();
    }
    const out = await state.saver(issue.id, "status")(from, next);
    if (out.status === "saved") return refresh();
    setPageError(out.status === "conflict" ? "Someone else changed the status first. Reload to see theirs." : out.status === "error" ? out.message : "You don't have permission to change issues here.");
  };

  const saveEvidence = async (next: string) => {
    // A target still in the old fields was shown as a line of this text: save the whole issue once, which keeps the text as edited and
    // clears the old fields (so a line taken out stays out).
    if (issue.target_measure || issue.target_now || issue.target_goal) {
      const saved = await saveDraft({ ...currentDraft(), evidence: next || null, targetMeasure: "", targetNow: "", targetGoal: "" });
      return saved ? null : (state.error ?? "Couldn't save. Try again.");
    }
    const out = await state.saver(issue.id, "evidence")(issue.evidence ?? null, next || null);
    if (out.status === "saved") {
      refresh();
      return null;
    }
    return out.status === "conflict" ? "Someone else changed this first. Reload to see theirs." : out.status === "error" ? out.message : "You don't have permission to change issues here.";
  };

  const saveNotes = async (solution: SolutionRow, notes: string) => {
    if (mode === "demo") {
      setDemoNotes(solution.id, notes);
      return null;
    }
    const r = await saveSolutionNotes(bundle.workspace.id, solution.id, notes);
    if (r.status === "error") return r.message;
    setLocal((d) => ({ ...d, solutions: d.solutions.map((s): SolutionRow => (s.id === solution.id ? { ...s, notes: r.notes } : s)) }));
    return null;
  };

  const putLink = (link: SolutionIssueRow) => setLocal((d) => ({ ...d, links: d.links.some((l) => l.solution_id === link.solution_id && l.issue_id === link.issue_id) ? d.links : [...d.links, link] }));
  const linkable = solutionData.solutions.filter((s) => s.process_id === processIdOf && !tried.some((t) => t.solution.id === s.id));

  const sourceCount = sourceLinking ? sourceLinking.linkedTo({ kind: "issue", issueId: issue.id }).length : issue.source_ids.length;
  const processLabel = processName.get(processIdOf) ?? bundle.process.name;

  return (
    <>
      <DetailLayout
        data-issue-page={issue.number ?? issue.id}
        breadcrumb={<DetailBreadcrumb items={[{ label: "Issues", href: `${base}/issues` }, { label: issue.number ? `#${issue.number}` : "Issue" }]} />}
        header={
          <PageHeader
            label="Issue"
            testId="issue-header"
            title={
              <>
                {issue.number != null && <span className="font-mono font-normal text-fg-3">#{issue.number}</span>}
                {issue.number != null && " "}
                {issue.title}
              </>
            }
            pills={
              <>
                <RatingPill rating={ratingOfStored(issue.severity)} />
                <IssueStatusMenu status={issue.status} onChange={(s) => void changeStatus(s)} disabled={!canEdit || state.busy} />
              </>
            }
            actionsLabel="Issue actions"
            actions={
              canEdit ? (
                <span className={`flex flex-wrap items-center gap-2 ${EDIT_ONLY}`} data-edit-entry>
                  <Button type="button" variant="outline" onClick={() => setEdit(true)}>
                    Edit
                  </Button>
                  {open ? (
                    <Button type="button" onClick={() => setResolving(true)}>
                      Resolve
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" disabled={state.busy} onClick={() => void state.reopen(issue.id).then((r) => r && refresh())}>
                      Reopen
                    </Button>
                  )}
                  <ActionsHelp label="Issue actions" items={open ? [{ help: ISSUE_PAGE_HELP.edit }, { help: ISSUE_PAGE_HELP.resolve }] : [{ help: ISSUE_PAGE_HELP.edit }, { help: ISSUE_PAGE_HELP.reopen }]} />
                </span>
              ) : undefined
            }
          />
        }
        notices={
          <>
            {(state.error || pageError) && (
              <p role="alert" className="text-sm text-destructive" data-page-error>
                {pageError ?? state.error}
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
          </>
        }
        rail={
          <MetaRail label="Issue details" data-issue-rail="">
            <RailItem term={owners.length > 1 ? "Owners" : "Owner"}>
              <OwnersEditor
                ownerIds={owners}
                people={options.people}
                names={personName}
                canEdit={canEdit}
                busy={state.busy}
                onChange={(ownerIds) => void saveDraft({ ...currentDraft(), ownerIds })}
              />
            </RailItem>
            <RailItem term="Process">
              <Link href={`${base}/p/${processIdOf}`} className="hover:underline" data-issue-process>
                <TagPill tag={processLabel} className={HEADER_PILL} />
              </Link>
            </RailItem>
            <RailItem term="Created">{shortDate(issue.created_at)}</RailItem>
            <RailItem term="Last change">{shortDate(lastChange)}</RailItem>
            {issue.resolved_at && !open && <RailItem term="Closed">{shortDate(issue.resolved_at)}</RailItem>}
            <RailItem term="Sources">
              <a href="#wrong" className="hover:underline" data-rail-sources>
                {sourceCount ? `${sourceCount} linked` : "None yet"}
              </a>
            </RailItem>
            <RailItem term="Solutions">
              <a href="#solutions" className="hover:underline" data-rail-solutions>
                {tried.length ? `${tried.length} tried` : "None tried yet"}
              </a>
              {fixedBy && (
                <span className="block font-normal text-fg-2">
                  Fixed by{" "}
                  <Link href={solutionHref(base, fixedBy.id)} className="font-medium text-foreground hover:underline">
                    {fixedBy.name}
                  </Link>
                </span>
              )}
            </RailItem>
          </MetaRail>
        }
      >
        <SectionCard
          id="where"
          section="where"
          title={
            <span className="flex items-center">
              Where this issue sits
              <Help {...ISSUE_PAGE_HELP.where} />
            </span>
          }
        >
          {/* An issue belongs to its process, not a step (QA round 2): the map shows the process, with no step badges or highlight. */}
          <MapCut>
            <ProcessCanvas key={bundle.process.id} bundle={bundle} rating={rating} showPlayback={false} showLanes={false} height="auto" legend={false} />
          </MapCut>
        </SectionCard>

        <SectionCard
          id="wrong"
          section="wrong"
          title={
            <span className="flex items-center">
              What&apos;s wrong and sources
              <Help {...ISSUE_PAGE_HELP.wrong} />
            </span>
          }
        >
          <EditableText
            // The target is part of what's wrong (QA round 2): one stored in the old fields shows here as a line.
            value={wrongText(issue.evidence, { measure: issue.target_measure, now: issue.target_now, goal: issue.target_goal })}
            canEdit={canEdit}
            label="What's wrong"
            onSave={saveEvidence}
            starter={WRONG_PROMPTS}
            rows={10}
            emptyMessage="Say what goes wrong, how often, what it costs, and what good would look like."
            emptyReader="Nothing written yet."
            data-evidence=""
          />
          <div className="flex flex-col gap-2 border-t border-line pt-3" data-issue-sources>
            <h3 className="flex items-center text-sm font-semibold">
              Sources
              <Help {...ISSUE_PAGE_HELP.sources} />
              {!sourceLinking && canEdit && (
                <span className={`ml-auto flex items-center ${EDIT_ONLY}`} data-edit-entry>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setLinking(true)}>
                    + Link
                  </Button>
                  <Help {...ISSUE_PAGE_HELP.link} />
                </span>
              )}
            </h3>
            {sourceLinking ? (
              <LinkedSources
                target={{ kind: "issue", issueId: issue.id }}
                label={issue.number ? `Issue #${issue.number}` : `Issue: ${issue.title}`}
                empty="None yet"
                hideTitle
                className="flex flex-col gap-2"
              />
            ) : issue.source_ids.length ? (
              issue.source_ids.map((id) => (
                <div key={id} className="text-sm font-medium">
                  {sourceTitle.get(id) ?? "A source"}
                </div>
              ))
            ) : (
              <span className="text-sm text-fg-2">None yet</span>
            )}
          </div>
        </SectionCard>

        <SectionCard
          id="solutions"
          section="solutions"
          title={
            <span className="flex items-center">
              Solutions tried
              <Help {...ISSUE_PAGE_HELP.solutions} />
            </span>
          }
          description="Each solution lives on its own. Here is how each one is getting on against this issue."
          actionIsEdit
          actionClassName={EDIT_ONLY}
          action={
            canEdit && open ? (
              <span className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setLinkingSolution(true)} data-link-solution>
                  Link an existing solution
                </Button>
                <Button asChild size="sm">
                  <Link href={buildHref} data-try-solution>
                    <EditMarker />+ Try a new solution
                  </Link>
                </Button>
                <Help {...ISSUE_PAGE_HELP.build} />
              </span>
            ) : undefined
          }
        >
          {tried.length ? (
            <ul className="flex flex-col gap-2" aria-label="Solutions tried" data-solutions-tried>
              {tried.map(({ solution, link }) => (
                <TriedRow
                  key={solution.id}
                  solution={solution}
                  link={link}
                  base={base}
                  mode={mode}
                  canEdit={canEdit}
                  onStatus={(status) => setLocal((d) => ({ ...d, solutions: d.solutions.map((s): SolutionRow => (s.id === solution.id ? { ...s, status } : s)) }))}
                  onError={setPageError}
                  onNotes={(notes) => saveNotes(solution, notes)}
                  onLogged={refresh}
                />
              ))}
            </ul>
          ) : (
            <EmptyState icon={FlaskConical} data-empty="solutions">
              No solutions tried yet. Copy the map, change it, and compare it with today.
            </EmptyState>
          )}
        </SectionCard>
      </DetailLayout>

      <AcknowledgeDialog
        open={edit}
        mode="edit"
        draft={currentDraft()}
        issueNumber={issue.number}
        options={options}
        busy={state.busy}
        error={state.error}
        onClose={() => setEdit(false)}
        onSubmit={saveDraft}
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
      <LinkSolutionDialog
        open={linkingSolution}
        solutions={linkable}
        onClose={() => setLinkingSolution(false)}
        onLink={async (solutionId) => {
          if (mode === "demo") {
            const solution = solutionData.solutions.find((s) => s.id === solutionId);
            if (!solution) return "That solution isn't there any more.";
            addDemoLink(solution.id, issue.id, { autoVerdict: null, holdsPct: null, autoNote: "" });
            return null;
          }
          const r = await linkSolutionToIssue(bundle.workspace.id, solutionId, issue.id);
          if (r.status === "error") return r.message;
          putLink(r.link);
          // The issue moved to Testing solutions: reload what the server knows.
          router.refresh();
          refresh();
          return null;
        }}
      />
    </>
  );
}

/** One solution tried: its name (the row opens its page), status, date, what it changes, how it does against today, and notes. */
function TriedRow({
  solution,
  link,
  base,
  mode,
  canEdit,
  onStatus,
  onError,
  onNotes,
  onLogged,
}: {
  solution: SolutionRow;
  link: SolutionIssueRow;
  base: string;
  mode: ScreenMode;
  canEdit: boolean;
  onStatus: (status: SolutionRow["status"]) => void;
  onError: (message: string | null) => void;
  onNotes: (notes: string) => Promise<string | null>;
  onLogged: () => void;
}) {
  return (
    <li data-solution={solution.id} className="relative flex flex-col gap-1.5 rounded-lg bg-muted/40 px-4 py-3 transition-colors focus-within:bg-muted/70 hover:bg-muted/70">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {/* The whole row opens the solution; the status and the notes sit above it. */}
        <Link href={solutionHref(base, solution.id)} className="min-w-0 text-sm font-semibold after:absolute after:inset-0 after:content-[''] hover:underline" data-tried-name>
          {solution.name}
        </Link>
        <span className="relative z-10">
          <SolutionStatusMenu
            solution={solution}
            mode={mode}
            onError={onError}
            onSaved={(s) => {
              onStatus(s);
              onLogged();
            }}
          />
        </span>
        <span className="text-xs text-fg-3">Tried {shortDate(link.created_at)}</span>
      </div>
      <p className="text-xs text-fg-2" data-tried-changes>
        Changes: {changesLine(solution, 3)}
      </p>
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-fg-2" data-tried-result>
        {link.user_verdict ? (
          <span>
            Your call: <VerdictWord verdict={link.user_verdict} className="text-xs" />
          </span>
        ) : (
          <>
            <span>No verdict yet.</span>
            <Link href={solutionHref(base, solution.id)} className="relative z-10 underline decoration-dotted underline-offset-2 hover:decoration-solid">
              Open to compare
            </Link>
          </>
        )}
      </p>
      {(canEdit || solution.notes) && (
        <div className="relative z-10">
          <EditableText value={solution.notes} canEdit={canEdit} label={`Notes on ${solution.name}`} rows={3} onSave={onNotes} emptyMessage="No notes yet." addLabel="Add a note" className="text-xs" />
        </div>
      )}
    </li>
  );
}

/** Who owns the issue, edited in place: a popover with the people to tick. Readers see the names. */
function OwnersEditor({
  ownerIds,
  people,
  names,
  canEdit,
  busy,
  onChange,
}: {
  ownerIds: string[];
  people: { id: string; name: string }[];
  names: ReadonlyMap<string, string>;
  canEdit: boolean;
  busy: boolean;
  onChange: (next: string[]) => void;
}) {
  // The rail's term says Owner or Owners; the value is the names.
  const label = ownerIds.length ? ownerIds.map((id) => names.get(id) ?? "Someone").join(", ") : "No owner yet";
  if (!canEdit) return <span data-owners>{label}</span>;
  const toggle = (id: string) => onChange(ownerIds.includes(id) ? ownerIds.filter((x) => x !== id) : [...ownerIds, id]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-owners className="inline-flex items-center gap-1 rounded-md text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-sm:pointer-events-none" aria-label={`${ownerIds.length > 1 ? "Owners" : "Owner"}: ${label}. Change owners`}>
          {label}
          <Pencil aria-hidden className={`size-3 text-fg-3 ${EDIT_ONLY}`} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-0.5 p-1.5" data-owners-menu>
        <div className="flex items-center px-2 py-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
          Owners
          <Help {...ISSUE_PAGE_HELP.owners} />
        </div>
        {people.length ? (
          people.map((p) => (
            <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
              <input type="checkbox" checked={ownerIds.includes(p.id)} disabled={busy} onChange={() => toggle(p.id)} data-option={p.id} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
            </label>
          ))
        ) : (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">There are no people to pick yet.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The map in a plain block, cut to its steps until someone moves it. */
function MapCut({ children }: { children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  // A short map is fitted to a panel that is never shorter than 16rem, which leaves a band of empty card under it. Until someone moves the
  // map, the card is cut to the lowest step plus a little room. (Moving or zooming the map lifts the cut, so nothing is ever hidden.)
  const [cut, setCut] = useState<number | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let moved = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      if (moved) return;
      const nodes = el.querySelectorAll(".react-flow__node");
      if (!nodes.length) return;
      const top = el.getBoundingClientRect().top;
      let bottom = 0;
      nodes.forEach((n) => (bottom = Math.max(bottom, n.getBoundingClientRect().bottom)));
      setCut(Math.ceil(bottom - top + 20));
    };
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(measure, 450);
    };
    const lift = () => {
      moved = true;
      setCut(null);
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(el, { childList: true, subtree: true });
    const resize = new ResizeObserver(check);
    resize.observe(el);
    el.addEventListener("pointerdown", lift);
    el.addEventListener("wheel", lift, { passive: true });
    el.addEventListener("keydown", lift);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      resize.disconnect();
      el.removeEventListener("pointerdown", lift);
      el.removeEventListener("wheel", lift);
      el.removeEventListener("keydown", lift);
    };
  }, []);
  return (
    <div ref={host} className="min-w-0 overflow-hidden rounded-token border bg-card" style={cut ? { maxHeight: cut } : undefined} data-map-cut={cut ?? undefined}>
      {children}
    </div>
  );
}

function LinkSolutionDialog({ open, solutions, onLink, onClose }: { open: boolean; solutions: SolutionRow[]; onLink: (solutionId: string) => Promise<string | null>; onClose: () => void }) {
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choice = solutions.some((s) => s.id === picked) ? picked : (solutions[0]?.id ?? "");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-link-solution-dialog>
        <DialogHeader>
          <DialogTitle>Link an existing solution</DialogTitle>
          <DialogDescription>Test a solution you already built for this process against this issue. It gets its own automatic verdict.</DialogDescription>
        </DialogHeader>
        {solutions.length ? (
          <label className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Solution</span>
            <NativeSelect aria-label="Solution" value={choice} onChange={(e) => setPicked(e.target.value)}>
              {solutions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : (
          <p className="text-sm text-muted-foreground">There are no other solutions for this process to link.</p>
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
          <Button
            type="button"
            disabled={!choice || busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onLink(choice)
                .then((message) => (message ? setError(message) : onClose()))
                .finally(() => setBusy(false));
            }}
          >
            Link solution
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
