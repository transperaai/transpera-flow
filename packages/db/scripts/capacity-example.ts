// Loads the prototype's made-up example agency (src/fixtures/capacity-example.ts) into an EMPTY workspace, for building and testing the Capacity page.
//   pnpm --filter @transpera-flow/db capacity:example --workspace <slug> [--driver pg|neon-ws]
// Refuses a workspace that has anything in it. NEVER run it against the client's deployment: the data is made up.
import { parseArgs } from "node:util";
import { loadCapacityExample } from "../src/fixtures/capacity-example.ts";
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
  console.error("Usage: DATABASE_URL=... capacity-example.ts --workspace <slug> [--driver pg|neon-ws]");
  process.exit(2);
}

const { client, close } = await connectTarget(url, driver);
try {
  const found = await client.query("select id from public.workspaces where slug = $1", [values.workspace]);
  if (found.rows.length === 0) {
    console.error(`No workspace with the slug "${values.workspace}".`);
    process.exit(1);
  }
  await client.query("begin");
  try {
    const result = await loadCapacityExample(client, String(found.rows[0]!.id));
    await client.query(result.applied ? "commit" : "rollback");
    console.log(
      result.applied
        ? `Loaded the example into "${values.workspace}": ${result.people} people, ${result.clients} named clients, ${result.processes} processes (${result.steps} steps), ${result.links} servicing links.`
        : `Nothing changed: ${result.reason}`,
    );
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
} finally {
  await close();
}
