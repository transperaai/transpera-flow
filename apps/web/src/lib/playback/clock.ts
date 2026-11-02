// The playback clock: simulation time, play/pause and speed, advanced by
// wall-clock seconds from the animation loop. Framework-free, so the loop, the
// controls and the tests all drive the same object.

const WORKING_DAYS_PER_WEEK = 5;

/** Working weeks in a month for playback: a year of 52 weeks over 12 months. */
const WEEKS_PER_MONTH = 52 / 12;

/**
 * Playback speeds: how much simulated working time passes each second. A day and a week are working time (the workspace's hours per
 * week, as the scrubber counts them); a month is 52/12 working weeks.
 */
export const SPEEDS = [
  { unit: "hour", label: "1 hour per second" },
  { unit: "day", label: "1 day per second" },
  { unit: "week", label: "1 week per second" },
  { unit: "month", label: "1 month per second" },
] as const;

/** Simulated working hours per wall-clock second for a speed. */
export function speedHoursPerSecond(unit: (typeof SPEEDS)[number]["unit"], hoursPerWeek: number): number {
  switch (unit) {
    case "hour":
      return 1;
    case "day":
      return hoursPerWeek / WORKING_DAYS_PER_WEEK;
    case "week":
      return hoursPerWeek;
    case "month":
      return hoursPerWeek * WEEKS_PER_MONTH;
  }
}

/** One day per second: the nearest to the old default of two days. */
export const DEFAULT_SPEED = 1;

/** Wall-clock seconds a hop (a move with no external wait) takes along an edge, up to `maxHopHours`. */
export const HOP_SECONDS = 0.6;

/**
 * The longest hop in simulation hours: half a working day. A hop runs into the
 * first moments at the next step, so at high speeds it is kept short enough
 * not to hide the queue building there.
 */
export function maxHopHours(hoursPerWeek: number): number {
  return hoursPerWeek / WORKING_DAYS_PER_WEEK / 2;
}

/** What the controls show; a new object only when one of these changes (not on every tick). */
export interface ClockState {
  playing: boolean;
  /** Playback is showing on the map (it has been played or scrubbed and not stopped). */
  active: boolean;
  speed: number;
  /** At the end of the horizon (Play starts over). */
  atEnd: boolean;
}

export class PlaybackClock {
  private time = 0;
  private horizon: number;
  private hoursPerWeek: number;
  private state: ClockState = { playing: false, active: false, speed: DEFAULT_SPEED, atEnd: false };
  private readonly listeners = new Set<() => void>();
  private readonly timeListeners = new Set<(t: number) => void>();

  constructor({ H = 0, hoursPerWeek = 40 }: { H?: number; hoursPerWeek?: number } = {}) {
    this.horizon = Math.max(0, H);
    this.hoursPerWeek = hoursPerWeek;
  }

  get t(): number {
    return this.time;
  }

  get H(): number {
    return this.horizon;
  }

  /** Simulation hours per wall-clock second at the current speed. */
  get hoursPerSecond(): number {
    return speedHoursPerSecond(SPEEDS[this.state.speed]!.unit, this.hoursPerWeek);
  }

  /** Simulation hours a hop takes at the current speed. */
  get hop(): number {
    return Math.min(HOP_SECONDS * this.hoursPerSecond, maxHopHours(this.hoursPerWeek));
  }

  getState = (): ClockState => this.state;

  /** Coarse changes (play, pause, speed, active); for React. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Every change of time, including each tick while playing. */
  onTime(listener: (t: number) => void): () => void {
    this.timeListeners.add(listener);
    return () => this.timeListeners.delete(listener);
  }

  /** A new run: keep the time (clamped) so an edit re-runs in place. */
  configure({ H, hoursPerWeek }: { H: number; hoursPerWeek: number }): void {
    this.horizon = Math.max(0, H);
    this.hoursPerWeek = hoursPerWeek;
    this.setTime(this.time);
  }

  play(): void {
    if (this.time >= this.horizon) this.setTime(0);
    this.update({ playing: this.horizon > 0, active: true });
  }

  pause(): void {
    this.update({ playing: false });
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  /** Jump to a time (clamped to [0, H]); shows playback on the map. */
  seek(t: number): void {
    this.setTime(t);
    this.update({ active: true });
  }

  /** Move by some hours (negative: back). */
  stepBy(hours: number): void {
    this.seek(this.time + hours);
  }

  setSpeed(index: number): void {
    this.update({ speed: Math.min(SPEEDS.length - 1, Math.max(0, Math.round(index))) });
  }

  /** Leave playback: back to the start, nothing drawn on the map. */
  stop(): void {
    this.setTime(0);
    this.update({ playing: false, active: false });
  }

  /** Advance by wall-clock seconds while playing; stops at the end of the horizon. */
  advance(seconds: number): void {
    if (!this.state.playing || !(seconds > 0)) return;
    this.setTime(this.time + seconds * this.hoursPerSecond);
    if (this.time >= this.horizon) this.update({ playing: false });
  }

  private setTime(t: number): void {
    const next = Math.min(this.horizon, Math.max(0, Number.isFinite(t) ? t : 0));
    const atEnd = this.horizon > 0 && next >= this.horizon;
    const changed = next !== this.time;
    this.time = next;
    if (atEnd !== this.state.atEnd) this.update({ atEnd });
    if (changed) for (const l of this.timeListeners) l(next);
  }

  private update(patch: Partial<ClockState>): void {
    const next = { ...this.state, ...patch };
    if ((Object.keys(next) as (keyof ClockState)[]).every((k) => next[k] === this.state[k])) return;
    this.state = next;
    for (const l of this.listeners) l();
  }
}

/**
 * "Week 3 · Day 2 · 13:30": a time in working hours, with each working day
 * shown from 09:00. A time on a day boundary is the next morning, unless
 * `closing` (the end of the horizon): then it is the previous evening.
 */
export function formatSimTime(t: number, hoursPerWeek: number, closing = false): string {
  const { week, day, clock } = simTimeParts(t, hoursPerWeek, closing);
  return `Week ${week} · Day ${day} · ${clock}`;
}

export function simTimeParts(t: number, hoursPerWeek: number, closing = false): { week: number; day: number; clock: string } {
  const hoursPerDay = hoursPerWeek / WORKING_DAYS_PER_WEEK;
  const safe = Math.max(0, t);
  // Whole minutes first, so 7.9999 hours doesn't show as 16:60.
  const minutes = Math.round(safe * 60);
  const dayMinutes = Math.round(hoursPerDay * 60);
  let dayIndex = Math.floor(minutes / dayMinutes);
  let inDay = minutes - dayIndex * dayMinutes;
  if (closing && inDay === 0 && dayIndex > 0) {
    dayIndex -= 1;
    inDay = dayMinutes;
  }
  const week = Math.floor(dayIndex / WORKING_DAYS_PER_WEEK) + 1;
  const day = (dayIndex % WORKING_DAYS_PER_WEEK) + 1;
  const clockMinutes = 9 * 60 + inDay;
  const clock = `${String(Math.floor(clockMinutes / 60)).padStart(2, "0")}:${String(clockMinutes % 60).padStart(2, "0")}`;
  return { week, day, clock };
}
