// Example issues and solutions for the preview's example agency (capacity QA package Q6).
//
// `addExampleIssues(db, workspaceId)` adds to a workspace the example loader filled (capacity-example.ts):
//   - eight issues on real steps of the example processes, in plain words (the prototype's five, and three that fit the data);
//   - the links from the solutions that hold the example's changes (capacity-example.ts, `solutions.step_changes`) to the issue each fixes (`solution_issues`);
//   - three solutions (a copied map of one process with a real routing change), each linked to an issue, at different stages.
//
// THE DATA IS MADE UP, like the example's. Everything is written through the SQL functions the app calls (`save_issue`,
// `save_solution`, `resolve_issue`) and the plain updates its Solution page makes, so the rows are what the app makes. Those
// functions check the caller can edit the workspace from the JWT claims, which a plain database connection (the owner login) doesn't
// have: it sets the claims of an agency admin for the length of the caller's transaction and puts the old ones back.
//
// Run it inside a transaction. It refuses a workspace that doesn't hold the example, and changes nothing in one that already has issues.

import { randomUUID } from "node:crypto";
import { capacityModel } from "@transpera-flow/engine";
import type { Queryable } from "../capacity-starter";

/** A process that only the example loader makes: a workspace without it doesn't hold the example. */
export const EXAMPLE_MARKER_PROCESS = "Performance: Pacing and hygiene, per channel";

export type ExampleIssuesResult =
  | { applied: true; issues: number; changesLinked: number; solutions: number }
  | { applied: false; reason: string };

type Rating = "critical" | "serious" | "warning" | "info";

interface IssueSpec {
  key: string;
  title: string;
  /** The example process (by key in the model) and the steps it sits on (names in that process). */
  process: string;
  steps: { process: string; step: string }[];
  type: "manual" | "capacity" | "spof" | "delay";
  severity: Rating;
  owner: string;
  evidence: string;
  /** Changes that fix it, by exact name: the solutions that hold them (one for each process the change acts on) are linked to the issue. */
  changes: string[];
}

// The prototype's ISSUES, then three that fit the data. Severity is the stored spelling of the app's rating:
// critical = at risk, serious = bad, warning = good, info = great.
const ISSUES: IssueSpec[] = [
  {
    key: "pacing", title: "Pacing lives in three places", process: "perf-pacing", steps: [{ process: "perf-pacing", step: "Pacing checks" }],
    type: "manual", severity: "serious", owner: "wendlley",
    evidence: "Budgets are typed into the recommendations sheet, the pacing sheet and the platforms. A stale sheet caused a $10K overspend.",
    changes: ["Unified pacing with alerts", "Anomaly and threshold alerts"],
  },
  {
    key: "links", title: "Link team runs near its utilisation threshold", process: "org-links", steps: [{ process: "org-links", step: "Link outreach" }],
    type: "capacity", severity: "warning", owner: "karl",
    evidence: "About 300 links a month with two outreach specialists. The team's busy share sits close to the 85% utilisation threshold, so a busy month tips it over.",
    changes: ["AI link-domain pre-vetting", "Link health monitor, publisher CRM, invoice chasing"],
  },
  {
    key: "onboarding", title: "Onboarding crowds out monthly work", process: "org-strategy", steps: [{ process: "org-strategy", step: "Strategy review" }],
    type: "capacity", severity: "warning", owner: "laura",
    evidence:
      "Five site onboardings in one month forced out-of-hours work. The example has no onboarding process, so this is logged on Strategy review, the heaviest Organic manager step (8 hours), which is what gets squeezed.",
    changes: ["Review slides for small clients"],
  },
  {
    key: "briefs", title: "Content briefs are re-typed for freelancers", process: "org-content", steps: [{ process: "org-content", step: "Content briefs" }],
    type: "manual", severity: "info", owner: "sarah",
    evidence: "Briefs are copied by hand into four freelancer sheets.",
    changes: ["Content brief automation and freelancer handoff"],
  },
  {
    key: "prep", title: "Meeting prep is data hunting", process: "perf-meet",
    steps: [{ process: "perf-meet", step: "Meeting prep & notes" }, { process: "org-meet", step: "Meeting prep & notes" }],
    type: "manual", severity: "warning", owner: "sophie",
    evidence: "Up to 1h15 per call collating data across platforms, in Performance and in Organic.",
    changes: ["Pre-call data collation and talking points", "Pre-call data collation (Organic)"],
  },
  {
    key: "vetting", title: "Only Karl can vet link domains", process: "org-links", steps: [{ process: "org-links", step: "Domain vetting" }],
    type: "spof", severity: "critical", owner: "laura",
    evidence: "Every link goes through Karl for vetting, and nobody else is set up to do it. When Karl is away the links queue behind him and the month's link target slips.",
    changes: [],
  },
  {
    key: "approvals", title: "Monthly plans wait on client approval", process: "org-monthly", steps: [{ process: "org-monthly", step: "Project plan & approvals" }],
    type: "delay", severity: "serious", owner: "nadiya",
    evidence:
      "Plans go to the client for sign-off and sit there, so the report can't be started until the plan is agreed. The example models the manager's time on this step, not the days spent waiting.",
    changes: ['Report "work completed / planned" page'],
  },
  {
    key: "adqa", title: "Ad QA repeats checks done at build", process: "perf-builds", steps: [{ process: "perf-builds", step: "Ad QA" }],
    type: "manual", severity: "info", owner: "shrishti",
    evidence: "Every small campaign change got the full ad check, though the specialist had already checked the same things while building it.",
    changes: ["Meta ad QA checker"],
  },
];

