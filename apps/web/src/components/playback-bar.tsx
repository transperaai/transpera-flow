"use client";

// Playback controls (issue #14): play/pause, speed, a scrubber over the
// measured horizon, the simulated time, and Stop (back to the normal map). The time and the
// scrubber follow the clock imperatively, so playing doesn't re-render React.
// Keys, with focus anywhere in the bar: Space plays or pauses; on the
// scrubber, arrows move an hour (Shift: a day), Page Up/Down a week, Home/End
// the ends.

import { Square } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent } from "react";
import { SPEEDS, formatSimTime, type PlaybackClock } from "@/lib/playback/clock";
import { Button } from "@/components/ui/button";

interface BarProps {
  /** Along the foot of a card (Q8): no border, fill or shadow of its own. */
  docked?: boolean;
  /**
   * In the one toolbar row above a read-only map: no box of its own, small buttons, short speed names, a scrubber that takes the
   * room left, and "Run 1 of 30" on the time's tooltip (and for a screen reader) rather than as text of its own.
   */
  inline?: boolean;
  clock: PlaybackClock;
  /** Measured horizon in hours; null while there is no run to play. */
  H: number | null;
  hoursPerWeek: number;
  reps: number | null;
  /** What a screen reader hears about the map at a time, once playback settles there. */
  describe: (t: number) => string;
}

const TEXT_INTERVAL_MS = 100;

const button =
  "rounded-token border border-line bg-panel px-2 py-1 text-fg hover:bg-panel-2 disabled:cursor-not-allowed disabled:text-fg-3 disabled:hover:bg-panel";

/** Short names for the speeds in the toolbar row; the option's text (and what a screen reader hears) stays the full one. */
const SHORT_SPEED: Record<(typeof SPEEDS)[number]["unit"], string> = { hour: "1 hour/s", day: "1 day/s", week: "1 week/s", month: "1 month/s" };

