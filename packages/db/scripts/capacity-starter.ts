// Gives an empty workspace the capacity starter (src/capacity-starter.ts): two departments, tiers T1 to T3 with the prototype's example numbers
// (all marked estimate), and the nine roles. Safe to run twice; it refuses a workspace that has anything in it.
//   pnpm --filter @transpera-flow/db capacity:starter --workspace <slug> [--driver pg|neon-ws]
// Runs as DATABASE_URL's owner (new-client.sh stage "Capacity starter", docs/new-client.md section 12). Never on a client in use.
import { parseArgs } from "node:util";
import { applyCapacityStarter } from "../src/capacity-starter.ts";
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
  console.error("Usage: DATABASE_URL=... capacity-starter.ts --workspace <slug> [--driver pg|neon-ws]");
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
    const result = await applyCapacityStarter(client, String(found.rows[0]!.id));
    await client.query(result.applied ? "commit" : "rollback");
    console.log(result.applied ? `Gave "${values.workspace}" ${result.tiers} tiers, ${result.services} services and ${result.roles} roles.` : `Nothing changed: ${result.reason}`);
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
} finally {
  await close();
}
