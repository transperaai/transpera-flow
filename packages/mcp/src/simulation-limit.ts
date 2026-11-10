import { rpc } from "@transpera-flow/db/client";
import type { ToolContext } from "./context";
import { ToolError } from "./result";

// The tools that run the engine on the server have a tighter rate limit than the cheap reads (security review): every request
// counts against the token's 120 a minute (`mcp_token_lookup`), and each simulation also counts against
// `SIMULATIONS_PER_MINUTE` (`public.mcp_simulation_use`, 20270203000300_mcp_simulation_limit.sql).

/** Simulation tool calls a token may make a minute. */
export const SIMULATIONS_PER_MINUTE = 10;

/** The tools that always simulate. `list_issues` simulates only with `include_detected`, and charges then. */
export const SIMULATION_TOOL_NAMES = ["run_scenario", "compare_scenarios", "check_robustness", "get_bottlenecks", "get_facts"] as const;

/** Count one simulation for the context's token; throws a `rate_limited` ToolError (nothing runs) once the minute's are used. */
export async function chargeSimulation(ctx: ToolContext): Promise<void> {
  const r = (await rpc(ctx.db, "mcp_simulation_use", { p_per_minute: ctx.simulationsPerMinute ?? SIMULATIONS_PER_MINUTE })) as {
    allowed?: boolean;
    retry_after_seconds?: number;
    limit?: number;
  } | null;
  if (r?.allowed === true) return;
  const wait = r?.retry_after_seconds ?? 60;
  throw new ToolError(
    "rate_limited",
    `This API token has used its ${r?.limit ?? SIMULATIONS_PER_MINUTE} simulations for this minute. Try again in ${wait} second${wait === 1 ? "" : "s"}; reads (lists, processes, summaries) still work.`,
  );
}
