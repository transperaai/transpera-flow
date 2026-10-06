"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { PlayContact, ProposalRow } from "@transpera-flow/db";
import { reviewProposals } from "@/app/w/[slug]/suggestion-actions";
import { BlockMap } from "@/components/blocks/block-map";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { demoProposalBackend, useDemoCompany } from "@/lib/demo/company-store";
import { buildIdeaHref, ideaToBlock, readIdea } from "@/lib/suggestions/idea";
import { describeProposal, hasHeld, heldSeen, proposalSummary, SUGGESTIONS_HELP, withHeld, type ProposalLookups, type ProposalOutcome } from "@/lib/suggestions/proposals";

// A solution idea (A52, docs/PRD.md §7.1c; prototype: Suggestions, and AI ideas on the Issue page): the issue it is for, the
// idea in plain words, a small map of the proposed steps and what it would replace. "Build it" opens the Editor in solution mode
// with the steps placed; "Dismiss" throws the idea away. Nothing is built or simulated until someone presses Build it.

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

export function IdeaCard({
  p,
  lookups,
  base,
  from,
  canEdit,
  busy,
  onDismiss,
  linkableUpTo = Infinity,
  contact,
}: {
  p: ProposalRow;
  /** A visitor's email and the text held from members and viewers (owners and editors only, B4). */
  contact?: PlayContact;
  lookups: ProposalLookups;
  /** `/w/<slug>` or `/demo`. */
  base: string;
  /** Where the Editor's Exit and a saved solution go back to. */
  from: string;
  canEdit: boolean;
  busy: boolean;
  /** Dismiss the idea. A visitor's idea takes the editor's reply with it (kept as the review note); anything else gets null. */
  onDismiss: (reply: string | null) => void;
  /** The highest issue number with a page (the demo's new issues have none). */
  linkableUpTo?: number;
}) {
  const isPlay = p.created_via === "play_link";
  // Owners and editors read what the visitor wrote; members and viewers read the stand-ins the database stored (B4).
  const shown = withHeld(p, contact);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const view = describeProposal(shown, lookups);
  const idea = readIdea(p.payload);
  const block = ideaToBlock(p.payload);
  const issue = p.issue_id ? lookups.issues[p.issue_id] : undefined;
  const buildHref = buildIdeaHref(base, p, issue, from);
  const noMap = isPlay && !buildHref;
  const issueHref = view.issue?.number && view.issue.number <= linkableUpTo ? `${base}/issues/${view.issue.number}` : null;
  const replaced = idea.replaces.map((id) => lookups.steps[id] ?? "a step that has gone");
  const headingId = `idea-${p.id}`;
  return (
    <article aria-labelledby={headingId} data-proposal={p.id} data-kind="solution_idea" className="flex flex-col gap-2 rounded-lg border border-dashed border-edit/50 bg-panel p-3 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="inline-flex items-center rounded-full border border-line bg-panel-2 px-1.5 text-[11px] font-semibold" data-badge>
            {isPlay ? "Visitor's idea" : "AI idea"}
            {isPlay && <Help {...SUGGESTIONS_HELP.visitorIdea} />}
          </span>
          <span className="text-xs text-fg-2" data-from>
            {view.from}
          </span>
          {view.issue && (
            <span className="min-w-0 text-xs text-fg-2">
              for{" "}
              {issueHref ? (
                <Link href={issueHref} className="font-medium underline underline-offset-2">
                  #{view.issue.number} {view.issue.title}
                </Link>
              ) : (
                <span className="font-medium">
                  {view.issue.number ? `#${view.issue.number} ` : ""}
                  {view.issue.title}
                </span>
              )}
            </span>
          )}
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" type="button" disabled={busy || replying} onClick={() => (isPlay ? setReplying(true) : onDismiss(null))}>
              Dismiss
            </Button>
            {buildHref ? (
              <Button asChild size="sm" className="bg-edit text-edit-fg hover:bg-edit/90">
                <Link href={buildHref}>✎ Build it</Link>
              </Button>
            ) : (
              <span className="text-xs text-fg-3">{noMap ? "This idea isn't tied to a process, so there is no map to build on." : "This issue isn't linked to a process, so there is no map to build on."}</span>
            )}
          </div>
        )}
      </div>
      {replying && canEdit && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel-2 p-2" data-reply>
          <div className="flex items-center">
            <label htmlFor={`reply-${p.id}`} className="text-sm font-medium">
              Reply
            </label>
            <Help {...SUGGESTIONS_HELP.reply} />
          </div>
          <Textarea id={`reply-${p.id}`} value={reply} maxLength={2000} rows={2} onChange={(e) => setReply(e.target.value)} placeholder="Thanks Marta: we're hiring for this in January." data-reply-text />
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onDismiss(reply.trim() || null)} data-reply-dismiss>
              Dismiss
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setReplying(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <h4 id={headingId} className="font-semibold">
        {view.title}
      </h4>
      {shown.detail && <p className="text-sm whitespace-pre-line">{shown.detail}</p>}
      {canEdit && hasHeld(contact) && (
        <p className="flex items-center text-xs text-fg-2" data-held>
          Members and viewers see {heldSeen(contact)} here: the visitor&apos;s wording names someone, gives an email address or an amount.
          <Help {...SUGGESTIONS_HELP.held} />
        </p>
      )}
      {isPlay && canEdit && contact?.email && (
        <p className="text-xs text-fg-2" data-contact>
          Reply by email:{" "}
          <a href={`mailto:${contact.email.split("@").map(encodeURIComponent).join("@")}`} className="font-medium underline underline-offset-2">
            {contact.email}
          </a>
        </p>
      )}
      {isPlay ? (
        <div className="flex flex-col gap-1" data-idea-changes>
          <span className="flex items-center text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
            Changes
            <Help
              label="Lever changes"
              description="The levers the visitor moved. Build it puts them in a solution you can simulate; nothing changes until you save it."
              example="Strategist: 3 people; Leads per week: 12."
            />
          </span>
          <ul className="list-disc pl-5 text-sm">
            {view.changes.length ? view.changes.map((c, i) => <li key={i}>{c}</li>) : <li className="text-fg-3">No changes that can be shown.</li>}
          </ul>
          <p className="text-xs text-fg-3">{view.lines.at(-1)}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1" data-idea-map>
          <span className="flex items-center text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
            Proposed steps{replaced.length ? ` · would replace ${replaced.join(", ")}` : ""}
            <Help {...SUGGESTIONS_HELP.ideaMap} />
          </span>
          <BlockMap block={block} label={`Map of the proposed steps: ${idea.steps.map((s) => s.name).join(", then ")}`} />
        </div>
      )}
      {idea.expect && <p className="text-xs text-fg-2">{idea.expect} Not simulated yet.</p>}
      {p.note && (
        <p className="text-sm text-fg-2">
          <span className="font-medium">Reasoning:</span> {p.note}
        </p>
      )}
      <p className="text-xs text-fg-3">Suggested {when(p.created_at)}</p>
    </article>
  );
}

