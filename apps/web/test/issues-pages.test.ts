import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { noCost, type DetectedIssue } from "@transpera-flow/engine";
import { northbeamIssues, type IssueRow } from "@transpera-flow/db";
import { ISSUE_PAGE_HELP, LIST_HELP, RESOLVE_HELP } from "@/lib/issues/help";
import {
  ALL_STATUSES_STATE,
  DEFAULT_LIST_STATE,
  UNASSIGNED,
  facetCounts,
  filtersOn,
  findIssue,
  historyLines,
  insightRuleOf,
  issueHref,
  listIssues,
  listQuery,
  loggedLine,
  parseListState,
  type ListState,
  resolvedBar,
} from "@/lib/issues/pages";
import { mapFeed, registerEntries } from "@/lib/issues/register";
import { MemoryIssueStore } from "@/lib/issues/store";
import { parseResolveInput } from "@/lib/issues/validate";
import { NO_SOLUTIONS_DATA, solutionSummaries } from "@/lib/solutions/cards";

// The Issues pages (issue #113, A48): the list's filters and URL, the sort, resolving and reopening (with the map badges
// and the history), the resolved bar, and the (i) on every control.

const WS = "00000000-0000-4000-8000-0000000000aa";
const now = new Date("2026-10-10T12:00:00Z");
const issueOf = (n: number, extra: Partial<IssueRow> = {}): IssueRow => ({ ...northbeamIssues()[0]!, id: `00000000-0000-4000-8000-00000000000${n}`, number: n, ...extra });
const store = (rows: IssueRow[] = northbeamIssues(), t = "2026-10-05T09:00:00Z") => {
  let tick = 0;
  return new MemoryIssueStore(WS, rows, () => new Date(Date.parse(t) + ++tick * 60_000).toISOString());
};
const ok = async (p: Promise<{ status: "ok"; issue: IssueRow } | { status: "error"; message: string }>) => {
  const r = await p;
  if (r.status !== "ok") throw new Error(r.message);
  return r.issue;
};
const all = (s: MemoryIssueStore) => s.visible();

const st = (extra: Partial<ListState> = {}): ListState => ({ ...DEFAULT_LIST_STATE, ...extra });
const RESOLVED: ListState["status"] = ["resolved", "wont_fix"];

describe("filters and the URL", () => {
  it("reads statuses, ratings, owners, processes and a search, and ignores anything else", () => {
    expect(parseListState({})).toEqual(DEFAULT_LIST_STATE);
    expect(parseListState({ status: "resolved,wont_fix", rating: "bad" })).toEqual(st({ status: RESOLVED, ratings: ["bad"] }));
    expect(parseListState({ rating: "good,risk,terrible", owner: "p1,none", process: "x", q: "  wait " })).toEqual(st({ ratings: ["risk", "good"], owners: ["p1", UNASSIGNED], processes: ["x"], q: "wait" }));
    expect(parseListState({ status: "nope", rating: "terrible" })).toEqual(DEFAULT_LIST_STATE);
    expect(parseListState({ status: "none" })).toEqual(st({ status: [] }));
  });

  it("still reads the old Open / Resolved / All links", () => {
    expect(parseListState({ show: "resolved" }).status).toEqual(RESOLVED);
    expect(parseListState({ show: "all" }).status).toEqual(ALL_STATUSES_STATE);
    expect(parseListState({ show: "open" })).toEqual(DEFAULT_LIST_STATE);
    expect(parseListState({ show: "resolved", rating: "bad" })).toEqual(st({ status: RESOLVED, ratings: ["bad"] }));
  });

  it("writes only what differs from the defaults, so the plain URL stays plain", () => {
    expect(listQuery(DEFAULT_LIST_STATE)).toBe("");
    expect(listQuery(st({ status: RESOLVED }))).toBe("?status=resolved,wont_fix");
    expect(listQuery(st({ ratings: ["bad"] }))).toBe("?rating=bad");
    expect(listQuery(st({ status: ALL_STATUSES_STATE, ratings: ["risk"], owners: ["p1"], q: "a b" }))).toBe("?status=open,testing,resolved,wont_fix&rating=risk&owner=p1&q=a+b");
    // And what it writes reads back.
    for (const s of [st({ status: ALL_STATUSES_STATE, ratings: ["risk", "bad"] }), st({ status: RESOLVED }), st({ status: [] }), st({ owners: ["p1", UNASSIGNED], processes: ["x"], q: "wait" }), DEFAULT_LIST_STATE]) {
      expect(parseListState(Object.fromEntries(new URLSearchParams(listQuery(s))))).toEqual(s);
    }
  });

  it("says a filter is on when anything differs from the defaults", () => {
    expect(filtersOn(DEFAULT_LIST_STATE)).toBe(false);
    expect(filtersOn(st({ owners: ["p1"] }))).toBe(true);
    expect(filtersOn(st({ status: RESOLVED }))).toBe(true);
    expect(filtersOn(st({ q: "x" }))).toBe(true);
  });
});

