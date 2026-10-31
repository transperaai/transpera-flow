import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { larkspurBundle, northbeamBundle, toEngineModel } from "../src";

// Capacity build, P1: the Set up screens store new columns but must not change what the engine is given.
// `snapshots/to-engine-model.json` was taken from the code before P1, so every variant below must stay deep-equal to it.
// To re-take it deliberately (an engine-input change, P2), run with UPDATE_ENGINE_MODEL_SNAPSHOT=1.

const START = "2026-10-05";
const FILE = new URL("./snapshots/to-engine-model.json", import.meta.url);

function current(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, b] of [["northbeam", northbeamBundle()], ["larkspur", larkspurBundle()]] as const) {
    out[name] = toEngineModel(b, { startDate: START });
    out[`${name}:planned`] = toEngineModel(b, { startDate: START, planned: true });
    out[`${name}:purposes`] = toEngineModel(b, { startDate: START, purposes: true });
    out[`${name}:payHidden`] = toEngineModel({ ...b, payHidden: true }, { startDate: START });
    out[`${name}:noGroups`] = toEngineModel({ ...b, clientGroups: [] }, { startDate: START });
  }
  // Through JSON, as the snapshot is stored: undefined fields drop out.
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

describe("toEngineModel is unchanged by the capacity Set up columns", () => {
  if (process.env.UPDATE_ENGINE_MODEL_SNAPSHOT === "1") {
    mkdirSync(new URL("./snapshots/", import.meta.url), { recursive: true });
    writeFileSync(FILE, JSON.stringify(current(), null, 1) + "\n");
  }
  const saved = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>) : {};
  const now = current();
  it("has a snapshot for every variant", () => {
    expect(Object.keys(saved).sort()).toEqual(Object.keys(now).sort());
  });
  for (const key of Object.keys(now)) {
    it(`${key} deep-equals the model from before P1`, () => {
      expect(now[key]).toEqual(saved[key]);
    });
  }
});