/** The (i) legend under a list of ideas: what Build it and Dismiss do. */
export function IdeaLegend() {
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-fg-2">
      <b className="font-medium text-fg">Build it</b>
      <Help {...SUGGESTIONS_HELP.buildIt} />
      <span>opens the Editor with the steps placed.</span>
      <b className="ml-1 font-medium text-fg">Dismiss</b>
      <Help {...SUGGESTIONS_HELP.dismiss} />
      <span>throws an idea away.</span>
    </p>
  );
}

interface IssueIdeasProps {
  issueId: string;
  base: string;
  from: string;
  canEdit: boolean;
  lookups: ProposalLookups;
  linkableUpTo?: number;
}

/**
 * "AI ideas" on the Issue page (workspace): the ideas waiting for this issue, loaded with the page, each with Build it and
 * Dismiss. Dismissing goes through the same Server Action as the Suggestions page.
 */
export function IssueIdeas({ initial, workspaceId, ...rest }: IssueIdeasProps & { initial: ProposalRow[]; workspaceId: string }) {
  const [proposals, setProposals] = useState(initial);
  return (
    <IdeasList
      {...rest}
      proposals={proposals}
      dismiss={async (id, reply) => {
        const outcome = await reviewProposals(workspaceId, [id], "reject", reply);
        if (outcome.status === "ok") setProposals(outcome.proposals);
        return outcome;
      }}
    />
  );
}

/** "AI ideas" on the demo's Issue page: the demo's ideas, shared with its Suggestions page. */
export function DemoIssueIdeas(props: Omit<IssueIdeasProps, "canEdit">) {
  const demo = useDemoCompany();
  return <IdeasList {...props} canEdit proposals={demo.proposals} dismiss={(id, reply) => demoProposalBackend.review([id], "reject", reply)} />;
}

function IdeasList({
  issueId,
  base,
  from,
  canEdit,
  lookups,
  linkableUpTo,
  proposals,
  dismiss,
}: IssueIdeasProps & { proposals: ProposalRow[]; dismiss: (id: string, reply: string | null) => Promise<ProposalOutcome> }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ideas = proposals.filter((p) => p.kind === "solution_idea" && p.issue_id === issueId && p.status === "pending");

  const onDismiss = (id: string, reply: string | null = null) => {
    setMessage(null);
    startTransition(async () => {
      const outcome = await dismiss(id, reply);
      setMessage(outcome.status === "error" ? outcome.message : proposalSummary(outcome.results, "reject"));
    });
  };

  const status = (
    <p role="status" aria-live="polite" className={message ? "rounded-lg border border-good bg-good-soft p-2 text-sm" : "sr-only"}>
      {message}
    </p>
  );
  if (!ideas.length) {
    return (
      <div className="flex flex-col gap-2">
        {status}
        <div className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground" data-empty="ideas">
          No AI ideas for this issue. When Claude or a visitor proposes one, it waits here and in{" "}
          <Link href={`${base}/suggestions`} className="underline underline-offset-2">
            Suggestions
          </Link>
          .
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-ideas-list>
      {status}
      {ideas.map((p) => (
        <IdeaCard key={p.id} p={p} lookups={lookups} base={base} from={from} canEdit={canEdit} busy={pending} onDismiss={(reply) => onDismiss(p.id, reply)} linkableUpTo={linkableUpTo} />
      ))}
      {canEdit && <IdeaLegend />}
    </div>
  );
}
