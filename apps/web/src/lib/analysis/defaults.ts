// The analysis settings every page rates a run with (decision D40, issue #175). The rules editor is gone: rule cut-offs
// no longer create findings, they only pick which of the engine's facts are worth showing as evidence, and every
// workspace uses the documented defaults (docs/analysis-rules.md: the cut-offs, both escalators, a lost client worth at
// most 12 months of fees, a two-week absence twice a year). What a workspace stored in `analysis_rules` is kept, unread.

import type { AnalysisSettings } from "@transpera-flow/engine";

export const ANALYSIS_DEFAULTS: AnalysisSettings = Object.freeze({}) as AnalysisSettings;
