import { describe, expect, it } from "vitest";
import { bundleForProcess, northbeamBundle, northbeamServicingProcessIds, northbeamStepIds, toEngineModel } from "@transpera-flow/db";
import { initialState, runOnce, simulate, type EngineModel, type TraceEntity } from "@transpera-flow/engine";
import { PlaybackClock, SPEEDS, formatSimTime, maxHopHours } from "@/lib/playback/clock";
import { playbackGraph, playbackRun } from "@/lib/playback/graph";
import { pointAlong, queueSlot, samplePath } from "@/lib/playback/paths";
import { PlaybackIndex, countAtOrBefore, type PlaybackGraph } from "@/lib/playback/trace-index";

// Playback (issue #14): the trace index behind the animation, checked against
// brute force on a real Northbeam run.

const bundle = northbeamBundle();
const model = toEngineModel(bundle, { startDate: "2026-01-05" });
const graph = playbackGraph(bundle);
const result = simulate(model, 30, 1);
const run = playbackRun(result)!;
const MAX_HOP = maxHopHours(40);
const index = new PlaybackIndex(run, graph, { maxHop: MAX_HOP });
// The pipeline's working steps: the run also carries servicing tasks, which playback of the pipeline leaves out (issue #19).
const workSteps = bundle.steps.filter((s) => s.kind !== "start" && s.kind !== "end").map((s) => s.id);

/** A fixed spread of times over the horizon, including the ends and every event time. */
function sampleTimes(entities: TraceEntity[], H: number): number[] {
  const times = new Set<number>([0, H, H / 3, H / 2]);
  for (let i = 0; i <= 400; i++) times.add((H * i) / 400);
  for (const e of entities) {
    for (const s of e.trace) {
      for (const t of [s.tQ, s.tS, s.tE, s.tL]) if (t !== null && t >= 0 && t <= H) times.add(t);
    }
  }
  return [...times].sort((a, b) => a - b);
}

const bruteQueue = (entities: TraceEntity[], step: string, t: number) =>
  entities.reduce((n, e) => n + e.trace.filter((s) => s.step === step && s.tQ <= t && (s.tS === null || t < s.tS)).length, 0);

