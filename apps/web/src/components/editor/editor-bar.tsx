"use client";

// The Editor's top: the "✎ Editor" bar in the edit colour (so you can always tell you are editing), the draft or live
// banner, the hint for the mode, and the buttons that save. Publish and Discard ask first (issue #104).

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { StepRow } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BreaksWarning } from "@/components/draft-panels";
import type { DraftSession, DraftState } from "@/lib/drafts/session";
import { MODE_INFO, SOLUTION_FOR_ISSUE, type EditorMode } from "@/lib/editor/modes";
import type { SolutionIssue } from "@/lib/solutions/area";
import type { BreakingScenario } from "@/lib/scenarios/broken";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A button on the edit-coloured bar: outlined in its text colour, or solid (the main action). */
const onBar = "border-edit-fg/50 bg-transparent text-edit-fg hover:bg-edit-fg/15 hover:text-edit-fg dark:bg-transparent dark:hover:bg-edit-fg/15";
const onBarSolid = "border-edit-fg bg-edit-fg text-edit hover:bg-edit-fg/90 hover:text-edit dark:bg-edit-fg dark:hover:bg-edit-fg/90";

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
}

/** Solution mode's form: the name the solution is saved with, and the save itself. */
export interface SolutionForm {
  name: string;
  onName: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  /** What went wrong with the last save, in plain English. */
  error: string | null;
}

