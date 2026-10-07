"use client";

import Link from "next/link";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import type { PlayContact, ProposalRow } from "@transpera-flow/db";
import { reviewProposals } from "@/app/w/[slug]/suggestion-actions";
import { Help } from "@/components/help";
import { IdeaCard, IdeaLegend } from "@/components/idea-card";
import { Button } from "@/components/ui/button";
import { demoProposalBackend, useDemoCompany } from "@/lib/demo/company-store";
import {
  describeProposal,
  proposalSummary,
  SUGGESTIONS_HELP,
  type ProposalDecision,
  type ProposalLookups,
  type ProposalOutcome,
} from "@/lib/suggestions/proposals";
import { EDIT_ONLY } from "@/lib/phone";

// The proposals half of the Suggestions page (A52, docs/PRD.md §7.1c, §8 screen 8): solution ideas (a map of the proposed
// steps, Build it and Dismiss) and proposed issues (accept adds the issue through the Acknowledge path, reject drops
// it). The company-model changes are the existing list, passed in as `children` so both halves sit in one layout.

interface ViewProps {
  proposals: ProposalRow[];
  lookups: ProposalLookups;
  /** A visitor's email and the text held from members and viewers, by proposal id (owners and editors only; B4). */
  contacts?: Record<string, PlayContact>;
  canEdit: boolean;
  review: (ids: string[], decision: ProposalDecision, note: string | null) => Promise<ProposalOutcome>;
  /** Where the workspace's pages live: `/w/<slug>` or `/demo`. An issue's page is `<base>/issues/<number>`; Build it opens `<base>`'s Editor. */
  base: string;
  /** The highest issue number that has a page. The demo's new issues stay in the tab, so past the sample ones there is none. */
  linkableUpTo?: number;
  children?: ReactNode;
}

/** On a workspace: reviews go through a Server Action as the signed-in user. */
export function LiveProposals({ workspaceId, initial, ...rest }: Omit<ViewProps, "proposals" | "review"> & { workspaceId: string; initial: ProposalRow[] }) {
  const [proposals, setProposals] = useState(initial);
  const review = async (ids: string[], decision: ProposalDecision, note: string | null) => {
    const outcome = await reviewProposals(workspaceId, ids, decision, note);
    if (outcome.status === "ok") setProposals(outcome.proposals);
    return outcome;
  };
  return <ProposalsView {...rest} proposals={proposals} review={review} />;
}

