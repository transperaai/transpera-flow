// MCP server (docs/PRD.md §7.1). The HTTP endpoint lives in the web app (apps/web/src/app/api/mcp/route.ts) and delegates to
// handleMcpRequest. The server is read-only: Claude or ChatGPT can query a workspace, and make no change to it.
export { handleMcpRequest, type McpHandlerOptions, type TokenUser } from "./handler";
export { ToolError, type ToolPayload } from "./result";
export { generateApiToken, hashApiToken, looksLikeApiToken } from "./tokens";
export { applyOverrides, createMcpServer, DEFAULT_REPS, DEFAULT_SEED, summarizeRun, TOOL_NAMES } from "./tools";
export { ANALYSIS_TOOL_NAMES, DEFAULT_ROBUSTNESS_SECONDS, MAX_ROBUSTNESS_SECONDS } from "./analysis-tools";
export { bottleneckReport, checkScenarioRobustness, compareScenarios, matchNamed, robustnessParameters, stackPatches, type NamedScenario } from "./analysis";
export { FIRST_PRINCIPLES_TOOL_NAMES } from "./first-principles-tools";
export { FACT_TOOL_NAMES } from "./facts-tools";
