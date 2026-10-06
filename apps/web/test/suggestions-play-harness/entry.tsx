// A visitor's idea on the Suggestions page (issue #33, B4), on a bare page for ../suggestions-play-browser.test.ts: the real
// ProposalsView with one pending play-link idea, as an owner or editor reads it (the email, Build it, Dismiss with a reply, and the
// wording a visitor wrote that members and viewers read as a stand-in) and as a member or viewer reads it (none of those). Bundled by
// esbuild and driven through `window.mountPlayIdea`; nothing here ships.

import { createRoot } from "react-dom/client";
import type { PlayContact, ProposalRow } from "@transpera-flow/db";
import { ProposalsView } from "@/components/proposals-review";
import type { ProposalDecision, ProposalOutcome } from "@/lib/suggestions/proposals";

declare global {
  interface Window {
    /** `editor`: owners and editors (contacts, Build it, Dismiss). `held`: the visitor's wording named someone, so members read stand-ins. `issue`: the idea names an issue. */
    mountPlayIdea: (options: { editor: boolean; held?: boolean; issue?: boolean }) => void;
    /** What the card asked to do: (ids, decision, note). */
    playReviews: [string[], ProposalDecision, string | null][];
  }
}

const WS = "00000000-0000-4000-8000-0000000000a1";
const PROCESS = "00000000-0000-4000-8000-0000000000c1";
const IDEA = "00000000-0000-4000-8000-0000000000f1";
const ISSUE = "00000000-0000-4000-8000-0000000000e1";
const STEP = "00000000-0000-4000-8000-0000000000b1";
const ROLE = "00000000-0000-4000-8000-0000000000d1";

window.playReviews = [];

window.mountPlayIdea = ({ editor, held = false, issue = false }) => {
  // What the database stores, and so what a member reads: a held field is its stand-in.
  const stored: ProposalRow = {
    id: IDEA,
    workspace_id: WS,
    kind: "solution_idea",
    title: held ? "A visitor's idea" : "One more strategist",
    detail: held ? null : "With 3 strategists, leads wait under a day.",
    payload: {
      steps: [],
      edges: [],
      replaces_step_ids: [],
      levers: [
        { path: "demand.leads_per_week", op: "set", value: 12 },
        { path: `roles.${ROLE}.headcount`, op: "set", value: 3 },
        { path: `steps.${STEP}.work_hours`, op: "multiply", value: 0.8 },
      ],
      process_id: PROCESS,
      base_revision_id: "00000000-0000-4000-8000-0000000000d2",
    },
    evidence: [],
    note: null,
    issue_id: issue ? ISSUE : null,
    status: "pending",
    created_via: "play_link",
    import_source: null,
    proposer_name: held ? "A visitor" : "Marta Okoye",
    share_link_id: "00000000-0000-4000-8000-0000000000aa",
    applied: null,
    review_note: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: "2026-10-06T09:00:00.000Z",
    created_by: null,
  };
  const contacts: Record<string, PlayContact> = editor
    ? { [IDEA]: { email: "marta+play@example.com", held: held ? { title: "Ask Priya Shah's team", note: "Priya Shah says it costs £4,100", name: "Marta Okoye" } : {} } }
    : {};
  const review = async (ids: string[], decision: ProposalDecision, note: string | null): Promise<ProposalOutcome> => {
    window.playReviews.push([ids, decision, note]);
    return { status: "ok", results: ids.map((id) => ({ id, status: "dismissed" as const })), proposals: [] };
  };
  createRoot(document.getElementById("root")!).render(
    <ProposalsView
      proposals={[stored]}
      lookups={{
        processes: { [PROCESS]: "Lead to live" },
        steps: { [STEP]: "Check fit" },
        issues: issue ? { [ISSUE]: { number: 4, title: "Leads wait too long", processId: PROCESS } } : {},
        roles: { [ROLE]: "Strategist" },
        services: {},
        currency: "GBP",
      }}
      contacts={contacts}
      canEdit={editor}
      review={review}
      base="/w/northbeam"
    />,
  );
};
