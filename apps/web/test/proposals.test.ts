import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID, northbeamIssues, northbeamStepIds, type ProposalRow } from "@transpera-flow/db";
import { MemoryIssueStore } from "@/lib/issues/store";
import { demoProposals, demoSuggestions } from "@/lib/suggestions/demo";
import { describeProposal, proposalSummary, reviewProposalsInMemory, SUGGESTIONS_HELP, type ProposalLookups } from "@/lib/suggestions/proposals";

// Proposed issues and solution ideas on the Suggestions page (issue #117, A52 slice 1): how they read, reviewing them in
// memory as the database does (accept creates the issue through the issue store's save, reject drops it, an idea is only
// dismissed), the demo's samples and the (i) help on the screen.

const at = "2026-10-02T09:00:00.000Z";
const lookups: ProposalLookups = {
  processes: { p1: "Lead to Cash" },
  steps: { [northbeamStepIds.discovery]: "Discovery call", [northbeamStepIds.qualify]: "Qualify lead" },
  issues: Object.fromEntries(northbeamIssues().map((i) => [i.id, { number: i.number, title: i.title }])),
};
const [issueProposal, ideaProposal] = [demoProposals().find((p) => p.kind === "issue")!, demoProposals().find((p) => p.kind === "solution_idea")!];
const store = () => new MemoryIssueStore(NORTHBEAM_WORKSPACE_ID, northbeamIssues());
const opts = () => ({ at, by: "you", issues: store() });

describe("how a proposal reads", () => {
  it("a proposed issue: its rating, what it touches, its target and where it came from", () => {
    const v = describeProposal(issueProposal, lookups);
    expect(v).toMatchObject({ kind: "Issue", from: "Claude (MCP)", title: "Leads wait a day for a discovery call", issue: null });
    expect(v.lines[0]).toBe("Proposed rating: Good, could improve. Touches Discovery call.");
    expect(v.lines[1]).toBe("Target: Wait before Discovery call, now 24 h, goal under 8 h.");
  });

  it("says when an issue touches a whole process, or nothing yet", () => {
    const whole = { ...issueProposal, payload: { severity: "nonsense" as never, links: [{ process_id: "p1", step_id: null }] } } as ProposalRow;
    expect(describeProposal(whole, lookups).lines[0]).toBe("Proposed rating: Good, could improve. Touches the whole of Lead to Cash.");
    const bare = { ...issueProposal, payload: {} } as ProposalRow;
    expect(describeProposal(bare, lookups).lines[0]).toBe("Proposed rating: Good, could improve. Touches nothing in particular yet.");
    expect(describeProposal({ ...issueProposal, payload: { severity: "critical" } } as ProposalRow, lookups).lines[0]).toMatch(/Operational risk/);
  });

  it("a solution idea: the issue it is for, its steps in order, what it would replace and what is expected", () => {
    const v = describeProposal(ideaProposal, lookups);
    const [, , scoring] = northbeamIssues();
    expect(v).toMatchObject({ kind: "Solution idea", issue: { id: scoring!.id, number: scoring!.number, title: scoring!.title } });
    expect(v.lines).toEqual([
      "Partner leads convert twice as well as website leads. Let them skip the fit check and go straight to booking a call.",
      "Proposed steps: Partner lead arrives → Book discovery call → Quick check by AI. Would replace Qualify lead.",
      "AI expects first contact for partner leads under 2 h. Not simulated yet.",
    ]);
  });

  it("marks a visitor's proposal with their name (B4's play links)", () => {
    const visitor = { ...ideaProposal, created_via: "play_link" as const, proposer_name: "Jo from Acme" };
    expect(describeProposal(visitor, lookups).from).toBe("Jo from Acme (play link)");
    expect(describeProposal({ ...visitor, proposer_name: null }, lookups).from).toBe("A visitor (play link)");
  });

  it("names a step or issue that has since gone, instead of failing", () => {
    const v = describeProposal({ ...ideaProposal, payload: { ...ideaProposal.payload, replaces_step_ids: ["gone"] } } as ProposalRow, { ...lookups, issues: {} });
    expect(v.lines[1]).toContain("Would replace a step that has gone");
    expect(v.issue).toMatchObject({ number: null, title: "an issue that has gone" });
  });
});

