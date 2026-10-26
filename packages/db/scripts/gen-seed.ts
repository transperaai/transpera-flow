// Regenerates seed.sql from the fixtures.
import { writeFileSync } from "node:fs";
import { northbeamAccess, northbeamBundle, northbeamIssues, northbeamScenarios, northbeamSourceLinks, northbeamSources } from "../src/fixtures/northbeam.ts";
import { larkspurBundle } from "../src/fixtures/larkspur.ts";
import { seedSql } from "../src/seed.ts";

const path = new URL("../seed.sql", import.meta.url);
writeFileSync(path, seedSql([northbeamBundle(), larkspurBundle()], [northbeamAccess()], northbeamScenarios(), northbeamIssues(), northbeamSources(), northbeamSourceLinks()));
console.log(`Wrote ${path.pathname}`);
