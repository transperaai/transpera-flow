// What the example workspace's steps achieve (Q1 item 19), kept apart from the loader because it is plain data (no Node modules), so a browser test
// harness can import it.
import { DEFAULT_PURPOSES, parsePurposes, type PurposeCategory } from "../purposes";

/**
 * What the example's steps achieve (Q1 item 19). The engine fixture gives each step a free-text purpose from the prototype ("Client meetings", "Content",
 * "Links"); the database only stores a key of the workspace's category list, so the loader used to drop them and every servicing step fell to
 * Automatic, "Moves the client's job forward": one bucket, and a skewed "What the time achieves". Now the example workspace gets four categories
 * of its own beside the seven defaults, and every free-text purpose maps to one category.
 */
export const EXAMPLE_PURPOSES: PurposeCategory[] = [
  ...DEFAULT_PURPOSES.map((p) => ({ ...p })),
  { key: "c0000c001", name: "Content", description: "Briefs, writing and editing." },
  { key: "c0000c002", name: "Links", description: "Outreach, vetting and link admin." },
  { key: "c0000c003", name: "Technical", description: "Technical tickets and tracking fixes." },
  { key: "c0000c004", name: "Reporting and strategy", description: "Monthly reports and strategy reviews." },
];

/** The example workspace's category list, checked by the same rules the database applies. */
export function examplePurposes(): PurposeCategory[] {
  const parsed = parsePurposes(EXAMPLE_PURPOSES);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.purposes;
}

/** The category key of an example step's free-text purpose. */
export const EXAMPLE_PURPOSE_KEY: Record<string, string> = {
  "Client meetings": "coordination",
  "Account management": "coordination",
  "Ad hoc": "coordination",
  Content: "c0000c001",
  Links: "c0000c002",
  Technical: "c0000c003",
  Reporting: "c0000c004",
  Strategy: "c0000c004",
  Pacing: "client_job",
  Optimisation: "client_job",
  Implementation: "client_job",
  Creative: "client_job",
};