describe("reviewing in memory", () => {
  it("accepting a proposed issue creates it through the issue store: numbered after the sample issues, with its links and target", async () => {
    const o = opts();
    const r = await reviewProposalsInMemory(demoProposals(), [issueProposal.id], "accept", null, o);
    const next = northbeamIssues().length + 1;
    expect(r.results).toEqual([{ id: issueProposal.id, status: "accepted", applied: { issue_id: expect.any(String), number: next } }]);
    expect(r.proposals.find((p) => p.id === issueProposal.id)).toMatchObject({ status: "accepted", reviewed_by: "you", reviewed_at: at, applied: { number: next } });
    const created = (await o.issues.events(r.results[0]!.applied!.issue_id!)).map((e) => e.kind);
    expect(created).toEqual(["created"]);
    expect(proposalSummary(r.results, "accept")).toBe(`Accepted. Now issue #${next}.`);
  });

  it("rejecting a proposed issue records the decision and creates no issue", async () => {
    const o = opts();
    const r = await reviewProposalsInMemory(demoProposals(), [issueProposal.id], "reject", "Already known", o);
    expect(r.results).toEqual([{ id: issueProposal.id, status: "rejected" }]);
    expect(r.proposals.find((p) => p.id === issueProposal.id)).toMatchObject({ status: "rejected", review_note: "Already known", applied: null });
    expect(proposalSummary(r.results, "reject")).toBe("Rejected.");
  });

  it("a solution idea is dismissed, and can't be accepted (building it is slice 2)", async () => {
    const dismissed = await reviewProposalsInMemory(demoProposals(), [ideaProposal.id], "reject", null, opts());
    expect(dismissed.results).toEqual([{ id: ideaProposal.id, status: "dismissed" }]);
    expect(proposalSummary(dismissed.results, "reject")).toBe("Dismissed.");
    const accepted = await reviewProposalsInMemory(demoProposals(), [ideaProposal.id], "accept", null, opts());
    expect(accepted.results[0]).toMatchObject({ status: "failed", message: expect.stringMatching(/built in the Editor/) });
    expect(accepted.proposals.find((p) => p.id === ideaProposal.id)!.status).toBe("pending");
    expect(proposalSummary(accepted.results, "accept")).toMatch(/1 couldn't be accepted and is still waiting/);
  });

  it("handles each on its own, and doesn't review one twice", async () => {
    const o = opts();
    const first = await reviewProposalsInMemory(demoProposals(), [issueProposal.id, ideaProposal.id, "nope"], "accept", null, o);
    expect(first.results.map((r) => r.status)).toEqual(["accepted", "failed", "not_found"]);
    const again = await reviewProposalsInMemory(first.proposals, [issueProposal.id], "accept", null, o);
    expect(again.results).toEqual([{ id: issueProposal.id, status: "already_reviewed" }]);
    expect(proposalSummary([...first.results, ...again.results], "accept")).toContain("1 had already been dealt with.");
  });
});

describe("the demo's samples", () => {
  it("has one proposed issue and one idea for a real sample issue, both pending and from the MCP server", () => {
    const all = demoProposals();
    expect(all.map((p) => p.kind).sort()).toEqual(["issue", "solution_idea"]);
    expect(all.every((p) => p.status === "pending" && p.created_via === "mcp")).toBe(true);
    expect(northbeamIssues().map((i) => i.id)).toContain(ideaProposal.issue_id);
    // The sidebar counts company changes and proposals together.
    expect([...demoSuggestions(), ...all].filter((s) => s.status === "pending").length).toBe(demoSuggestions().filter((s) => s.status === "pending").length + 2);
  });
});

describe("the (i) help on the Suggestions screen (issue #117)", () => {
  const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const screen = read("components/proposals-review.tsx") + read("components/suggestions-review.tsx") + read("components/idea-card.tsx");

  it("has a label, a description and an example for each part", () => {
    expect(Object.keys(SUGGESTIONS_HELP).sort()).toEqual(["accept", "buildIt", "bulk", "dismiss", "held", "ideaMap", "ideas", "issues", "model", "other", "reject", "reply", "show", "visitorIdea"]);
    for (const [key, h] of Object.entries(SUGGESTIONS_HELP)) {
      expect(h.label.length, key).toBeGreaterThan(2);
      expect(h.description.length, `${key} description`).toBeGreaterThan(30);
      expect(h.example.length, `${key} example`).toBeGreaterThan(10);
    }
  });

  it("shows each one on the screen, so removing one is caught", () => {
    for (const key of Object.keys(SUGGESTIONS_HELP)) expect(screen, key).toContain(`SUGGESTIONS_HELP.${key}`);
  });

  it("keeps to plain English: no jargon in the labels, descriptions or examples", () => {
    for (const h of Object.values(SUGGESTIONS_HELP)) {
      expect(`${h.label} ${h.description} ${h.example}`).not.toMatch(/\b(RLS|jsonb|payload|enum|schema|MCP|API|patch|provenance)\b/i);
    }
  });

  it("has a button for each thing the (i)s describe", () => {
    for (const word of ["Accept", "Reject", "Dismiss", "Solution ideas", "Other suggestions", "Proposed issues"]) expect(screen).toContain(word);
  });
});
