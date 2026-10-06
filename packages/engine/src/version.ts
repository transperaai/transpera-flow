// The engine's version (docs/PRD.md §6.9 layer 3; issue #22; see
// docs/engine-versioning.md). Every run records it, so a saved run says which
// engine produced its numbers. It moves only with the golden baselines in
// packages/engine/golden/: any change that moves a snapshotted number fails
// the golden tests until `pnpm --filter @transpera-flow/engine golden:approve
// "<why>"` writes the new baselines and bumps this line. Don't edit it by
// hand, except to raise it to a new major version before approving.

export const ENGINE_VERSION = "1.10.0";
