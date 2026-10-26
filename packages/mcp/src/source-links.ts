// What a source is linked to, from an MCP caller's side (issue #118, A53 slice 2): `add_source` must link the source to at
// least one process, step, insight, issue or solution, and `link_source` adds more. A link names its target the way the other
// tools do (an id, or a name that resolves to exactly one thing); this resolves each to the ids the database stores
// (`SourceLinkTarget`, packages/db/src/source-links.ts) and says in plain words what it did.

import { z } from "zod";
import { linkColumns, loadLinkTargets, type LinkTargets, type SourceLinkTarget } from "@transpera-flow/db";
import { resolveName } from "./building";
import type { ToolContext } from "./context";
import { ToolError } from "./result";

const MAX_LINKS = 50;
const INSIGHT_KEY = /^[a-z_]+:[a-z_]+:[^\s]{1,200}$/;

/** One thing a source is evidence for. Exactly one of `process`, `step`, `insight`, `issue` or `solution` (a step may also name its `process`). */
export const linkArg = z
  .object({
    process: z.string().min(1).optional().describe("A process (id or name): the source is evidence for the whole process. With `step`, the process the step is in."),
    step: z.string().min(1).optional().describe("A step (id, or its name; pass `process` too when two processes have a step of that name)."),
    insight: z.string().min(1).optional().describe("An insight's detection key, such as 'spof:step:<step id>' (the keys the analysis gives its findings)."),
    issue: z.union([z.number().int().positive(), z.string().min(1)]).optional().describe("An issue: its number (12 or '#12'), id or title."),
    solution: z.string().min(1).optional().describe("A solution (id or name)."),
  })
  .strict();

export type LinkArg = z.infer<typeof linkArg>;

export const linksArg = z.array(linkArg).max(MAX_LINKS);

/** The message every caller of an old shape gets: say what to pass. */
export const NEEDS_LINKS =
  "A source must be linked to at least one process, step, insight, issue or solution, or it doesn't count as evidence. " +
  "Pass `links`, for example links: [{ process: 'Lead to live' }] or [{ step: 'Check fit' }, { issue: 12 }]. " +
  "If you are adding it only to cite from import_process or a step's evidence in the next call, pass link_later: true: " +
  "the database links it to the steps that cite it, and until then it shows as 'Not linked to anything yet'.";

/** What the caller sees for a resolved link: "Step: Check fit". */
export function describeLink(t: SourceLinkTarget, targets: LinkTargets): string {
  switch (t.kind) {
    case "process":
      return `Process: ${targets.processes.find((p) => p.id === t.processId)?.name ?? t.processId}`;
    case "step":
      return `Step: ${targets.steps.find((s) => s.id === t.stepId)?.name ?? t.stepId}`;
    case "insight":
      return `Insight: ${targets.insights.find((i) => i.key === t.insightKey)?.title ?? t.insightKey}`;
    case "issue": {
      const i = targets.issues.find((x) => x.id === t.issueId);
      return i?.number ? `Issue #${i.number}` : `Issue: ${i?.title ?? t.issueId}`;
    }
    case "solution":
      return `Solution: ${targets.solutions.find((s) => s.id === t.solutionId)?.name ?? t.solutionId}`;
  }
}

