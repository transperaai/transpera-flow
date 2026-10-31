// Whether the Sandbox screen shows goal seek ("Find a value") and "What matters most" (the tornado). Off for the client app
// (decision D33): the code, its tests and its helpers stay (goal-seek-dialog.tsx, tornado.tsx, tornado.ts, goal-targets.ts,
// analysis-run.ts), so turning this on brings both back with no other change.
export const SANDBOX_ANALYSIS_SHOWN: boolean = false;