export function PlaybackBar({ docked = false, inline = false, clock, H, hoursPerWeek, reps, describe }: BarProps) {
  const state = useSyncExternalStore(clock.subscribe, clock.getState, clock.getState);
  const slider = useRef<HTMLInputElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const describeRef = useRef(describe);
  useEffect(() => {
    describeRef.current = describe;
  });
  const ready = H !== null && H > 0;

  // Follow the clock: every tick moves the scrubber and the time; a pause or a settled scrub is announced.
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    let shownAt = -Infinity;
    const show = (t: number) => {
      if (slider.current) slider.current.value = String(t);
      const { playing, active } = clock.getState();
      // While playing, the text a few times a second is plenty (and spares a layout per frame).
      const now = performance.now();
      if (playing && now - shownAt < TEXT_INTERVAL_MS) return;
      shownAt = now;
      const text = formatSimTime(t, hoursPerWeek, H !== null && t >= H);
      slider.current?.setAttribute("aria-valuetext", text);
      if (time.current) time.current.textContent = text;
      clearTimeout(settle);
      if (!active && status.current) status.current.textContent = "";
      if (playing || !active) return;
      settle = setTimeout(() => {
        if (status.current) status.current.textContent = describeRef.current(clock.t);
      }, 400);
    };
    show(clock.t);
    const offTime = clock.onTime(show);
    const offState = clock.subscribe(() => show(clock.t));
    return () => {
      offTime();
      offState();
      clearTimeout(settle);
    };
  }, [clock, hoursPerWeek, H]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!ready || e.altKey || e.metaKey || e.ctrlKey) return;
    const target = e.target as HTMLElement;
    if (e.key === " " && !target.closest("button, select")) {
      e.preventDefault();
      clock.toggle();
      return;
    }
    if (target !== slider.current) return;
    const day = hoursPerWeek / 5;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => clock.stepBy(e.shiftKey ? -day : -1),
      ArrowDown: () => clock.stepBy(e.shiftKey ? -day : -1),
      ArrowRight: () => clock.stepBy(e.shiftKey ? day : 1),
      ArrowUp: () => clock.stepBy(e.shiftKey ? day : 1),
      PageDown: () => clock.stepBy(-hoursPerWeek),
      PageUp: () => clock.stepBy(hoursPerWeek),
      Home: () => clock.seek(0),
      End: () => clock.seek(H ?? 0),
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    // Scrubbing takes over from playing.
    clock.pause();
    move();
  };

  const playLabel = state.playing ? "Pause" : state.atEnd ? "Replay" : "Play";
  const runText = ready ? `Run 1 of ${reps ?? 1}` : "Simulating…";
  const runTitle = `Playback shows one simulated run of ${Math.round((H ?? 0) / hoursPerWeek)} weeks; the figures above average all ${reps ?? 1}.`;
  if (inline)
    return (
      <div role="group" aria-label="Playback" onKeyDown={onKeyDown} className="flex flex-1 items-center gap-x-1.5 gap-y-1 text-xs max-sm:flex-wrap">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => clock.toggle()}
          disabled={!ready}
          aria-label={playLabel}
          aria-keyshortcuts="Space"
          title={`${playLabel} (Space)`}
          className={`w-[4.75rem] justify-start font-semibold ${state.playing ? "border-accent bg-accent-soft" : ""}`}
        >
          <span aria-hidden>{state.playing ? "❚❚" : "▶"}</span> {playLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => clock.stop()}
          disabled={!ready || !state.active}
          aria-label="Stop"
          data-playback-stop
          title="Stop playback and go back to the map"
          className="font-semibold"
        >
          <Square aria-hidden className="size-3 fill-current" /> Stop
        </Button>
        <label className="sr-only" htmlFor="playback-speed">
          Playback speed
        </label>
        <select
          id="playback-speed"
          value={state.speed}
          onChange={(e) => clock.setSpeed(Number(e.target.value))}
          disabled={!ready}
          title="Simulated working time per second"
          className="h-7 shrink-0 rounded-token border border-line bg-panel px-1 text-xs"
        >
          {SPEEDS.map((s, i) => (
            <option key={s.label} value={i} label={SHORT_SPEED[s.unit]}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          ref={slider}
          type="range"
          min={0}
          max={H ?? 0}
          step="any"
          defaultValue={0}
          disabled={!ready}
          aria-label="Simulated time"
          aria-keyshortcuts="Space ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight PageUp PageDown Home End"
          title="Arrows: an hour (Shift: a day) · Page Up/Down: a week · Space: play/pause"
          onInput={(e) => {
            clock.pause();
            clock.seek(Number(e.currentTarget.value));
          }}
          className="h-6 min-w-32 flex-1 accent-accent"
        />
        {/* The time is read aloud by the scrubber; the run is said on its tooltip, and to a screen reader below. */}
        <span ref={time} className={`shrink-0 font-mono whitespace-nowrap text-fg tabular-nums ${ready ? "" : "hidden"}`} title={`${runText}. ${runTitle}`} aria-hidden data-playback-time />
        <span className={ready ? "sr-only" : "shrink-0 whitespace-nowrap text-fg-3"} title={runTitle} data-playback-run>
          {runText}
        </span>
        <p ref={status} role="status" className="sr-only" />
      </div>
    );
  return (
    <div
      role="group"
      aria-label="Playback"
      onKeyDown={onKeyDown}
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${docked ? "" : "rounded-token border border-line bg-panel/95 p-1.5 shadow-token"}`}
    >
      <button
        type="button"
        onClick={() => clock.toggle()}
        disabled={!ready}
        aria-label={playLabel}
        aria-keyshortcuts="Space"
        title={`${playLabel} (Space)`}
        className={`${button} w-20 font-semibold ${state.playing ? "!border-accent !bg-accent-soft" : ""}`}
      >
        <span aria-hidden>{state.playing ? "❚❚" : "▶"}</span> {playLabel}
      </button>
      <button
        type="button"
        onClick={() => clock.stop()}
        disabled={!ready || !state.active}
        aria-label="Stop"
        data-playback-stop
        title="Stop playback and go back to the map"
        className={`${button} inline-flex items-center gap-1 font-semibold`}
      >
        <Square aria-hidden className="size-3 fill-current" /> Stop
      </button>
      <label className="sr-only" htmlFor="playback-speed">
        Playback speed
      </label>
      <select
        id="playback-speed"
        value={state.speed}
        onChange={(e) => clock.setSpeed(Number(e.target.value))}
        disabled={!ready}
        title="Simulated working time per second"
        className="rounded-token border border-line bg-panel px-1.5 py-1"
      >
        {SPEEDS.map((s, i) => (
          <option key={s.label} value={i}>
            {s.label}
          </option>
        ))}
      </select>
      <input
        ref={slider}
        type="range"
        min={0}
        max={H ?? 0}
        step="any"
        defaultValue={0}
        disabled={!ready}
        aria-label="Simulated time"
        aria-keyshortcuts="Space ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight PageUp PageDown Home End"
        title="Arrows: an hour (Shift: a day) · Page Up/Down: a week · Space: play/pause"
        onInput={(e) => {
          clock.pause();
          clock.seek(Number(e.currentTarget.value));
        }}
        className="h-6 min-w-40 flex-1 accent-accent"
      />
      <span ref={time} className="min-w-44 font-mono text-fg tabular-nums" aria-hidden />
      <span
        className="text-fg-3"
        title={runTitle}
      >
        {runText}
      </span>
      <p ref={status} role="status" className="sr-only" />
    </div>
  );
}
