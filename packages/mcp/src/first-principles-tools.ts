// First-principles tool (issue #119, A54; docs/research/first-principles.md Part B): get_first_principles reads a process's first
// principles: the job, hard truths against assumptions, requirements with a named owner, delete candidates, what to simplify,
// accelerate and automate, the root cause and the success measures. Read-only (docs/plans/cut-list.md item 5): filling them in
// is done in the app, or arrives with an uploaded file. The text it returns comes from the rule checks in
// packages/engine/src/first-principles.ts, never a language model.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadFirstPrinciples, loadProcessBundle, type ProcessBundle } from "@transpera-flow/db";
import { countFilled, countFlags, emptyFirstPrinciples, firstPrinciplesFlags, isAttention, stepsFilled, type FirstPrinciples, type FpFlags } from "@transpera-flow/engine";
import { resolveProcess, resolveWorkspace, revisionIdFor, type ToolContext } from "./context";
import { runTool } from "./result";

export const FIRST_PRINCIPLES_TOOL_NAMES = ["get_first_principles"] as const;

const workspaceArg = z.string().optional().describe("Workspace id, slug or name. Defaults to the active workspace (set_active_workspace).");
const processArg = z.string().optional().describe("Process id or name. Defaults to the workspace's only process.");

const summarise = (fp: FirstPrinciples, flags: FpFlags) => ({
  steps_filled: countFilled(fp),
  filled: stepsFilled(fp),
  flag_count: countFlags(flags),
  flags: Object.fromEntries(Object.entries(flags).map(([k, list]) => [k, list.filter(isAttention).map((f) => ({ level: f.level, code: f.code, text: f.text }))])),
});

const contextOf = (bundle: Pick<ProcessBundle, "steps" | "people" | "roles">) => ({
  steps: bundle.steps.filter((s) => s.kind === "task" || s.kind === "wait" || s.kind === "decision" || s.kind === "subprocess").map((s) => ({ id: s.id, name: s.name })),
  people: bundle.people.map((p) => ({ id: p.id, name: p.name })),
  roles: bundle.roles.map((r) => ({ name: r.name })),
});

export function registerFirstPrinciplesTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_first_principles",
    {
      title: "Get first principles",
      description:
        "Read a process's first principles (the job, hard truths and assumptions, requirements and their owners, delete candidates, changes, root cause and success measures) " +
        "with what the rule checks flag. Reads the draft when there is one, else live.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        process: processArg,
        workspace: workspaceArg,
        revision: z.enum(["live", "draft"]).optional().describe("Which version to read (default: the draft if there is one, else live)."),
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const proc = await resolveProcess(ctx, ws, args.process, assumptions);
        const revision = args.revision ?? (proc.draft_revision_id ? "draft" : "live");
        if (!args.revision) assumptions.push(`revision defaulted to ${revision}.`);
        const revisionId = revisionIdFor(proc, revision);
        const [bundle, stored] = await Promise.all([loadProcessBundle(ctx.db, ws, proc, revisionId), loadFirstPrinciples(ctx.db, proc.id, revisionId)]);
        const fp = stored.doc ?? emptyFirstPrinciples();
        const flags = firstPrinciplesFlags(fp, contextOf(bundle));
        return {
          workspace: { id: ws.id, name: ws.name },
          process: { id: proc.id, name: proc.name },
          revision: { id: revisionId, which: revision, number: bundle.revision.number },
          started: stored.doc !== null,
          inherited_from_version: stored.inheritedFrom,
          first_principles: fp,
          ...summarise(fp, flags),
          text: stored.doc
            ? `${countFilled(fp)} of 7 steps filled in for '${proc.name}' (${revision}), ${countFlags(flags)} flags.`
            : `'${proc.name}' has no first principles yet; they are filled in in the app.`,
        };
      }),
  );
}