describe("counts and the list", () => {
  it("counts each status among the issues the other filters leave, never a dismissed insight", () => {
    const rows = [
      issueOf(1, { status: "open" }),
      issueOf(2, { status: "testing" }),
      issueOf(3, { status: "resolved" }),
      issueOf(4, { status: "wont_fix", severity: "info" }),
      issueOf(5, { status: "dismissed", number: null }),
    ];
    expect(Object.fromEntries(facetCounts(rows, DEFAULT_LIST_STATE, "status"))).toEqual({ open: 1, testing: 1, resolved: 1, wont_fix: 1 });
    // The status filter itself doesn't narrow its own counts; the rating filter does.
    expect(facetCounts(rows, st({ status: ["open"], ratings: ["great"] }), "status").get("wont_fix")).toBe(1);
    expect(facetCounts(rows, st({ status: ["open"], ratings: ["great"] }), "status").get("open") ?? 0).toBe(0);
  });

  it("filters by status and rating, with counts among the issues the other filters leave", () => {
    const rows = [
      issueOf(1, { status: "open", severity: "critical" }),
      issueOf(2, { status: "open", severity: "serious" }),
      issueOf(3, { status: "resolved", severity: "serious" }),
      issueOf(4, { status: "open", severity: "info" }),
    ];
    expect(listIssues(rows, DEFAULT_LIST_STATE).map((i) => i.number)).toEqual([1, 2, 4]);
    expect(listIssues(rows, st({ status: RESOLVED })).map((i) => i.number)).toEqual([3]);
    expect(listIssues(rows, st({ status: ALL_STATUSES_STATE, ratings: ["bad"] })).map((i) => i.number)).toEqual([2, 3]);
    expect(listIssues(rows, st({ status: ALL_STATUSES_STATE, ratings: ["bad", "risk"] })).map((i) => i.number)).toEqual([1, 2, 3]);
    expect(listIssues(rows, st({ status: [] }))).toEqual([]);
    expect(Object.fromEntries(facetCounts(rows, DEFAULT_LIST_STATE, "ratings"))).toEqual({ risk: 1, bad: 1, great: 1 });
    expect(facetCounts(rows, st({ status: ALL_STATUSES_STATE }), "ratings").get("bad")).toBe(2);
  });

  it("filters by owner (with Unassigned), process and a search", () => {
    const link = (process_id: string) => ({ process_id, step_id: null }) as IssueRow["links"][number];
    const rows = [
      issueOf(1, { title: "Pacing lives in three places", owner_ids: ["p1"], links: [link("x")] }),
      issueOf(2, { title: "Only Karl can vet", owner_ids: [], owner_person_id: "p2", links: [link("y")] }),
      issueOf(3, { title: "Wait for approval", owner_ids: [], owner_person_id: null, links: [], process_id: "x" }),
      issueOf(4, { title: "Both teams", owner_ids: ["p1", "p2"], links: [link("x"), link("y")] }),
    ];
    const nums = (state: ListState) => listIssues(rows, state).map((i) => i.number);
    expect(nums(st({ owners: ["p1"] }))).toEqual([1, 4]);
    expect(nums(st({ owners: ["p2"] }))).toEqual([2, 4]);
    expect(nums(st({ owners: [UNASSIGNED] }))).toEqual([3]);
    expect(nums(st({ owners: ["p1", UNASSIGNED] }))).toEqual([1, 3, 4]);
    expect(nums(st({ processes: ["y"] }))).toEqual([2, 4]);
    expect(nums(st({ processes: ["x"] }))).toEqual([1, 3, 4]);
    expect(nums(st({ q: "VET" }))).toEqual([2]);
    expect(nums(st({ q: "#3" }))).toEqual([3]);
    expect(nums(st({ owners: ["p1"], processes: ["y"] }))).toEqual([4]);
    const owners = facetCounts(rows, DEFAULT_LIST_STATE, "owners");
    expect([owners.get("p1"), owners.get("p2"), owners.get(UNASSIGNED)]).toEqual([2, 2, 1]);
  });

  it("sorts by rating, worst first, then by cost, costliest first", () => {
    const rows = [issueOf(1, { severity: "serious", detected_key: "a" }), issueOf(2, { severity: "serious", detected_key: "b" }), issueOf(3, { severity: "critical" }), issueOf(4, { severity: "serious" })];
    const cost = (perMonth: number) => ({ ...noCost(""), perMonth }) as ReturnType<typeof noCost>;
    const costs: Record<string, ReturnType<typeof noCost>> = { a: cost(100), b: cost(900) };
    const order = listIssues(rows, st({ status: ALL_STATUSES_STATE }), (i) => (i.detected_key ? (costs[i.detected_key] ?? null) : null));
    // Operational risk first; then the Bad ones, #2 (900) before #1 (100); #4 has no cost and sorts last.
    expect(order.map((i) => i.number)).toEqual([3, 2, 1, 4]);
  });
});