describe("playback trace index", () => {
  const times = sampleTimes(run.entities, run.H);

  it("uses a warmed-up Northbeam run with entities carried over from the warm-up", () => {
    expect(result.initialState.kind).toBe("warmup");
    expect(run.H).toBe(520);
    expect(run.entities.some((e) => e.t0 < 0)).toBe(true);
    expect(run.entities.length).toBeGreaterThan(50);
  });

  it("counts queues at any time exactly as a brute-force pass over the trace", () => {
    for (const t of times) {
      for (const step of workSteps) expect(index.queuedAt(step, t)).toBe(bruteQueue(run.entities, step, t));
    }
  });

  it("counts service and external waits as a brute-force pass does", () => {
    for (const t of times.filter((_, i) => i % 7 === 0)) {
      for (const step of workSteps) {
        let service = 0;
        let waiting = 0;
        for (const e of run.entities) {
          for (const s of e.trace) {
            if (s.step !== step) continue;
            if (s.tS !== null && s.tS <= t && (s.tE === null || t < s.tE)) service++;
            if (s.tE !== null && s.tE <= t && (s.tL === null || t < s.tL)) waiting++;
          }
        }
        expect(index.counts(step, t)).toEqual({ queued: bruteQueue(run.entities, step, t), service, waiting });
      }
    }
  });

  it("plays a servicing process's own tasks, each ending at its end", () => {
    const report = bundleForProcess(bundle, northbeamServicingProcessIds.report!)!;
    const own = playbackRun(result, report.process)!;
    expect(own.entities.length).toBeGreaterThan(20);
    expect(own.entities.every((e) => e.servicing?.process === report.process.id)).toBe(true);
    const g = playbackGraph(report);
    expect(g.ends.done).toBe(report.steps.find((s) => s.kind === "end")!.id);
    const idx = new PlaybackIndex(own, g, { maxHop: MAX_HOP });
    const steps = report.steps.filter((s) => s.kind === "task").map((s) => s.id);
    const rep0 = runOnce(model, 1, true, initialState(model));
    for (const step of steps) expect(idx.queuedAt(step, own.H)).toBe(rep0.steps[step]!.wip);
    expect(idx.endedBy(g.ends.done!, own.H)).toBeGreaterThan(10);
  });

  it("agrees with the engine's own queue statistics for replication 0", () => {
    // Replication 0 is the traced one; its per-step stats are the ground truth.
    const rep0 = runOnce(model, 1, true, initialState(model));
    expect(rep0.entities!.filter((e) => !e.servicing)).toEqual(run.entities);
    for (const step of workSteps) {
      // Items still queued at the horizon.
      expect(index.queuedAt(step, run.H)).toBe(rep0.steps[step]!.wip);
      // The time-average of the count over [0, H] is the engine's average queue.
      const edges = [0, run.H, ...times].filter((t, i, a) => a.indexOf(t) === i).sort((a, b) => a - b);
      let area = 0;
      for (let i = 0; i + 1 < edges.length; i++) area += index.queuedAt(step, edges[i]!) * (edges[i + 1]! - edges[i]!);
      expect(area / run.H).toBeCloseTo(rep0.steps[step]!.avgQueue, 9);
    }
    // Everything that reached the won end in the measured window.
    expect(index.endedBy(graph.ends.won!, run.H)).toBe(rep0.won);
    expect(index.endedBy(graph.ends.lost!, run.H)).toBe(rep0.lost);
  });

  it("draws exactly the queued items when there are no hops, and only external waits on the move", () => {
    let drifting = 0;
    for (const t of times.filter((_, i) => i % 5 === 0)) {
      const f = index.frame(t, 0);
      for (const step of workSteps) expect(f.queued.get(step)?.length ?? 0).toBe(index.queuedAt(step, t));
      const waiting = workSteps.reduce((a, s) => a + index.waitingAt(s, t), 0);
      expect(f.moving.length).toBeLessThanOrEqual(waiting);
      drifting += f.moving.length;
    }
    expect(drifting).toBeGreaterThan(0);
  });

  it("drifts a token along its edge through an external wait, whatever the hop", () => {
    const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
    let checked = 0;
    for (const e of run.entities) {
      e.trace.forEach((seg, i) => {
        const next = e.trace[i + 1];
        if (!next || next.step === seg.step || seg.tE === null || seg.tL === null || seg.tL - seg.tE < 2 * MAX_HOP) return;
        const t = seg.tE + (seg.tL - seg.tE) / 4;
        for (const hop of [0, 1, MAX_HOP]) {
          const at = index.locate(e, t, hop);
          expect(at).toMatchObject({ kind: "moving", to: next.step });
          if (at?.kind !== "moving") return;
          expect(at.progress).toBeCloseTo(0.25, 9);
          expect(edgeById.get(at.edge)).toMatchObject({ from: seg.step, to: next.step });
        }
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("keeps every token on a real edge with progress in [0, 1)", () => {
    const edgeIds = new Set(graph.edges.map((e) => e.id));
    let seen = 0;
    for (const t of times) {
      for (const tok of index.frame(t, MAX_HOP).moving) {
        seen++;
        expect(edgeIds.has(tok.edge)).toBe(true);
        expect(tok.progress).toBeGreaterThanOrEqual(0);
        expect(tok.progress).toBeLessThan(1);
      }
    }
    expect(seen).toBeGreaterThan(100);
  });

  it("moves a token along the edge it actually takes, towards the right end", () => {
    const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
    const hop = 2;
    let trips = 0;
    let ends = 0;
    for (const e of run.entities) {
      const segs = e.trace;
      for (let i = 1; i < segs.length; i++) {
        const prev = segs[i - 1]!;
        if (prev.step === segs[i]!.step) continue;
        // Halfway through the trip: from the end of service to the later of leaving and a hop.
        const until = Math.max(prev.tL!, prev.tE! + hop);
        const t = (prev.tE! + until) / 2;
        // Unless it has already left the next step too (a step with no work).
        if (segs[i]!.tE !== null && segs[i]!.tE! <= t) continue;
        const at = index.locate(e, t, hop);
        expect(at?.kind).toBe("moving");
        if (at?.kind !== "moving") continue;
        expect(edgeById.get(at.edge)).toMatchObject({ from: prev.step, to: segs[i]!.step });
        expect(at.progress).toBeCloseTo(0.5, 9);
        trips++;
      }
      const last = segs[segs.length - 1]!;
      if (e.done !== undefined) {
        const until = Math.max(e.done, last.tE! + hop);
        const at = index.locate(e, (last.tE! + until) / 2, hop);
        expect(at?.kind === "moving" && at.to).toBe(e.outcome === "won" ? graph.ends.won : graph.ends.lost);
        expect(at?.kind === "moving" && edgeById.get(at.edge)!.from).toBe(last.step);
        expect(at?.kind === "moving" && at.outcome).toBe(e.outcome);
        // And off the map once it has arrived.
        expect(index.locate(e, until, hop)).toBeNull();
        ends++;
      }
    }
    expect(trips).toBeGreaterThan(100);
    expect(ends).toBeGreaterThan(50);
  });

  it("brings new arrivals in from the start step", () => {
    const arrival = run.entities.find((e) => e.t0 > 10 && e.t0 < run.H - 10 && e.trace[0]!.tE! > e.t0 + 0.2)!;
    const at = index.locate(arrival, arrival.t0 + 0.1, 0.2);
    const startEdge = graph.edges.find((e) => e.from === graph.start)!;
    expect(at).toMatchObject({ kind: "moving", edge: startEdge.id });
    expect(at?.kind === "moving" && at.progress).toBeCloseTo(0.5, 9);
    expect(index.locate(arrival, arrival.t0 - 0.01, 0.2)).toBeNull();
  });

  it("shows warm-up entities where they were at the start of the measured window", () => {
    const f = index.frame(0, 0);
    const onMap = run.entities.filter((e) => index.locate(e, 0, 0) !== null);
    // Everything carried over from the warm-up is on the map at t = 0, and nothing else.
    expect(onMap.length).toBeGreaterThan(0);
    expect(onMap.every((e) => e.t0 <= 0)).toBe(true);
    const carried = run.entities.filter((e) => e.t0 < 0 && (e.done === undefined || e.done > 0));
    expect(onMap.length).toBe(carried.length);
    const queuedAt0 = [...f.queued.values()].reduce((a, l) => a + l.length, 0);
    expect(queuedAt0).toBe(workSteps.reduce((a, s) => a + bruteQueue(run.entities, s, 0), 0));
  });

  it("renders the same frame for a time however it was reached", () => {
    const direct = index.frame(200, 3);
    // Scrub around, then back.
    for (const t of [500, 3, 199.9, 400, 0]) index.frame(t, 3);
    expect(index.frame(200, 3)).toEqual(direct);
    // A clock played to 200 and a clock sought to 200 land on the same frame.
    const played = new PlaybackClock({ H: run.H, hoursPerWeek: 40 });
    played.setSpeed(1);
    played.play();
    for (let i = 0; i < 25; i++) played.advance(1);
    const sought = new PlaybackClock({ H: run.H, hoursPerWeek: 40 });
    sought.setSpeed(1);
    sought.seek(200);
    expect(played.t).toBeCloseTo(200, 9);
    expect(index.frame(played.t, played.hop)).toEqual(index.frame(sought.t, sought.hop));
  });

  it("clamps frames to the measured horizon", () => {
    expect(index.frame(-50, 0)).toEqual(index.frame(0, 0));
    expect(index.frame(run.H + 50, 0)).toEqual(index.frame(run.H, 0));
  });

  it("handles a run that started from entered WIP (no arrival trip for seeded items)", () => {
    const wipModel: EngineModel = {
      ...model,
      steps: model.steps.map((s) => (s.id === northbeamStepIds.audit ? { ...s, currentWip: 5 } : { ...s, currentWip: 0 })),
    };
    const r = simulate(wipModel, 1, 1);
    expect(r.initialState.kind).toBe("wip");
    const wipIndex = new PlaybackIndex(playbackRun(r)!, graph, { maxHop: 100 });
    const seeded = r.trace!.filter((e) => e.t0 <= 0);
    expect(seeded).toHaveLength(5);
    for (const e of seeded) {
      const at = wipIndex.locate(e, 0, 100);
      expect(at?.kind).not.toBe("moving");
    }
    expect(wipIndex.queuedAt(northbeamStepIds.audit, 0) + wipIndex.inServiceAt(northbeamStepIds.audit, 0)).toBe(5);
  });

  it("builds from an empty trace", () => {
    const empty = new PlaybackIndex({ entities: [], H: 100, seededWip: false }, graph);
    expect(empty.frame(50, 1)).toEqual({ t: 50, moving: [], queued: new Map() });
    expect(empty.queuedAt(workSteps[0]!, 50)).toBe(0);
  });

  it("ignores a rework visit's missing edge (the token stays at its step)", () => {
    const g: PlaybackGraph = { edges: [{ id: "e1", from: "a", to: "b" }], start: null, ends: {} };
    const e: TraceEntity = {
      id: 1,
      t0: 0,
      trace: [
        { step: "a", person: null, tQ: 0, tS: 0, tE: 2, tL: 2 },
        { step: "a", person: null, tQ: 2, tS: 3, tE: 5, tL: 5 },
        { step: "b", person: null, tQ: 5, tS: 9, tE: null, tL: null },
      ],
    };
    const idx = new PlaybackIndex({ entities: [e], H: 20, seededWip: false }, g, { maxHop: 1 });
    expect(idx.locate(e, 2.5, 1)).toEqual({ kind: "queued", step: "a", since: 2 });
    expect(idx.locate(e, 5.5, 1)).toMatchObject({ kind: "moving", edge: "e1", progress: 0.5 });
    expect(idx.locate(e, 7, 1)).toEqual({ kind: "queued", step: "b", since: 5 });
    expect(idx.locate(e, 19, 1)).toEqual({ kind: "service", step: "b", since: 9 });
    expect(idx.queuedAt("a", 2.5)).toBe(1);
    expect(idx.queuedAt("b", 20)).toBe(0);
  });

  it("counts sorted values with binary search", () => {
    const a = [1, 2, 2, 3];
    expect([0, 1, 2, 2.5, 3, 9].map((t) => countAtOrBefore(a, t))).toEqual([0, 1, 3, 3, 4, 4]);
  });
});

describe("playback clock", () => {
  it("offers 1 hour, 1 day, 1 week and 1 month per second, in working time (Q1 item 13)", () => {
    expect(SPEEDS.map((s) => s.label)).toEqual(["1 hour per second", "1 day per second", "1 week per second", "1 month per second"]);
    const c = new PlaybackClock({ H: 10_000, hoursPerWeek: 37.5 });
    expect(c.getState().speed).toBe(1);
    const per = SPEEDS.map((_, i) => (c.setSpeed(i), c.hoursPerSecond));
    expect(per[0]).toBe(1);
    expect(per[1]).toBeCloseTo(7.5, 9);
    expect(per[2]).toBeCloseTo(37.5, 9);
    expect(per[3]).toBeCloseTo((37.5 * 52) / 12, 9);
    // A workspace with longer weeks plays faster at the same setting.
    const long = new PlaybackClock({ H: 10_000, hoursPerWeek: 50 });
    long.setSpeed(2);
    expect(long.hoursPerSecond).toBe(50);
  });

  it("plays at the chosen speed and stops at the horizon", () => {
    const c = new PlaybackClock({ H: 100, hoursPerWeek: 40 });
    c.setSpeed(1);
    expect(c.hoursPerSecond).toBe(8);
    // A hop takes a fixed wall-clock time, capped at half a working day.
    expect(c.hop).toBe(4);
    c.setSpeed(3);
    expect(c.hop).toBe(4);
    c.setSpeed(1);
    c.advance(1);
    expect(c.t).toBe(0);
    c.play();
    expect(c.getState()).toMatchObject({ playing: true, active: true });
    c.advance(2);
    expect(c.t).toBe(16);
    c.setSpeed(SPEEDS.length - 1);
    c.advance(10);
    expect(c.t).toBe(100);
    expect(c.getState()).toMatchObject({ playing: false, atEnd: true });
    // Play at the end starts over.
    c.play();
    expect(c.t).toBe(0);
  });

  it("only notifies coarse listeners when the controls change", () => {
    const c = new PlaybackClock({ H: 100, hoursPerWeek: 40 });
    let coarse = 0;
    const times: number[] = [];
    c.subscribe(() => coarse++);
    c.onTime((t) => times.push(t));
    c.play();
    c.advance(0.5);
    c.advance(0.5);
    expect(coarse).toBe(1);
    expect(times).toEqual([4, 8]);
    c.stop();
    expect(c.getState()).toMatchObject({ playing: false, active: false });
    expect(c.t).toBe(0);
  });

  it("keeps its place when the run changes, clamped to the new horizon", () => {
    const c = new PlaybackClock({ H: 100, hoursPerWeek: 40 });
    c.seek(80);
    c.configure({ H: 60, hoursPerWeek: 40 });
    expect(c.t).toBe(60);
    c.seek(-5);
    expect(c.t).toBe(0);
  });

  it("formats working time as week, day and clock", () => {
    expect(formatSimTime(0, 40)).toBe("Week 1 · Day 1 · 09:00");
    expect(formatSimTime(13.5, 40)).toBe("Week 1 · Day 2 · 14:30");
    expect(formatSimTime(41, 40)).toBe("Week 2 · Day 1 · 10:00");
    expect(formatSimTime(520, 40, true)).toBe("Week 13 · Day 5 · 17:00");
    expect(formatSimTime(7.99999, 40)).toBe("Week 1 · Day 2 · 09:00");
  });
});

describe("edge paths", () => {
  // A right-angled path: 100 right, then 50 down.
  const elbow = {
    getTotalLength: () => 150,
    getPointAtLength: (l: number) => (l <= 100 ? { x: l, y: 0 } : { x: 100, y: l - 100 }),
  };

  it("samples a path by length and interpolates along it", () => {
    const s = samplePath(elbow, "M0 0");
    const p = { x: 0, y: 0 };
    expect(pointAlong(s, 0, p)).toEqual({ x: 0, y: 0 });
    expect(pointAlong(s, 1, p)).toEqual({ x: 100, y: 50 });
    const mid = pointAlong(s, 0.5, p);
    expect(mid.x).toBeCloseTo(75);
    expect(mid.y).toBeCloseTo(0);
    expect(pointAlong(s, 5, p)).toEqual({ x: 100, y: 50 });
  });

  it("stacks queued items left of the card, oldest nearest", () => {
    const node = { x: 200, y: 100, height: 80 };
    const p = { x: 0, y: 0 };
    const first = { ...queueSlot(0, node, p) };
    const second = { ...queueSlot(1, node, p) };
    const fifth = { ...queueSlot(4, node, p) };
    expect(first.x).toBeLessThan(node.x);
    expect(second.x).toBeLessThan(first.x);
    expect(fifth.x).toBe(first.x);
    expect(fifth.y).toBeGreaterThan(first.y);
  });
});
