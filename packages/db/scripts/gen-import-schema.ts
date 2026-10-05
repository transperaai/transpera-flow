// Writes the published copies of the transpera-process/1 and /2 schemas and examples (docs/import/) from the sources of
// truth in src/process-file.ts and src/process-file-2-schema.ts. A test fails when they drift apart.
import { mkdirSync, writeFileSync } from "node:fs";
import { PROCESS_FILE_EXAMPLE, PROCESS_FILE_SCHEMA } from "../src/process-file.ts";
import { PROCESS_FILE_EXAMPLE_2, PROCESS_FILE_SCHEMA_2 } from "../src/process-file-2-schema.ts";

const dir = new URL("../../../docs/import/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("transpera-process-1.schema.json", dir), `${JSON.stringify(PROCESS_FILE_SCHEMA, null, 2)}\n`);
writeFileSync(new URL("transpera-process-1.example.json", dir), `${JSON.stringify(PROCESS_FILE_EXAMPLE, null, 2)}\n`);
writeFileSync(new URL("transpera-process-2.schema.json", dir), `${JSON.stringify(PROCESS_FILE_SCHEMA_2, null, 2)}\n`);
writeFileSync(new URL("transpera-process-2.example.json", dir), `${JSON.stringify(PROCESS_FILE_EXAMPLE_2, null, 2)}\n`);
console.log("Wrote docs/import/transpera-process-{1,2}.{schema,example}.json");
