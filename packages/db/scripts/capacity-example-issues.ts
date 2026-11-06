// Adds the example issues, the links from the stored changes to them, three solutions and the Block library's four example blocks (one used by a fourth solution) to a workspace the example loader filled
// (src/fixtures/capacity-example-issues.ts), for QA of Issues and Solutions.
//   pnpm --filter @transpera-flow/db capacity:example-issues --workspace <slug> [--driver pg|neon-ws]
// Refuses a workspace that doesn't hold the example, and changes nothing in one that already has issues. NEVER run it against the
// client's deployment: the data is made up.
import { parseArgs } from "node:util";
import { addExampleBlocks } from "../src/fixtures/capacity-example-blocks.ts";
import { addExampleIssues } from "../src/fixtures/capacity-example-issues.ts";
import { DRIVERS, connectTarget, type Driver } from "./copy-from-supabase/connect.ts";

let values: { workspace?: string; driver?: string };
try {
  ({ values } = parseArgs({ options: { workspace: { type: "string" }, driver: { type: "string" } }, strict: true }));
} catch {
  values = {};
}
const driver = (values.driver ?? "pg") as Driver;
const url = process.env.DATABASE_URL;
if (!values.workspace || !DRIVERS.includes(driver) || !url) {
  console.error("Usage: DATABASE_URL=... capacity-example-issues.ts --workspace <slug> [--driver pg|neon-ws]");
  process.exit(2);
}

const { client, close } = await connectTarget(url, driver);
try {
  const found = await client.query("select id from public.workspaces where slug = $1", [values.workspace]);
  if (found.rows.length === 0) {
    console.error(`No workspace with the slug "${values.workspace}".`);
    process.exit(1);
  }
  const workspaceId = String(found.rows[0]!.id);
  await client.query("begin");
  try {
    const result = await addExampleIssues(client, workspaceId);
    await client.query(result.applied ? "commit" : "rollback");
    console.log(
      result.applied
        ? `Added to "${values.workspace}": ${result.issues} issues, ${result.changesLinked} changes linked to them, ${result.solutions} solutions.`
        : `Nothing changed: ${result.reason}`,
    );
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
  // Then the Block library's example blocks, in a transaction of their own: they go in whether or not the issues did (a workspace that
  // already has issues still gets the blocks), and a workspace whose library has them is left alone.
  await client.query("begin");
  try {
    const blocks = await addExampleBlocks(client, workspaceId);
    await client.query(blocks.applied ? "commit" : "rollback");
    console.log(
      blocks.applied
        ? `Added to "${values.workspace}": ${blocks.blocks} blocks, ${blocks.solutions} solution using one.`
        : `Blocks: nothing changed: ${blocks.reason}`,
    );
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
} finally {
  await close();
}
