// What a save carries, shared by the page, the demo store and the actions.
import type { SandboxChange } from "@transpera-flow/db";

export interface SaveInput {
  name: string;
  description: string | null;
  parent_id: string | null;
  changes: SandboxChange[];
  horizon_months: number;
}
