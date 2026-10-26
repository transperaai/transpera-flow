import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// scripts/new-client.sh is interactive and opens browsers, so it is never run here: only checked for bash syntax.
describe("scripts/new-client.sh", () => {
  it("parses as bash", () => {
    const script = resolve(__dirname, "../../../scripts/new-client.sh");
    const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
