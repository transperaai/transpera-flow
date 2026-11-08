// Whether the Sandbox shows saved scenarios: the scenario bar (save, rename, duplicate, build on, delete), the scenario list and the compare view (up to
// three). Off for the client app (decision D38): the Sandbox is free play, its levers reset when you leave the page, and stored scenarios stay in the
// database, untouched. The code and its tests stay (sandbox-view.tsx, scenario-bar.tsx, sandbox-compare.tsx, the saved-scenario actions), so turning this
// on brings the old Sandbox page back with no other change. It sits next to SANDBOX_ANALYSIS_SHOWN (goal seek and "What matters most", D33).
export const SANDBOX_SCENARIOS_SHOWN: boolean = false;