describe("the issue's address", () => {
  it("is its number, and the number or the id finds it; a dismissed insight is not found", () => {
    const rows = [issueOf(1), issueOf(7), issueOf(9, { status: "dismissed", number: null })];
    expect(issueHref("/w/acme", rows[1]!)).toBe("/w/acme/issues/7");
    expect(findIssue(rows, "7")?.id).toBe(rows[1]!.id);
    expect(findIssue(rows, rows[0]!.id)?.number).toBe(1);
    expect(findIssue(rows, rows[2]!.id)).toBeNull();
    expect(findIssue(rows, "99")).toBeNull();
  });

  it("says when it was logged and, for an acknowledged insight, which rule found it", () => {
    expect(loggedLine({ created_at: "2026-10-01T10:00:00Z", detected_key: null, type: "manual" }, now)).toBe("Logged 1 Oct");
    const key = "capacity:role:00000000-0000-4000-8000-000000000001";
    expect(insightRuleOf({ detected_key: key, type: "capacity" })).toBe("Too busy");
    expect(loggedLine({ created_at: "2026-10-01T10:00:00Z", detected_key: key, type: "capacity" }, now)).toBe("Logged 1 Oct from insight “Too busy”");
  });
});

describe("solutions tested", () => {
  it("are empty with no solutions, so the list says none and the page its empty state", () => {
    expect(solutionSummaries(NO_SOLUTIONS_DATA)).toEqual({});
  });
});

