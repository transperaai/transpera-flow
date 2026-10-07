"use client";

import { useMemo, useState, useTransition } from "react";
import { describeSuggestion, type CompanyModel, type SuggestionRow, type SuggestionStatus } from "@transpera-flow/db";
import { reviewSuggestions } from "@/app/w/[slug]/suggestion-actions";
import { demoSuggestionBackend, useDemoCompany } from "@/lib/demo/company-store";
import { describeAuditEntry, type AuditEntry } from "@/lib/suggestions/audit";
import { reviewSummary, type ReviewDecision, type ReviewOutcome } from "@/lib/suggestions/review";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { SUGGESTIONS_HELP } from "@/lib/suggestions/proposals";
import { Input } from "@/components/ui/input";
import { EDIT_ONLY } from "@/lib/phone";

// The Suggestions page (docs/PRD.md §8 screen 8, §7.1c; issue #25): company-
// model changes Claude suggested over MCP, to accept or reject one by one or
// in bulk. Nothing changes until someone accepts; accepted values carry the
// cited evidence as their provenance.

type Filter = SuggestionStatus | "all";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

const STATUS_CLASS: Record<SuggestionStatus, string> = {
  pending: "border-warn bg-warn-soft",
  accepted: "border-good bg-good-soft",
  rejected: "border-line bg-panel-2",
};

const STATUS_LABEL: Record<SuggestionStatus, string> = { pending: "Pending", accepted: "Accepted", rejected: "Rejected" };

interface ViewProps {
  suggestions: SuggestionRow[];
  model: CompanyModel;
  sources: Record<string, string>;
  canEdit: boolean;
  review: (ids: string[], decision: ReviewDecision, note: string | null) => Promise<ReviewOutcome>;
  sourcesHref?: string;
}

/** On a workspace: reviews go through Server Actions as the signed-in user. */
export function LiveSuggestions({
  workspaceId,
  initial,
  model: initialModel,
  ...rest
}: Omit<ViewProps, "suggestions" | "review"> & { workspaceId: string; initial: SuggestionRow[] }) {
  const [state, setState] = useState({ suggestions: initial, model: initialModel });
  const review = async (ids: string[], decision: ReviewDecision, note: string | null) => {
    const outcome = await reviewSuggestions(workspaceId, ids, decision, note);
    if (outcome.status === "ok") setState({ suggestions: outcome.suggestions, model: outcome.model });
    return outcome;
  };
  return <SuggestionsView {...rest} suggestions={state.suggestions} model={state.model} review={review} />;
}

/** On the demo: reviews apply to the in-memory model shared with the demo's other pages. */
export function DemoSuggestions(props: Omit<ViewProps, "suggestions" | "model" | "review" | "canEdit">) {
  const demo = useDemoCompany();
  return <SuggestionsView {...props} canEdit suggestions={demo.suggestions} model={demo.model} review={(...a) => demoSuggestionBackend.review(...a)} />;
}

