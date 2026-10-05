// MCP server (docs/PRD.md §7.1). The HTTP endpoint lives in the web app
// (apps/web/src/app/api/mcp/route.ts) and delegates to handleMcpRequest.
export { API_TOKEN_HEADER, handleMcpRequest, type McpHandlerOptions } from "./handler";
export { assertPublishableKey } from "./key-guard";
export { ToolError, type ToolPayload } from "./result";
export { generateApiToken, hashApiToken, looksLikeApiToken } from "./tokens";
export { applyOverrides, createMcpServer, DEFAULT_REPS, DEFAULT_SEED, summarizeRun, TOOL_NAMES } from "./tools";
export { ANALYSIS_TOOL_NAMES, DEFAULT_ROBUSTNESS_SECONDS, MAX_ROBUSTNESS_SECONDS } from "./analysis-tools";
export { bottleneckReport, checkScenarioRobustness, compareScenarios, matchNamed, robustnessParameters, stackPatches, type NamedScenario } from "./analysis";
export { SUGGESTION_TOOL_NAMES } from "./suggestion-tools";
export { buildIssueProposal, buildSolutionIdeaProposal, matchIssue, MAX_PROPOSED_STEPS, requireSwitch, type ProposalInsert } from "./proposing";
export { buildClientSuggestion, buildCompanySuggestion, buildDemandSuggestions, buildPersonSuggestion, buildRoleSuggestion, buildServiceSuggestion, matchForUpsert } from "./suggesting";
export { BUILDING_TOOL_NAMES, createProcessFromTemplate } from "./building-tools";
export { buildNewStep, buildStepChange, planImport, resolveName, revisionDiff, type ImportInput, type ImportPlan, type RevisionDiff, type StepFields } from "./building";
export { FIRST_PRINCIPLES_TOOL_NAMES } from "./first-principles-tools";
export { mergeFirstPrinciples, type FpInput, type FpMergeResult, type FpMode } from "./first-principles";
export { PROCESS_TEMPLATES, type ProcessTemplate } from "./templates";
export { fileToProcessJson, importProcessFile, previewProcessFile, type ImportFileOptions, type ImportFileResult, type ImportPreview } from "./import-file";
export { LINK_FETCHES_PER_MINUTE, takeLinkFetch, type LinkFetchTurn } from "./link-limit";
export { checkLink, fetchPublicPage, isPublicAddress, LinkError, NOT_PUBLIC_ADVICE, PUBLIC_POLICY, type FetchPolicy, type Resolver } from "./fetch-link";