/** On the demo: reviews apply in memory, shared with the rest of the demo's Suggestions page. */
export function DemoProposals(props: Omit<ViewProps, "proposals" | "review" | "canEdit">) {
  const demo = useDemoCompany();
  return <ProposalsView {...props} canEdit proposals={demo.proposals} review={(...a) => demoProposalBackend.review(...a)} />;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

function SectionHead({ id, title, help, children }: { id: string; title: string; help: (typeof SUGGESTIONS_HELP)[keyof typeof SUGGESTIONS_HELP]; children: ReactNode }) {
  return (
    <div className="mb-2 flex flex-col gap-0.5">
      <h2 id={id} className="flex items-center font-heading text-base font-semibold">
        {title}
        <Help {...help} />
      </h2>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

export function ProposalsView({ proposals, lookups, contacts = {}, canEdit, review, base, linkableUpTo = Infinity, children }: ViewProps) {
  const issueHref = (n: number) => (n <= linkableUpTo ? `${base}/issues/${n}` : null);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "error"; href?: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const waiting = useMemo(() => proposals.filter((p) => p.status === "pending"), [proposals]);
  const ideas = waiting.filter((p) => p.kind === "solution_idea");
  const issues = waiting.filter((p) => p.kind === "issue");

  const run = (id: string, decision: ProposalDecision, note: string | null = null) => {
    setMessage(null);
    setBusyId(id);
    startTransition(async () => {
      const outcome = await review([id], decision, note);
      setBusyId(null);
      if (outcome.status === "error") {
        setMessage({ text: outcome.message, tone: "error" });
        return;
      }
      const number = outcome.results[0]?.applied?.number;
      setMessage({
        text: proposalSummary(outcome.results, decision),
        tone: outcome.results.some((r) => r.status === "failed") ? "error" : "ok",
        href: number ? (issueHref(number) ?? undefined) : undefined,
      });
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <p
        role="status"
        aria-live="polite"
        className={message ? `rounded-lg border p-2 text-sm ${message.tone === "error" ? "border-crit bg-crit-soft" : "border-good bg-good-soft"}` : "sr-only"}
      >
        {message?.text}{" "}
        {message?.href && (
          <Link href={message.href} className="font-medium underline underline-offset-2">
            View the issue
          </Link>
        )}
      </p>

      <section aria-labelledby="ideas-heading" data-section="ideas">
        <SectionHead id="ideas-heading" title="Solution ideas" help={SUGGESTIONS_HELP.ideas}>
          Not built and not simulated. Build one to open the Editor with the AI&apos;s steps already placed; saving it turns it into a real solution.
        </SectionHead>
        {ideas.length ? (
          <ul className="flex flex-col gap-3">
            {ideas.map((p) => (
              <li key={p.id}>
                <IdeaCard p={p} lookups={lookups} contact={contacts[p.id]} base={base} from={`${base}/suggestions`} canEdit={canEdit} busy={pending} onDismiss={(reply) => run(p.id, "reject", reply)} linkableUpTo={linkableUpTo} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-line p-4 text-fg-2">No ideas waiting.</p>
        )}
        {ideas.length > 0 && canEdit && <IdeaLegend />}
      </section>

      <section aria-labelledby="other-heading" data-section="other">
        <SectionHead id="other-heading" title="Other suggestions" help={SUGGESTIONS_HELP.other}>
          Proposed issues and changes to the company model.
        </SectionHead>

        <h3 className="mb-1 flex items-center text-sm font-semibold">
          Proposed issues
          <Help {...SUGGESTIONS_HELP.issues} />
        </h3>
        {issues.length ? (
          <>
            <ul className="flex flex-col gap-3">
              {issues.map((p) => (
                <li key={p.id}>
                  <ProposalCard p={p} lookups={lookups} issueHref={issueHref}>
                    {canEdit && (
                      <>
                        <Button type="button" className={EDIT_ONLY} data-edit-entry disabled={pending} onClick={() => run(p.id, "accept")} aria-busy={busyId === p.id}>
                          Accept
                        </Button>
                        <Button variant="outline" size="sm" type="button" className={EDIT_ONLY} data-edit-entry disabled={pending} onClick={() => run(p.id, "reject")}>
                          Reject
                        </Button>
                      </>
                    )}
                  </ProposalCard>
                </li>
              ))}
            </ul>
            {canEdit && (
              <p className={`mt-2 flex flex-wrap items-center gap-x-1 text-xs text-fg-2 ${EDIT_ONLY}`} data-edit-entry>
                <b className="font-medium text-fg">Accept</b>
                <Help {...SUGGESTIONS_HELP.accept} />
                <span>adds it to your issues.</span>
                <b className="ml-1 font-medium text-fg">Reject</b>
                <Help {...SUGGESTIONS_HELP.reject} />
                <span>drops it.</span>
              </p>
            )}
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-line p-4 text-fg-2">No proposed issues waiting.</p>
        )}
        {!canEdit && waiting.length > 0 && <p className="mt-2 text-xs text-fg-3">You can view suggestions; editors and owners review them.</p>}

        <h3 className="mt-6 mb-2 flex items-center text-sm font-semibold">
          Changes to the company model
          <Help {...SUGGESTIONS_HELP.model} />
        </h3>
        {children}
      </section>
    </div>
  );
}

function ProposalCard({ p, lookups, issueHref, children }: { p: ProposalRow; lookups: ProposalLookups; issueHref: (n: number) => string | null; children: ReactNode }) {
  const view = describeProposal(p, lookups);
  const headingId = `proposal-${p.id}`;
  const href = view.issue?.number ? issueHref(view.issue.number) : null;
  return (
    <article aria-labelledby={headingId} data-proposal={p.id} data-kind={p.kind} className="rounded-lg border border-line bg-panel p-3 shadow-xs">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="rounded-full border border-line bg-panel-2 px-1.5 text-[11px] font-semibold">{view.kind === "Issue" ? "Issue" : "AI idea"}</span>
        <span className="text-xs text-fg-2">{view.from}</span>
        {view.issue && (
          <span className="min-w-0 text-xs text-fg-2">
            for{" "}
            {href ? (
              <Link href={href} className="font-medium underline underline-offset-2">
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
        <span className="ml-auto text-xs text-fg-3">Suggested {when(p.created_at)}</span>
      </div>
      <h4 id={headingId} className="mt-1 font-semibold">
        {view.title}
      </h4>
      {view.lines.map((l, i) => (
        <p key={i} className={i === 0 ? "mt-0.5 text-sm" : "mt-0.5 text-sm text-fg-2"}>
          {l}
        </p>
      ))}
      {p.note && (
        <p className="mt-2 text-sm text-fg-2">
          <span className="font-medium">Reasoning:</span> {p.note}
        </p>
      )}
      {p.evidence.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {p.evidence.map((e, i) => (
            <li key={i} className="rounded-lg bg-panel-2 px-2 py-1.5 text-xs">
              <q>{e.quote}</q>
              {e.speaker && <span className="text-fg-2"> — {e.speaker}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">{children}</div>
    </article>
  );
}