/** Resolve one link argument to the ids the database stores, or say what is wrong with it. */
export function resolveLink(arg: LinkArg, targets: LinkTargets, where: string): SourceLinkTarget {
  const named = (["step", "insight", "issue", "solution"] as const).filter((k) => arg[k] !== undefined);
  const kinds = arg.process !== undefined && named.length === 0 ? ["process"] : named;
  if (kinds.length !== 1) {
    throw new ToolError(
      "invalid_input",
      `Each link names exactly one thing: a process, a step, an insight, an issue or a solution (a step may also give its process). Got ${kinds.length ? kinds.join(" and ") : "an empty link"}.`,
    );
  }
  if (arg.process !== undefined && kinds[0] !== "process" && kinds[0] !== "step") {
    throw new ToolError("invalid_input", "`process` goes with a `step` only, to say which process it is in; to link a process, give just `process`.");
  }
  const kind = kinds[0]!;
  if (kind === "process") {
    return { kind, processId: resolveName(targets.processes, arg.process!, "process", where).id };
  }
  if (kind === "step") {
    const process = arg.process !== undefined ? resolveName(targets.processes, arg.process, "process", where) : null;
    const steps = (process ? targets.steps.filter((s) => s.processId === process.id) : targets.steps).map((s) => ({ id: s.id, name: s.name, processId: s.processId }));
    const step = resolveName(steps, arg.step!, "step", process ? ` in '${process.name}'${where}` : where);
    return { kind, processId: step.processId, stepId: step.id };
  }
  if (kind === "insight") {
    const key = arg.insight!.trim();
    if (!INSIGHT_KEY.test(key)) {
      throw new ToolError("invalid_input", `'${key}' isn't an insight key. A key looks like 'spof:step:<step id>' or 'capacity:role:<role id>'.`);
    }
    return { kind, insightKey: key };
  }
  if (kind === "issue") {
    const raw = typeof arg.issue === "number" ? String(arg.issue) : arg.issue!.trim();
    const number = /^#?(\d+)$/.exec(raw);
    if (number) {
      const found = targets.issues.find((i) => i.number === Number(number[1]));
      if (!found) throw new ToolError("not_found", `No issue${where} has the number ${number[1]}`, targets.issues.slice(0, 50).map((i) => ({ id: i.id, name: `${i.number ? `#${i.number} ` : ""}${i.title}` })));
      return { kind, issueId: found.id };
    }
    const issue = resolveName(targets.issues.map((i) => ({ id: i.id, name: i.title })), raw, "issue", where);
    return { kind, issueId: issue.id };
  }
  return { kind: "solution", solutionId: resolveName(targets.solutions, arg.solution!, "solution", where).id };
}

/** Resolve a list of link arguments (one or more), dropping repeats of the same thing. */
export async function resolveLinks(ctx: ToolContext, workspace: { id: string; name: string }, args: readonly LinkArg[]): Promise<{ targets: SourceLinkTarget[]; known: LinkTargets; text: string[] }> {
  if (args.length === 0) throw new ToolError("invalid_input", NEEDS_LINKS);
  const known = await loadLinkTargets(ctx.db, workspace.id);
  const where = ` in '${workspace.name}'`;
  const targets: SourceLinkTarget[] = [];
  for (const arg of args) {
    const t = resolveLink(arg, known, where);
    const c = JSON.stringify(linkColumns(t));
    if (!targets.some((o) => JSON.stringify(linkColumns(o)) === c)) targets.push(t);
  }
  return { targets, known, text: targets.map((t) => describeLink(t, known)) };
}

/**
 * An issue keeps its own list of sources too (`issue_sources`), which its history records ("linked a source"): add a source to it
 * when it is linked to the issue, as the app does. Best effort: a detected issue has no list, and a source already on it is fine.
 */
export async function recordIssueSources(ctx: ToolContext, workspaceId: string, sourceId: string, targets: readonly SourceLinkTarget[]): Promise<void> {
  for (const t of targets) {
    if (t.kind === "issue") {
      try {
        await ctx.db.insertInto("issue_sources").values({ issue_id: t.issueId, source_id: sourceId, workspace_id: workspaceId }).execute();
      } catch {
        // Best effort, as before: the old call ignored the `{ error }` it got back.
      }
    }
  }
}

/** The JSON `add_source` takes for a link. */
export const linkJson = (t: SourceLinkTarget) => {
  const c = linkColumns(t);
  return { kind: c.kind, process_id: c.process_id, step_id: c.step_id, insight_key: c.insight_key, issue_id: c.issue_id, solution_id: c.solution_id };
};