describe("resolving and reopening", () => {
  it("records how and the note, stamps the date and logs one resolved entry carrying both", async () => {
    const s = store();
    const target = northbeamIssues()[2]!;
    const done = await ok(s.resolve(target.id, "process_change", "  Removed the call.  "));
    expect(done).toMatchObject({ status: "resolved", resolved_how: "process_change", resolution_note: "Removed the call." });
    expect(done.resolved_at).not.toBeNull();
    const log = await s.events(target.id);
    expect(log.map((e) => e.kind)).toEqual(["created", "resolved"]);
    expect(log[1]!.detail).toEqual({ from: "open", to: "resolved", how: "process_change", note: "Removed the call." });
  });

  it("refuses a way that isn't one of the three", async () => {
    expect(parseResolveInput({ how: "magic", note: null }).ok).toBe(false);
    expect(parseResolveInput({ how: "solution", note: "x".repeat(2001) }).ok).toBe(false);
    expect(parseResolveInput({ how: "not_a_problem", note: "  " })).toEqual({ ok: true, value: { how: "not_a_problem", note: null, solutionId: null } });
    // A solution (A50) can only be named with "A solution fixed it", and must look like an id.
    const sol = "00000000-0000-4000-8000-0000000000bb";
    expect(parseResolveInput({ how: "solution", note: null, solutionId: sol })).toEqual({ ok: true, value: { how: "solution", note: null, solutionId: sol } });
    expect(parseResolveInput({ how: "process_change", note: null, solutionId: sol }).ok).toBe(false);
    expect(parseResolveInput({ how: "solution", note: null, solutionId: "nope" }).ok).toBe(false);
    const r = await store().resolve(northbeamIssues()[0]!.id, "magic" as never, null);
    expect(r.status).toBe("error");
  });

  it("a resolved issue leaves the map badges and the open list, and keeps its history", async () => {
    const s = store();
    const [first, second] = northbeamIssues();
    // Before: both are open and badge their step (they sit on the same one).
    const before = mapFeed(registerEntries(all(s), []));
    expect(before.badges[first!.step_id!]?.count).toBe(2);
    expect(listIssues(all(s), DEFAULT_LIST_STATE).map((i) => i.id)).toContain(first!.id);

    await ok(s.resolve(first!.id, "not_a_problem", "Gone"));
    const after = mapFeed(registerEntries(all(s), []));
    expect(after.badges[first!.step_id!]?.count).toBe(1);
    expect(after.badges[first!.step_id!]?.titles).toEqual([second!.title]);
    expect(listIssues(all(s), DEFAULT_LIST_STATE).map((i) => i.id)).not.toContain(first!.id);
    expect(listIssues(all(s), st({ status: RESOLVED })).map((i) => i.id)).toEqual([first!.id]);
    expect((await s.events(first!.id)).map((e) => e.kind)).toEqual(["created", "resolved"]);
  });

  it("stays off the map and out of the open list even if the analysis detects it again, however it was resolved (D38)", async () => {
    const s = store();
    const tracked = northbeamIssues()[1]!;
    const detection = { key: tracked.detected_key!, type: tracked.type, rating: "bad", cost: noCost(""), title: tracked.title, evidence: "", metrics: {}, stepId: tracked.step_id, roleId: null, personId: null, fix: null } as unknown as DetectedIssue;
    expect(mapFeed(registerEntries(all(s), [detection])).badges[tracked.step_id!]?.count).toBe(2);
    await ok(s.resolve(tracked.id, "process_change", null));
    const entries = registerEntries(all(s), [detection]);
    expect(mapFeed(entries).badges[tracked.step_id!]?.count).toBe(1);
    // Resolved by an older route that recorded no way (a resolved row with no how) is no different.
    const legacy = all(s).map((i) => (i.id === tracked.id ? { ...i, resolved_how: null } : i));
    expect(mapFeed(registerEntries(legacy, [detection])).badges[tracked.step_id!]?.count).toBe(1);
    expect(listIssues(legacy, DEFAULT_LIST_STATE).map((i) => i.id)).not.toContain(tracked.id);
  });

  it("refuses to resolve an issue that is already resolved, and keeps what was recorded", async () => {
    const s = store();
    const t = northbeamIssues()[0]!;
    await ok(s.resolve(t.id, "solution", "First"));
    const again = await s.resolve(t.id, "not_a_problem", "Second");
    expect(again).toEqual({ status: "error", message: expect.stringMatching(/already resolved/) });
    expect(all(s).find((i) => i.id === t.id)).toMatchObject({ resolved_how: "solution", resolution_note: "First" });
  });

  it("reopen sets it back to Open, clears how and the note, logs it, and the resolved entry stays", async () => {
    const s = store();
    const target = northbeamIssues()[0]!;
    await ok(s.resolve(target.id, "solution", "Lead scoring"));
    const back = await ok(s.reopen(target.id));
    expect(back).toMatchObject({ status: "open", resolved_how: null, resolution_note: null, resolved_at: null });
    const log = await s.events(target.id);
    expect(log.map((e) => e.kind)).toEqual(["created", "resolved", "reopened"]);
    expect(log[1]!.detail).toMatchObject({ how: "solution", note: "Lead scoring" });
    // It is back on the map.
    expect(mapFeed(registerEntries(all(s), [])).badges[target.step_id!]?.titles).toContain(target.title);
  });

  it("a status change through the per-field save also clears how and the note on reopen, and logs", async () => {
    const s = store();
    const t = northbeamIssues()[0]!;
    await ok(s.resolve(t.id, "process_change", "x"));
    expect((await s.saveField(t.id, "status", "resolved", "open")).status).toBe("saved");
    expect(all(s).find((i) => i.id === t.id)).toMatchObject({ status: "open", resolved_how: null, resolution_note: null });
    expect((await s.events(t.id)).map((e) => e.kind)).toEqual(["created", "resolved", "reopened"]);
  });
});

