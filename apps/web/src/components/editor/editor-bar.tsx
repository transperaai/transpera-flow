"use client";

// The Editor's top: one 48px row in the edit colour (so you can always tell you are editing). The title and whether edits
// are saved on the left, undo and redo, then the buttons that save; Discard, History and Exit fold into a "More" menu under
// 1280px. Publish and Discard ask first (issue #104). The mode's hint, the things to fix and the block and solution forms
// sit in the inspector (`EditorGuide`, `BlockFormFields`, `SolutionFormFields` below); the draft's notices sit over the map
// (`DraftMessages`).

import { useEffect, useRef, useState, type ComponentProps } from "react";
import Link from "next/link";
import { CircleHelp, Ellipsis, Redo2, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import type { StepRow } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BreaksWarning } from "@/components/draft-panels";
import type { DraftSession, DraftState } from "@/lib/drafts/session";
import { MODE_INFO, SOLUTION_FOR_ISSUE, type EditorMode } from "@/lib/editor/modes";
import type { SolutionIssue } from "@/lib/solutions/area";
import type { BreakingScenario } from "@/lib/scenarios/broken";
import { cn } from "@/lib/utils";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How a button looks on the edit-coloured bar: outlined in the bar's text colour, solid for the main action, or bare (icons). */
const BAR_TONE = {
  outline: "border-edit-fg/50 bg-transparent text-edit-fg hover:bg-edit-fg/15 hover:text-edit-fg aria-expanded:bg-edit-fg/15 aria-expanded:text-edit-fg dark:bg-transparent dark:hover:bg-edit-fg/15",
  solid: "border-edit-fg bg-edit-fg text-edit hover:bg-edit-fg/90 hover:text-edit dark:bg-edit-fg dark:hover:bg-edit-fg/90",
  ghost: "border-transparent bg-transparent text-edit-fg hover:bg-edit-fg/15 hover:text-edit-fg dark:bg-transparent dark:hover:bg-edit-fg/15",
} as const;

/** Every button on the Editor's bar: a `Button` (outline, small) in one of the bar's tones. */
export function BarButton({ tone = "outline", className, ...props }: ComponentProps<typeof Button> & { tone?: keyof typeof BAR_TONE }) {
  return <Button type="button" variant="outline" size="sm" {...props} className={cn(BAR_TONE[tone], className)} />;
}

/** The "✎ Editor" tag at the start of the bar. */
export function EditorTag() {
  return <span className="shrink-0 rounded border-[1.5px] border-current px-1.5 py-px font-mono text-2xs font-semibold tracking-widest uppercase">✎ Editor</span>;
}

/** The bar's frame: one row, 48px, that never wraps. */
export const BAR_CLASS = "flex h-12 shrink-0 flex-nowrap items-center gap-3 bg-edit px-3 text-edit-fg";

/** Block mode's form: the name and description the block is saved with, and the save itself. */
export interface BlockForm {
  name: string;
  description: string;
  onName: (value: string) => void;
  onDescription: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  /** What went wrong with the last save, in plain English. */
  error: string | null;
  /** Editing a block already in the library (Q15), not making a new one. */
  editing?: boolean;
}

/** Solution mode's form: the name the solution is saved with, and the save itself. */
export interface SolutionForm {
  name: string;
  onName: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  /** What went wrong with the last save, in plain English. */
  error: string | null;
  /** Set when the save was refused for want of an issue (Q12): where "Edit the process instead" and "Save as a block" go. */
  refusedWithout: { processHref: string; blockHref: string } | null;
}

const BLOCK_EDIT_TITLE = "Edit block";
const BLOCK_EDIT_HINT = "You're editing a block in the library. Nothing changes until you press Save changes, and solutions that already use the block keep their own copy. Cancel goes back to the library.";
const COMPANY_TITLE = "Draft of the company map";
const COMPANY_HINT =
  "You're editing a draft of the company map. Move cards, draw and label handoff lines, or put cards in groups. A line from one pipeline to another (Sales to Onboarding, say) carries each won client on into it; a line to client work is drawn only, because its service runs it. The live map doesn't change until you publish.";