const UNCHECKED_NOTE = "This issue has no goal to check against. Give your own verdict.";

interface Row {
  [column: string]: unknown;
}

/**
 * Adds the example issues, change links and solutions to a workspace the example loader filled. Run inside a transaction.
 * Does nothing, and says why, for a workspace that doesn't hold the example or that already has issues.
 */
export async function addExampleIssues(db: Queryable, workspaceId: string): Promise<ExampleIssuesResult> {
  const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[]) => (await rows(sql, params))[0]!;

  if ((await rows("select 1 from public.workspaces where id = $1 for update", [workspaceId])).length === 0) return { applied: false, reason: "No such workspace." };
  const model = capacityModel();
  const processNames = new Map(Object.entries(model.servicingProcesses!).map(([key, p]) => [key, p.name]));
  if ((await rows("select 1 from public.processes where workspace_id = $1 and name = $2 and is_company is not true", [workspaceId, EXAMPLE_MARKER_PROCESS])).length === 0) {
    return { applied: false, reason: `The workspace doesn't hold the example (no process called "${EXAMPLE_MARKER_PROCESS}"): this is only for one the example loader filled.` };
  }
  if ((await rows("select 1 from public.issues where workspace_id = $1 limit 1", [workspaceId])).length > 0) {
    return { applied: false, reason: "The workspace already has issues: nothing was added." };
  }

  // The functions check the caller from the JWT claims: act as an agency admin until the end of this transaction's work.
  const previous = String((await one("select coalesce(current_setting('request.jwt.claims', true), '') as v", [])).v);
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", app_metadata: { agency_admin: true } })]);
  try {
    // ---- look-ups ------------------------------------------------------------------------------------------------------------------
    const processId = new Map<string, string>();
    const liveRevision = new Map<string, string>();
    for (const [key, name] of processNames) {
      const p = await one("select id, live_revision_id from public.processes where workspace_id = $1 and name = $2 and is_company is not true", [workspaceId, name]);
      processId.set(key, String(p.id));
      liveRevision.set(key, String(p.live_revision_id));
    }
    const stepId = async (process: string, step: string) => {
      const found = await rows("select id from public.steps where revision_id = $1 and name = $2 and kind = 'task'", [liveRevision.get(process), step]);
      if (found.length !== 1) throw new Error(`The example has no single step "${step}" in "${processNames.get(process)}".`);
      return String(found[0]!.id);
    };
    const personId = async (key: string) => {
      const name = model.people![key]!.name;
      const found = await rows("select id from public.people where workspace_id = $1 and name = $2", [workspaceId, name]);
      if (found.length !== 1) throw new Error(`The example has no single person called "${name}".`);
      return String(found[0]!.id);
    };

    // ---- the issues ------------------------------------------------------------------------------------------------------------------
    const issueIds = new Map<string, string>();
    for (const spec of ISSUES) {
      const links = [];
      for (const s of spec.steps) links.push({ process_id: processId.get(s.process)!, step_id: await stepId(s.process, s.step) });
      const saved = await one("select public.save_issue(p_workspace => $1, p_fields => $2::jsonb, p_links => $3::jsonb, p_owners => $4::uuid[]) as issue", [
        workspaceId,
        JSON.stringify({ title: spec.title, type: spec.type, severity: spec.severity, evidence: spec.evidence, source: "manual" }),
        JSON.stringify(links),
        [await personId(spec.owner)],
      ]);
      issueIds.set(spec.key, String((saved.issue as { id: string }).id));
    }

    // ---- the solutions that hold the changes that fix them ----------------------------------------------------------------------------
    // Linked as a record, as the migration 20270136000000 links a moved change: the insert's two triggers are off so the issue keeps the status the example
    // gives it below (the example wants a mix) and logs nothing.
    let changesLinked = 0;
    await db.query("alter table public.solution_issues disable trigger solution_issues_before_insert");
    await db.query("alter table public.solution_issues disable trigger solution_issue_tested");
    for (const spec of ISSUES) {
      for (const name of spec.changes) {
        const held = await rows("select id from public.solutions where workspace_id = $1 and name = $2 and step_changes <> '[]'::jsonb order by id", [workspaceId, name]);
        if (held.length === 0) throw new Error(`The example has no solution holding a change called "${name}".`);
        for (const h of held) {
          await db.query("insert into public.solution_issues (solution_id, issue_id, workspace_id, auto_note) values ($1, $2, $3, $4)", [h.id, issueIds.get(spec.key), workspaceId, UNCHECKED_NOTE]);
        }
        changesLinked++;
      }
    }
    await db.query("alter table public.solution_issues enable trigger solution_issues_before_insert");
    await db.query("alter table public.solution_issues enable trigger solution_issue_tested");

    // ---- the solutions -----------------------------------------------------------------------------------------------------------------
    /** The live map of a process as a solution's copy: its rows without revision, workspace and process, as the app stores them. */
    const copyOf = async (process: string) => {
      const steps = (await rows("select to_jsonb(s) - 'revision_id' - 'workspace_id' - 'process_id' as r from public.steps s where s.revision_id = $1 order by s.x, s.id", [liveRevision.get(process)])).map((r) => r.r as Record<string, unknown>);
      const edges = (await rows("select to_jsonb(e) - 'revision_id' - 'workspace_id' - 'process_id' as r from public.edges e where e.revision_id = $1 order by e.id", [liveRevision.get(process)])).map((r) => r.r as Record<string, unknown>);
      return { steps, edges };
    };
    const edge = (from: string, to: string, probability: number) => ({ id: randomUUID(), from_step_id: from, to_step_id: to, probability, condition_tag: null, label: null });
    const byName = (steps: Record<string, unknown>[], name: string) => {
      const s = steps.find((x) => x.name === name);
      if (!s) throw new Error(`The copy has no step "${name}".`);
      return s;
    };
    const saveSolution = async (process: string, issueKey: string, name: string, copy: { steps: Record<string, unknown>[]; edges: Record<string, unknown>[] }, changed: string[]) => {
      const saved = await one("select public.save_solution(p_workspace => $1, p_process => $2, p_base_revision => $3, p_name => $4, p_steps => $5::jsonb, p_changed => $6::jsonb, p_links => $7::jsonb) as solution", [
        workspaceId,
        processId.get(process),
        liveRevision.get(process),
        name,
        JSON.stringify({ steps: copy.steps, edges: copy.edges, entry_step_id: null }),
        JSON.stringify(changed),
        JSON.stringify([{ issue_id: issueIds.get(issueKey), auto_verdict: null, holds_pct: null, auto_note: UNCHECKED_NOTE }]),
      ]);
      return String((saved.solution as { id: string }).id);
    };
    const without = (copy: { steps: Record<string, unknown>[]; edges: Record<string, unknown>[] }, ids: string[]) => ({
      steps: copy.steps.filter((s) => !ids.includes(s.id as string)),
      edges: copy.edges.filter((e) => !ids.includes(e.from_step_id as string) && !ids.includes(e.to_step_id as string)),
    });

    // 1. One budget entry instead of three. Pacing checks and the review that follows are one step: the budget is entered once, and the
    //    checks and the review read the same sheet (about ten minutes a channel of re-typing goes). Stage: just saved, still Testing.
    {
      const copy = await copyOf("perf-pacing");
      const a = byName(copy.steps, "Pacing checks");
      const b = byName(copy.steps, "Performance review & optimisation");
      const start = copy.steps.find((s) => s.kind === "start")!;
      const hygiene = byName(copy.steps, "PPC hygiene tasks");
      const merged = { ...b, id: randomUUID(), name: "Pacing and review from one budget entry", x: a.x, y: a.y, work_hours: Math.round(((a.work_hours as number) + (b.work_hours as number) - 1 / 6) * 1e6) / 1e6 };
      const kept = without(copy, [a.id as string, b.id as string]);
      kept.steps.push(merged);
      kept.edges.push(edge(start.id as string, merged.id, 1), edge(merged.id, hygiene.id as string, 1));
      await saveSolution("perf-pacing", "pacing", "One budget entry instead of three", kept, [merged.id]);
    }

    // 2. Vetting by a second person. Half of the vetting goes to a second reviewer, so it no longer runs through one person.
    //    Stage: Works, and the person's own verdict is a pass.
    let vettingSolution: string;
    {
      const copy = await copyOf("org-links");
      const outreach = byName(copy.steps, "Link outreach");
      const vet = byName(copy.steps, "Domain vetting");
      const admin = byName(copy.steps, "Link admin & live checks");
      const second = { ...vet, id: randomUUID(), name: "Domain vetting (second reviewer)", person_id: await personId("nadiya"), y: (vet.y as number) + 140 };
      copy.steps.push(second);
      copy.edges = copy.edges.filter((e) => !(e.from_step_id === outreach.id && e.to_step_id === vet.id));
      copy.edges.push(edge(outreach.id as string, vet.id as string, 0.5), edge(outreach.id as string, second.id, 0.5), edge(second.id, admin.id as string, 1));
      vettingSolution = await saveSolution("org-links", "vetting", "Vetting by a second person", copy, [vet.id as string, second.id]);
      await db.query("update public.solution_issues set user_verdict = 'pass', user_notes = $3 where solution_id = $1 and issue_id = $2", [
        vettingSolution,
        issueIds.get("vetting"),
        "Nadiya already knows the publishers' sites. Half each keeps Karl's queue short, and either can cover the other.",
      ]);
      await db.query("update public.solutions set status = 'works' where id = $1", [vettingSolution]);
    }

    // 3. Ad QA only on new campaigns. Changes to a running campaign skip the full check (4 in 10 still get it).
    //    Stage: Adopted: it fixed its issue, which is Resolved with this solution.
    {
      const copy = await copyOf("perf-builds");
      const build = byName(copy.steps, "Campaign builds & changes");
      const qa = byName(copy.steps, "Ad QA");
      const end = copy.steps.find((s) => s.kind === "end")!;
      copy.edges = copy.edges.filter((e) => e.from_step_id !== build.id);
      copy.edges.push(edge(build.id as string, qa.id as string, 0.4), edge(build.id as string, end.id as string, 0.6));
      const solutionId = await saveSolution("perf-builds", "adqa", "Ad QA only on new campaigns", copy, [build.id as string, qa.id as string]);
      await db.query("select public.resolve_issue(p_workspace => $1, p_id => $2, p_how => 'solution', p_note => $3, p_status => 'resolved', p_solution => $4)", [
        workspaceId,
        issueIds.get("adqa"),
        "Rolled out: only new campaigns get the full ad check now.",
        solutionId,
      ]);
      await db.query("update public.solutions set status = 'adopted' where id = $1", [solutionId]);
    }

    return { applied: true, issues: ISSUES.length, changesLinked, solutions: 3 };
  } finally {
    await db.query("select set_config('request.jwt.claims', $1, true)", [previous]);
  }
}