export function SuggestionsView({ suggestions, model, sources, canEdit, review, sourcesHref }: ViewProps) {
  const [filter, setFilter] = useState<Filter>("pending");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [rejecting, setRejecting] = useState<string[] | null>(null);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const counts = useMemo(() => {
    const c = { pending: 0, accepted: 0, rejected: 0, all: suggestions.length };
    for (const s of suggestions) c[s.status]++;
    return c;
  }, [suggestions]);
  const shown = suggestions.filter((s) => filter === "all" || s.status === filter);
  const selectable = shown.filter((s) => s.status === "pending").map((s) => s.id);
  const chosen = selectable.filter((id) => selected.has(id));

  const run = (ids: string[], decision: ReviewDecision, note: string | null) => {
    setMessage(null);
    startTransition(async () => {
      const outcome = await review(ids, decision, note);
      if (outcome.status === "error") {
        setMessage({ text: outcome.message, tone: "error" });
        return;
      }
      setMessage({ text: reviewSummary(outcome.results, decision), tone: outcome.results.some((r) => r.status === "failed") ? "error" : "ok" });
      setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      setRejecting(null);
      setReason("");
    });
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        <div role="tablist" aria-label="Which suggestions" className="flex flex-wrap gap-1">
          {(["pending", "accepted", "rejected", "all"] as const).map((f) => (
            <Button
              key={f}
              type="button"
              role="tab"
              data-allow-on-phone /* a filter (Accepted, Rejected), not an edit */
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              variant={filter === f ? "secondary" : "ghost"}
              className={filter === f ? "ring-1 ring-border" : undefined}
            >
              {f === "all" ? "All" : STATUS_LABEL[f]} <span className="tabular-nums text-muted-foreground">{counts[f]}</span>
            </Button>
          ))}
        </div>
        <span className="contents" data-allow-on-phone>
          <Help {...SUGGESTIONS_HELP.show} />
        </span>
      </div>

      {canEdit && selectable.length > 0 && (
        <div className={`flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-2 shadow-xs ${EDIT_ONLY}`} data-edit-entry>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={chosen.length === selectable.length}
              ref={(el) => {
                if (el) el.indeterminate = chosen.length > 0 && chosen.length < selectable.length;
              }}
              onChange={(e) => setSelected(e.target.checked ? new Set(selectable) : new Set())}
            />
            {chosen.length ? `${chosen.length} selected` : "Select all"}
          </label>
          <Help {...SUGGESTIONS_HELP.bulk} />
          <span className="grow" />
          <Button
            type="button"
            disabled={!chosen.length || pending}
            onClick={() => run(chosen, "accept", null)}
          >
            Accept selected
          </Button>
          <Button variant="outline" size="sm"
            type="button"
            disabled={!chosen.length || pending}
            onClick={() => setRejecting(chosen)}
          >
            Reject selected
          </Button>
        </div>
      )}

      {rejecting && (
        <form
          className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-panel-2 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(rejecting, "reject", reason);
          }}
        >
          <label className="flex grow flex-col gap-1">
            <span className="text-xs font-medium text-fg-2">
              Why reject {rejecting.length === 1 ? "this suggestion" : `these ${rejecting.length} suggestions`}? (optional)
            </span>
            <Input autoFocus value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button type="submit" disabled={pending}>
            Reject
          </Button>
          <Button type="button" variant="ghost" onClick={() => setRejecting(null)}>
            Cancel
          </Button>
        </form>
      )}

      <p role="status" aria-live="polite" className={message ? `rounded-lg border p-2 ${message.tone === "error" ? "border-crit bg-crit-soft" : "border-good bg-good-soft"}` : "sr-only"}>
        {message?.text}
      </p>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-4 text-fg-2">
          {filter === "pending"
            ? "Nothing waiting for review. When Claude changes people, clients, services, roles, demand or company settings over MCP, its suggestions appear here."
            : "None."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((s) => (
            <SuggestionCard
              key={s.id}
              s={s}
              model={model}
              sources={sources}
              sourcesHref={sourcesHref}
              canEdit={canEdit}
              busy={pending}
              selected={selected.has(s.id)}
              onToggle={() => toggle(s.id)}
              onAccept={() => run([s.id], "accept", null)}
              onReject={() => setRejecting([s.id])}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SuggestionCard({
  s,
  model,
  sources,
  sourcesHref,
  canEdit,
  busy,
  selected,
  onToggle,
  onAccept,
  onReject,
}: {
  s: SuggestionRow;
  model: CompanyModel;
  sources: Record<string, string>;
  sourcesHref?: string;
  canEdit: boolean;
  busy: boolean;
  selected: boolean;
  onToggle: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const view = describeSuggestion(s, model, s.created_via === "upload" ? `Upload (${s.import_source ?? "a file"})` : "Claude");
  const open = s.status === "pending";
  const headingId = `suggestion-${s.id}`;
  return (
    <li aria-labelledby={headingId} data-suggestion={s.id} data-status={s.status} className="rounded-lg border border-line bg-panel p-3 shadow-xs">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {open && canEdit && (
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select: ${view.headline}`} data-edit-entry className={`self-center ${EDIT_ONLY}`} />
        )}
        <span className="font-mono text-[11px] uppercase tracking-widest text-fg-3">{view.subject}</span>
        <span className={`rounded-full border px-1.5 text-[11px] font-semibold ${STATUS_CLASS[s.status]}`}>{STATUS_LABEL[s.status]}</span>
        <span className="ml-auto text-xs text-fg-3">Suggested {when(s.created_at)}</span>
      </div>
      <p id={headingId} className="mt-1 font-semibold">
        {view.headline}
      </p>

      {view.missing && (
        <p className="mt-2 rounded-lg border border-crit bg-crit-soft p-2 text-xs">What this changes no longer exists, so it can only be rejected.</p>
      )}

      <table className="mt-2 w-full table-fixed text-left text-sm">
        <thead className="text-xs text-fg-3">
          <tr>
            <th className="w-2/5 py-0.5 pr-3 font-medium">Field</th>
            {view.action === "update" && <th className="w-1/4 py-0.5 pr-3 font-medium">{s.status === "accepted" ? "Was" : "Now"}</th>}
            <th className="py-0.5 font-medium">{s.status === "accepted" ? "Set to" : "Suggested"}</th>
          </tr>
        </thead>
        <tbody>
          {view.changes.map((c) => (
            <tr key={c.field} className="border-t border-line align-top">
              <td className="py-1 pr-3 text-fg-2">{c.label}</td>
              {view.action === "update" && <td className="py-1 pr-3 tabular-nums text-fg-2">{c.before ?? "–"}</td>}
              <td className="py-1 tabular-nums">
                <span className={c.unchanged ? "text-fg-3" : "font-semibold"}>{c.after}</span>
                {c.unchanged && <span className="ml-1 text-xs text-fg-3">(already)</span>}
                {c.overridesFact && (
                  <span className="ml-2 rounded-full border border-warn bg-warn-soft px-1.5 text-[11px] text-fg-2" title="Accepting replaces a value someone entered or measured.">
                    Replaces an entered value
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {s.note && (
        <p className="mt-2 text-sm text-fg-2">
          <span className="font-medium">Reasoning:</span> {s.note}
        </p>
      )}
      {s.evidence.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {s.evidence.map((e, i) => (
            <li key={i} className="rounded-lg bg-panel-2 px-2 py-1.5 text-xs">
              <q>{e.quote}</q>
              <span className="text-fg-2">
                {e.speaker ? ` — ${e.speaker}` : ""}
                {", "}
                {sources[e.source_id] ? (
                  sourcesHref ? (
                    <a href={sourcesHref} className="underline">
                      {sources[e.source_id]}
                    </a>
                  ) : (
                    sources[e.source_id]
                  )
                ) : (
                  "a deleted source"
                )}
                {e.timestamp ? ` at ${e.timestamp}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        open && <p className="mt-2 text-xs text-fg-3">No source cited: accepted values are recorded as assumptions to confirm.</p>
      )}

      {open ? (
        canEdit && (
          <div className={`mt-3 flex gap-2 ${EDIT_ONLY}`} data-edit-entry>
            <Button type="button" disabled={busy} onClick={onAccept}>
              Accept
            </Button>
            <Button variant="outline" size="sm" type="button" disabled={busy} onClick={onReject}>
              Reject
            </Button>
          </div>
        )
      ) : (
        <p className="mt-2 text-xs text-fg-2">
          {STATUS_LABEL[s.status]}
          {s.reviewed_at ? ` ${when(s.reviewed_at)}` : ""}
          {s.review_note ? `: “${s.review_note}”` : ""}
          {s.status === "accepted" ? ". The values it set are marked estimated, with this evidence." : ""}
        </p>
      )}
    </li>
  );
}

/** Recent company-model writes from the audit log (owners and agency admins). */
export function ChangeLog({ entries, model, people }: { entries: AuditEntry[]; model: CompanyModel; people: Record<string, string> }) {
  return (
    <section aria-labelledby="changes-heading" className="mt-8">
      <h2 id="changes-heading" className="mb-1 text-base font-bold">
        Recent changes to the company model
      </h2>
      <p className="mb-2 text-fg-2">
        Every change to settings, services, people, clients and demand, whether someone made it in the app or accepted a suggestion. Only owners see
        this log.
      </p>
      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-4 text-fg-2">No changes yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-panel shadow-xs">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-3 px-3 py-1.5 text-sm">
              <span className="w-36 shrink-0 text-xs text-fg-3 tabular-nums">{when(e.created_at)}</span>
              <span className="w-48 shrink-0 truncate text-xs text-fg-2">
                {e.actor_kind === "mcp" ? `Claude (API token of ${people[e.actor_id ?? ""] ?? "a user"})` : (people[e.actor_id ?? ""] ?? "Someone")}
                {e.diff.suggestion_id ? " · accepted suggestion" : ""}
              </span>
              <span className="min-w-0 grow">{describeAuditEntry(e, model)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
