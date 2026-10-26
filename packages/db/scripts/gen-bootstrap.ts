// Regenerates bootstrap.sql from the migrations and seed.
import { writeFileSync } from "node:fs";
import { bootstrapSql } from "../src/bootstrap.ts";

const dir = new URL("../", import.meta.url);
writeFileSync(new URL("bootstrap.sql", dir), bootstrapSql(dir));
console.log("Wrote bootstrap.sql");