export function EditorBar({
  mode,
  subject,
  session,
  drafts,
  changes,
  saving,
  blocked,
  unresolved,
  breaks,
  onReview,
  exitHref,
  onPublished,
  canSave,
  blockForm,
  solutionForm,
  issue = null,
  company = false,
  onTour,
  historyHref,
  history,
  publishBlocked = null,
}: {
  /** Why Publish has to wait on what is wrong with the process (see `publishBlocker`), or null. */
  publishBlocked?: string | null;
  mode: EditorMode;
  /** What is being edited: the process's name. */
  subject: string;
  session: DraftSession;
  drafts: DraftState;
  /** How many changes the draft has against live. */
  changes: number;
  /** Edits still being saved. */
  saving: boolean;
  /** Why publishing has to wait (saving, a conflict, an unsimulatable draft), or null. */
  blocked: string | null;
  /** Steps of the draft still marked as estimates. */
  unresolved: StepRow[];
  /** Saved scenarios publishing would break. */
  breaks: BreakingScenario[];
  /** Show a step in the inspector (from the publish check's list of estimates). */
  onReview: (stepId: string) => void;
  exitHref: string;
  /** After a publish: go on (the live editor returns to the map). */
  onPublished: (revisionNumber: number) => void;
  /** Saving works in this mode: draft mode, or one that has plugged its save in. */
  canSave: boolean;
  /** Block mode only: the form the block is saved from. */
  blockForm?: BlockForm;
  /** Solution mode only: the form the solution is saved from. */
  solutionForm?: SolutionForm;
  /** Solution mode only: the issue the solution is built for, if any. */
  issue?: SolutionIssue | null;
  /** The company map (B11): the business as a map of processes (the Sandbox simulates what is on it), so no Simulate here and the words say "map". */
  company?: boolean;
  /** Starts the written tour of the Editor (B18); without it there is no "Take the tour" button. */
  onTour?: () => void;
  /** The History page of what is edited: shows a History button that goes there (after the last edits are saved). */
  historyHref?: string;
  /** Undo and redo: what each would step over (null when there is nothing to do), and the actions. Without it there are no buttons. */
  history?: { undoLabel: string | null; redoLabel: string | null; onUndo: () => void; onRedo: () => void };
}) {
  const info = MODE_INFO[mode];
  const router = useRouter();
  const [confirming, setConfirming] = useState<"publish" | "discard" | null>(null);
  const [saved, setSaved] = useState(false);
  // "Saved ✓" shows for a moment after Save draft; the timer is dropped if the Editor goes first.
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );
  const hasDraft = drafts.draft !== null || drafts.opening;
  const liveNumber = drafts.live.revision.number;
  const draftNumber = drafts.draft?.number ?? liveNumber + 1;
  const unpublished = liveNumber === 0;
  const busy = drafts.busy !== null;
  const estimates = drafts.unresolved ?? unresolved.map((s) => ({ id: s.id, name: s.name }));
  const conflicts = unresolved.filter((s) => s.conflict).length;
  const arrives = info.available ? undefined : `${info.arrivesWith} arrive${info.arrivesWith?.endsWith("s") ? "" : "s"} in a later release.`;
  const title = mode === "solution" && issue ? SOLUTION_FOR_ISSUE.title(issue) : company ? COMPANY_TITLE : mode === "block" && blockForm?.editing ? BLOCK_EDIT_TITLE : info.title(subject);

  const saveDraft = async () => {
    try {
      await session.editor.settled();
    } catch {
      // A save that failed is shown over the map (SaveProblems); don't claim it was saved.
      return;
    }
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 2500);
  };
  // Edits save as they are made; let the last ones land before leaving. A failed save is shown on the map, and leaving still works.
  const leaveFor = async (href: string) => {
    await session.editor.settled().catch(() => undefined);
    router.push(href);
  };
  const exitLabel = mode === "block" && blockForm?.editing ? "Cancel" : "Exit editor";
  const discard = mode === "draft" ? { disabled: busy || !hasDraft, run: () => setConfirming("discard") } : null;
  const historyLink = mode === "draft" && historyHref ? historyHref : null;

  return (
    <header className="contents">
      <div className={BAR_CLASS}>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <EditorTag />
          <h1 className="min-w-0 shrink truncate text-base font-semibold" title={title}>
            {title}
          </h1>
          {mode === "draft" && (
            <span data-tour="draft" className="min-w-0 shrink-[2] truncate rounded-full bg-edit-fg/15 px-2 py-0.5 text-xs font-semibold" aria-live="polite">
              {unpublished ? "Not published yet" : hasDraft ? `Draft version ${draftNumber} · live is version ${liveNumber}` : `New draft (version ${draftNumber}) · live is version ${liveNumber}`}
              {changes ? ` · ${plural(changes, "change")}` : ""}
            </span>
          )}
          <span className="min-w-0 shrink-[3] truncate text-xs opacity-90" aria-live="polite">
            {mode === "block" ? blockForm?.editing ? "Nothing is saved until you press Save changes" : "Nothing is saved until you press Save to library" : mode === "solution" ? "Nothing is saved until you press Save solution" : saving ? "Saving…" : hasDraft ? "All changes saved to the draft" : "Nothing changed yet"}
          </span>
        </div>
        {history && (
          <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Undo and redo" data-history-buttons>
            <BarButton
              size="icon-sm"
              data-undo
              aria-label={history.undoLabel ? `Undo: ${history.undoLabel}` : "Undo"}
              title={history.undoLabel ? `Undo: ${history.undoLabel}` : "Nothing to undo"}
              disabled={!history.undoLabel}
              onClick={history.onUndo}
            >
              <Undo2 aria-hidden />
            </BarButton>
            <BarButton
              size="icon-sm"
              data-redo
              aria-label={history.redoLabel ? `Redo: ${history.redoLabel}` : "Redo"}
              title={history.redoLabel ? `Redo: ${history.redoLabel}` : "Nothing to redo"}
              disabled={!history.redoLabel}
              onClick={history.onRedo}
            >
              <Redo2 aria-hidden />
            </BarButton>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          {onTour && (
            <BarButton tone="ghost" size="icon-sm" onClick={onTour} data-take-tour aria-label="Take the tour" title="Take the tour">
              <CircleHelp aria-hidden />
            </BarButton>
          )}
          {/* The secondary actions: in the row from 1280px, folded into "More" under it. */}
          {discard && (
            <BarButton className="hidden xl:inline-flex" disabled={discard.disabled} onClick={discard.run}>
              Discard…
            </BarButton>
          )}
          {historyLink && (
            <BarButton className="hidden xl:inline-flex" data-tour="history" onClick={() => void leaveFor(historyLink)}>
              History
            </BarButton>
          )}
          <BarButton className="hidden xl:inline-flex" onClick={() => void leaveFor(exitHref)}>
            {exitLabel}
          </BarButton>
          {/* Under 1280px History lives in here, so the tour points here for it. */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <BarButton size="icon-sm" className="xl:hidden" aria-label="More actions" title="More actions" data-tour={historyLink ? "history" : undefined}>
                <Ellipsis aria-hidden />
              </BarButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              {discard && (
                <DropdownMenuItem disabled={discard.disabled} onSelect={discard.run}>
                  Discard…
                </DropdownMenuItem>
              )}
              {historyLink && <DropdownMenuItem onSelect={() => void leaveFor(historyLink)}>History</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => void leaveFor(exitHref)}>{exitLabel}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {info.save.map((s) => {
            const tone = s.primary ? "solid" : "outline";
            if (s.id === "save-draft") {
              return (
                <BarButton key={s.id} tone={tone} onClick={() => void saveDraft()}>
                  {saved ? "Saved ✓" : s.label}
                </BarButton>
              );
            }
            if (s.id === "publish") {
              return (
                <BarButton
                  key={s.id}
                  tone={tone}
                  data-tour="publish"
                  disabled={busy || !drafts.draft || !changes || !!publishBlocked}
                  title={!changes ? "Nothing to publish yet." : (publishBlocked ?? undefined)}
                  onClick={() => setConfirming("publish")}
                >
                  {s.label}
                </BarButton>
              );
            }
            if (s.id === "save-solution" && solutionForm) {
              return (
                <BarButton key={s.id} tone={tone} disabled={!canSave || solutionForm.saving} onClick={solutionForm.onSave}>
                  {solutionForm.saving ? "Saving…" : s.label}
                </BarButton>
              );
            }
            if (s.id === "save-block" && blockForm) {
              return (
                <BarButton key={s.id} tone={tone} disabled={!canSave || blockForm.saving} onClick={blockForm.onSave}>
                  {blockForm.saving ? "Saving…" : blockForm.editing ? "Save changes" : s.label}
                </BarButton>
              );
            }
            return (
              <BarButton key={s.id} tone={tone} disabled={!canSave} title={arrives}>
                {s.label}
              </BarButton>
            );
          })}
          {mode === "block" && (
            <Help
              label="Save to library"
              description="Saves everything on this map as a block in the library, under the name and description in the right column. You can then insert it into any process, and the map here is left as it is."
              example="Name it “Client sign-off”, press Save to library, and it shows up on the Block library page."
              className="border-edit-fg bg-transparent text-edit-fg hover:bg-edit-fg hover:text-edit focus-visible:bg-edit-fg focus-visible:text-edit"
            />
          )}
          {mode === "solution" && (
            <Help
              label="Save solution"
              description="Saves your changes as a solution of its own, under the name in the right column, and works out its automatic verdict. Live and the draft are left exactly as they are."
              example="Name it “AI lead qualifier”, press Save solution, and it shows under Solutions on the process page."
              className="border-edit-fg bg-transparent text-edit-fg hover:bg-edit-fg hover:text-edit focus-visible:bg-edit-fg focus-visible:text-edit"
            />
          )}
        </div>
      </div>

      <Dialog open={confirming === "publish"} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Publish version {draftNumber}?</DialogTitle>
            <DialogDescription>
              {company
                ? `This replaces the live company map. Version ${liveNumber} stays in History and can be restored.`
                : unpublished
                  ? `This makes ${subject} live for the first time.`
                  : `This replaces the live map of ${subject}. Version ${liveNumber} stays in History and can be restored.`}
            </DialogDescription>
          </DialogHeader>
          {estimates.length > 0 && (
            <div className="flex flex-col gap-2 rounded-token border border-warn bg-warn-soft p-2 text-xs">
              <p>
                <strong>
                  {plural(estimates.length, "step")} {estimates.length === 1 ? "holds" : "hold"}{" "}
                  {conflicts ? `unresolved conflicts (${conflicts}) or unconfirmed estimates` : "unconfirmed estimates"}.
                </strong>{" "}
                Check them first, or publish and accept them as estimates (recorded in the audit log).
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {estimates.map((s) => (
                  <li key={s.id}>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        setConfirming(null);
                        onReview(s.id);
                      }}
                    >
                      Review {s.name}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {breaks.length > 0 && <BreaksWarning breaks={breaks} />}
          {blocked && <p className="text-xs text-fg-2">{blocked}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy || !!blocked}
              onClick={async () => {
                const r = await session.publish(estimates.length > 0);
                if (r?.status === "published") {
                  setConfirming(null);
                  onPublished(r.revision.number);
                }
              }}
            >
              {drafts.busy === "publishing" ? "Publishing…" : estimates.length ? `Publish, accepting ${plural(estimates.length, "estimate")}` : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirming === "discard"} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Discard this draft?</DialogTitle>
            <DialogDescription>
              All {plural(changes, "change")} in this draft are thrown away and the editor goes back to live (version {liveNumber}). This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(null)} autoFocus>
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (await session.discard()) setConfirming(null);
              }}
            >
              {drafts.busy === "discarding" ? "Discarding…" : "Discard draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}

/** The words for what this mode is, at the top of the inspector, with the line of things to fix that jumps to the first. */
export function EditorGuide({
  mode,
  company = false,
  issue = null,
  blockEditing = false,
  problems = null,
}: {
  mode: EditorMode;
  company?: boolean;
  issue?: SolutionIssue | null;
  /** Block mode on a block already in the library (Q15). */
  blockEditing?: boolean;
  /** What stops the process simulating, as one line ("2 things to fix before this can simulate") that jumps to the first (editor brainstorm, item 4). */
  problems?: { line: string; onJump: () => void; canJump: boolean } | null;
}) {
  const info = MODE_INFO[mode];
  return (
    <div className="flex flex-col gap-2" data-editor-guide>
      {problems && (
        <button
          type="button"
          data-problems-line
          disabled={!problems.canJump}
          onClick={problems.onJump}
          title={problems.canJump ? "Show the first one" : undefined}
          className="inline-flex items-center gap-1.5 self-start rounded-full border border-crit bg-panel px-2 py-0.5 text-xs font-semibold text-crit enabled:hover:bg-crit-soft"
        >
          <span aria-hidden className="inline-flex size-4 items-center justify-center rounded-full bg-crit text-2xs font-bold text-crit-fg">
            !
          </span>
          {problems.line}
        </button>
      )}
      <p className="rounded-md border border-edit/30 bg-edit-soft px-2.5 py-2 text-xs text-fg-2" role="note">
        {mode === "solution" && issue ? SOLUTION_FOR_ISSUE.hint : company ? COMPANY_HINT : mode === "block" && blockEditing ? BLOCK_EDIT_HINT : info.hint}
      </p>
    </div>
  );
}

/** The draft's notices (someone else's draft, published, discarded) and failures, over the map until dismissed. */
export function DraftMessages({ drafts, session }: { drafts: DraftState; session: DraftSession }) {
  if (!drafts.notice && !drafts.error) return null;
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      {drafts.notice && (
        <p role="status" className="flex items-center justify-between gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 font-semibold">
          <span>{drafts.notice}</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => session.dismiss()}>
            Dismiss
          </Button>
        </p>
      )}
      {drafts.error && (
        <p role="alert" className="flex items-center justify-between gap-2 rounded-md border border-crit bg-crit-soft px-2.5 py-1.5 font-semibold text-crit">
          <span>{drafts.error}</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => session.dismiss()}>
            Dismiss
          </Button>
        </p>
      )}
    </div>
  );
}

/** Block mode's name and description, at the top of the inspector. */
export function BlockFormFields({ form }: { form: BlockForm }) {
  return (
    <div className="flex flex-col gap-3" data-block-form>
      <label className="flex flex-col gap-1 text-xs font-semibold">
        <span className="flex items-center">
          Block name
          <Help
            label="Block name"
            description="What the block is called in the library and in the left column. When you insert it, the new group takes this name."
            example="“Client sign-off” or “AI lead check”."
          />
        </span>
        <Input value={form.name} maxLength={200} placeholder="Block name" onChange={(e) => form.onName(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold">
        <span className="flex items-center">
          Description
          <Help
            label="Description"
            description="One line on what the block does and when to use it. It shows on the block's card in the library."
            example="Send the summary, chase once, and record the client's decision."
          />
        </span>
        <Input value={form.description} maxLength={2000} placeholder="What it does and when to use it (optional)" onChange={(e) => form.onDescription(e.target.value)} />
      </label>
      {form.error && (
        <p role="alert" className="text-xs font-semibold text-crit">
          {form.error}
        </p>
      )}
    </div>
  );
}

/** Solution mode's name, and why a save was refused, at the top of the inspector. */
export function SolutionFormFields({ form }: { form: SolutionForm }) {
  return (
    <div className="flex flex-col gap-3" data-solution-form>
      <label className="flex flex-col gap-1 text-xs font-semibold">
        <span className="flex items-center">
          Solution name
          <Help
            label="Solution name"
            description="What this solution is called on the Solutions list and on the issue it solves. Pick something that says what changes."
            example="“AI lead qualifier” or “Invoice on go-live”."
          />
        </span>
        <Input value={form.name} maxLength={200} placeholder="Solution name" onChange={(e) => form.onName(e.target.value)} />
      </label>
      {form.error && (
        <div role="alert" className="flex flex-col gap-2 text-xs" data-solution-refused={form.refusedWithout ? "" : undefined}>
          <p className="font-semibold text-crit">{form.error}</p>
          {form.refusedWithout && (
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href={form.refusedWithout.processHref} data-edit-process-instead>
                  Edit the process instead
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={form.refusedWithout.blockHref} data-save-as-block>
                  Save as a block
                </Link>
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