describe("the resolved bar and the history", () => {
  it("reads 'Resolved <date> · by … · note' and is absent for an open issue", () => {
    const base = { status: "resolved", resolved_at: "2026-10-09T10:00:00Z", resolved_how: "process_change", resolution_note: "Built into Sales version 8" } as const;
    expect(resolvedBar(base, now)).toBe("Resolved 9 Oct · by changing the process directly · Built into Sales version 8");
    expect(resolvedBar({ ...base, resolved_how: "not_a_problem", resolution_note: null }, now)).toBe("Resolved 9 Oct · no longer a problem");
    expect(resolvedBar({ ...base, resolved_how: null, resolution_note: null }, now)).toBe("Resolved 9 Oct");
    expect(resolvedBar({ ...base, status: "wont_fix" }, now)).toMatch(/^Won't fix 9 Oct/);
    expect(resolvedBar({ ...base, status: "open" }, now)).toBeNull();
  });

  it("lists the history oldest first, in plain words, with who", () => {
    const e = (seq: number, kind: string, detail: Record<string, unknown>, at: string) => ({ id: `e${seq}`, issue_id: "i", workspace_id: WS, seq, kind, at, actor: seq === 3 ? null : "me", detail, tx: null }) as never;
    const names = { step: (id: string) => (id === "s1" ? "Check fit" : undefined), person: (id: string) => (id === "p1" ? "Rosa" : undefined), source: () => undefined, who: (a: string | null) => (a === "me" ? "You" : "System") };
    const lines = historyLines(
      [
        e(3, "resolved", { from: "open", to: "resolved", how: "solution", note: "Lead scoring" }, "2026-10-09T10:00:00Z"),
        e(1, "created", { status: "open" }, "2026-10-01T10:00:00Z"),
        e(2, "edited", { fields: ["severity", "title"], linked: { owners: { added: ["p1"] }, steps: { added: [{ process_id: "x", step_id: "s1" }] } } }, "2026-10-02T10:00:00Z"),
        e(4, "reopened", { from: "resolved", to: "open" }, "2026-10-11T10:00:00Z"),
      ],
      names,
      now,
    );
    expect(lines.map((l) => l.text)).toEqual([
      "Logged.",
      "Changed the rating and the title. Linked Check fit. Added owner Rosa.",
      "Marked resolved by a solution. “Lead scoring”",
      "Reopened.",
    ]);
    expect(lines.map((l) => l.who)).toEqual(["You", "You", "System", "You"]);
    expect(lines[0]!.when).toBe("1 Oct");
  });
});

describe("(i) help on every control", () => {
  const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
  const sets = { LIST_HELP, ISSUE_PAGE_HELP, RESOLVE_HELP };

  it("has a description and an example for each", () => {
    for (const [name, set] of Object.entries(sets)) {
      for (const [key, help] of Object.entries(set)) {
        expect(help.label.length, `${name}.${key} label`).toBeGreaterThan(2);
        expect(help.description.length, `${name}.${key} description`).toBeGreaterThan(20);
        expect(help.example.length, `${name}.${key} example`).toBeGreaterThan(8);
        expect(`${help.description} ${help.example}`, `${name}.${key}`).not.toMatch(/\b(RLS|jsonb|payload|enum|schema|FK)\b/);
      }
    }
  });

  it("shows an (i) beside each, in the screen that uses it", () => {
    const files = { LIST_HELP: read("components/issues-page.tsx"), ISSUE_PAGE_HELP: read("components/issues/issue-page.tsx"), RESOLVE_HELP: read("components/issues/resolve-dialog.tsx") };
    for (const [name, set] of Object.entries(sets)) {
      for (const key of Object.keys(set)) {
        const src = files[name as keyof typeof files];
        // The help object is spread into an (i); naming it for its label alone doesn't give the control one.
        const used = src.includes(`<Help {...${name}.${key}}`) || src.includes(`<HelpLabel {...${name}.${key}}`) || src.includes(`help: ${name}.${key}`);
        expect(used, `${name}.${key} has no (i)`).toBe(true);
      }
    }
  });

  it("covers the buttons the prototype has on the issue page", () => {
    for (const key of ["edit", "resolve", "reopen", "build", "link"]) expect(Object.keys(ISSUE_PAGE_HELP)).toContain(key);
  });

  it("the pages use the prototype's words", () => {
    const page = read("components/issues/issue-page.tsx");
    for (const t of ["Where this issue sits", "What&apos;s wrong and sources", "Solutions tried", "Resolve", "+ Try a new solution", "Link an existing solution", "Reopen", "+ Link", "Owners", "WRONG_PROMPTS"]) expect(page).toContain(t);
    // No history timeline, no Linked to card and no step pill: an issue belongs to a process (QA round 2).
    for (const t of ["<Timeline", "Linked to", "stepPill"]) expect(page).not.toContain(t);
    const list = read("components/issues-page.tsx");
    for (const t of ["+ New issue", "Search issues", "Status", "Owner", "Rating", "Clear filters"]) expect(list).toContain(t);
  });
});