const COMPANY_TITLE = "Draft of the company map";
const COMPANY_HINT =
  "You're editing a draft of the company map. Move cards, draw and label handoff lines, or put cards in groups. Handoff lines are pictures: they never change a simulation. The live map doesn't change until you publish.";

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
  simulating,
  onSimulate,
  onReview,
  exitHref,
  onPublished,
  canSave,
  blockForm,
  solutionForm,
  issue = null,
  company = false,
}: {
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
  simulating: boolean;
  onSimulate: () => void;
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
  /** The company map (B11): a picture of the business, so nothing to simulate and the words say "map". */
  company?: boolean;
}) {
  const info = MODE_INFO[mode];
  const router = useRouter();
  const [confirming, setConfirming] = useState<"publish" | "discard" | null>(null);
  const [saved, setSaved] = useState(false);
  const hasDraft = drafts.draft !== null || drafts.opening;
  const liveNumber = drafts.live.revision.number;
  const draftNumber = drafts.draft?.number ?? liveNumber + 1;
  const unpublished = liveNumber === 0;
  const busy = drafts.busy !== null;
  const estimates = drafts.unresolved ?? unresolved.map((s) => ({ id: s.id, name: s.name }));
  const conflicts = unresolved.filter((s) => s.conflict).length;
  const arrives = info.available ? undefined : `${info.arrivesWith} arrive${info.arrivesWith?.endsWith("s") ? "" : "s"} in a later release.`;

  return (
    <header className="contents">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-edit px-4 py-2.5 text-edit-fg">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="rounded border-[1.5px] border-current px-1.5 py-px font-mono text-[11px] font-semibold tracking-widest uppercase">✎ Editor</span>
          <h1 className="min-w-0 truncate text-[17px] font-bold">{mode === "solution" && issue ? SOLUTION_FOR_ISSUE.title(issue) : company ? COMPANY_TITLE : info.title(subject)}</h1>
          {mode === "draft" && (
            <span className="rounded-full bg-edit-fg/15 px-2 py-0.5 text-xs font-semibold" aria-live="polite">
              {unpublished ? "Not published yet" : hasDraft ? `Draft version ${draftNumber} · live is version ${liveNumber}` : `New draft (version ${draftNumber}) · live is version ${liveNumber}`}
              {changes ? ` · ${plural(changes, "change")}` : ""}
            </span>
          )}
          <span className="text-xs opacity-90" aria-live="polite">
            {mode === "block" ? "Nothing is saved until you press Save to library" : mode === "solution" ? "Nothing is saved until you press Save solution" : saving ? "Saving…" : hasDraft ? "All changes saved to the draft" : "Nothing changed yet"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {mode !== "block" && !company && (
            <>
            <Button type="button" variant="outline" size="sm" className={onBar} onClick={onSimulate} disabled={simulating || !!blocked} title={blocked ?? undefined}>
              {simulating ? "Simulating…" : "▶ Simulate"}
            </Button>
            <Help
              label="Simulate"
              description="Runs this version of the process 30 times and shows how the headline numbers change compared with the live version. Nothing is published."
              example="Add a faster approval step, press Simulate, and see cycle time drop from 9.6 days to 8.1."
              className="border-edit-fg bg-transparent text-edit-fg hover:bg-edit-fg hover:text-edit focus-visible:bg-edit-fg focus-visible:text-edit"
            />
            </>
          )}
          {info.save.map((s) => {
            const solid = s.primary;
            const cls = solid ? onBarSolid : onBar;
            if (s.id === "save-draft") {
              return (
                <Button
                  key={s.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cls}
                  onClick={async () => {
                    await session.editor.settled();
                    setSaved(true);
                    setTimeout(() => setSaved(false), 2500);
                  }}
                >
                  {saved ? "Saved ✓" : s.label}
                </Button>
              );
            }
            if (s.id === "publish") {
              return (
                <Button
                  key={s.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cls}
                  disabled={busy || !drafts.draft || !changes}
                  title={!changes ? "Nothing to publish yet." : undefined}
                  onClick={() => setConfirming("publish")}
                >
                  {s.label}
                </Button>
              );
            }
            if (s.id === "save-solution" && solutionForm) {
              return (
                <Button key={s.id} type="button" variant="outline" size="sm" className={cls} disabled={!canSave || solutionForm.saving} onClick={solutionForm.onSave}>
                  {solutionForm.saving ? "Saving…" : s.label}
                </Button>
              );
            }
            if (s.id === "save-block" && blockForm) {
              return (
                <Button key={s.id} type="button" variant="outline" size="sm" className={cls} disabled={!canSave || blockForm.saving} onClick={blockForm.onSave}>
                  {blockForm.saving ? "Saving…" : s.label}
                </Button>
              );
            }
            return (
              <Button key={s.id} type="button" variant="outline" size="sm" className={cls} disabled={!canSave} title={arrives}>
                {s.label}
              </Button>
            );
          })}
          {mode === "block" && (
            <Help
              label="Save to library"
              description="Saves everything on this map as a block in the library, under the name and description below. You can then insert it into any process, and the map here is left as it is."
              example="Name it “Client sign-off”, press Save to library, and it shows up on the Block library page."
              className="border-edit-fg bg-transparent text-edit-fg hover:bg-edit-fg hover:text-edit focus-visible:bg-edit-fg focus-visible:text-edit"
            />
          )}
          {mode === "solution" && (
            <Help
              label="Save solution"
              description="Saves your changes as a solution of its own, under the name below, and works out its automatic verdict. Live and the draft are left exactly as they are."
              example="Name it “AI lead qualifier”, press Save solution, and it shows under Solutions on the process page."
              className="border-edit-fg bg-transparent text-edit-fg hover:bg-edit-fg hover:text-edit focus-visible:bg-edit-fg focus-visible:text-edit"
            />
          )}
          {mode === "draft" && (
            <Button type="button" variant="outline" size="sm" className={onBar} disabled={busy || !hasDraft} onClick={() => setConfirming("discard")}>
              Discard…
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={onBar}
            onClick={async () => {
              // Edits save as they are made; let the last ones land before leaving.
              await session.editor.settled();
              router.push(exitHref);
            }}
          >
            Exit editor
          </Button>
        </div>
      </div>
      <p className="border-b border-line bg-edit-soft px-4 py-1.5 text-[12.5px]" role="note">
        {mode === "solution" && issue ? SOLUTION_FOR_ISSUE.hint : company ? COMPANY_HINT : info.hint}
        {drafts.notice && (
          <span role="status" className="ml-2 font-semibold">
            {drafts.notice}{" "}
            <button type="button" className="underline" onClick={() => session.dismiss()}>
              Dismiss
            </button>
          </span>
        )}
        {drafts.error && (
          <span role="alert" className="ml-2 font-semibold text-crit">
            {drafts.error}{" "}
            <button type="button" className="underline" onClick={() => session.dismiss()}>
              Dismiss
            </button>
          </span>
        )}
      </p>
      {mode === "block" && blockForm && (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-line bg-panel px-4 py-2" data-block-form>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs font-semibold sm:max-w-xs">
            <span className="flex items-center">
              Block name
              <Help
                label="Block name"
                description="What the block is called in the library and in the left column. When you insert it, the new group takes this name."
                example="“Client sign-off” or “AI lead check”."
              />
            </span>
            <Input value={blockForm.name} maxLength={200} placeholder="Block name" onChange={(e) => blockForm.onName(e.target.value)} />
          </label>
          <label className="flex min-w-48 flex-[2] flex-col gap-1 text-xs font-semibold sm:max-w-xl">
            <span className="flex items-center">
              Description
              <Help
                label="Description"
                description="One line on what the block does and when to use it. It shows on the block's card in the library."
                example="Send the summary, chase once, and record the client's decision."
              />
            </span>
            <Input value={blockForm.description} maxLength={2000} placeholder="What it does and when to use it (optional)" onChange={(e) => blockForm.onDescription(e.target.value)} />
          </label>
          {blockForm.error && (
            <p role="alert" className="text-xs font-semibold text-crit">
              {blockForm.error}
            </p>
          )}
        </div>
      )}

      {mode === "solution" && solutionForm && (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-line bg-panel px-4 py-2" data-solution-form>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs font-semibold sm:max-w-md">
            <span className="flex items-center">
              Solution name
              <Help
                label="Solution name"
                description="What this solution is called on the Solutions list and on the issue it solves. Pick something that says what changes."
                example="“AI lead qualifier” or “Invoice on go-live”."
              />
            </span>
            <Input value={solutionForm.name} maxLength={200} placeholder="Solution name" onChange={(e) => solutionForm.onName(e.target.value)} />
          </label>
          {solutionForm.error && (
            <p role="alert" className="text-xs font-semibold text-crit">
              {solutionForm.error}
            </p>
          )}
        </div>
      )}

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
