// A sample clients file and servicing log for Northbeam (the public demo's workspace), so the demo's Historical data page has
// something to read: forty clients of its two services over eighteen months, six to eight leavers a service and a few who
// came back, and its two servicing processes (the monthly report and the client check-in) for the six months to the end of
// September 2026, about 15% late and some work still open past its due date. Deterministic: the same text every time.
//
// Northbeam has no servicing process that comes in as ad-hoc requests, so the response-time check has nothing to measure on
// the demo, as in the workspace.

const DAY = 86_400_000;

/** The date the sample is true on. */
export const SAMPLE_AS_OF = "2026-09-30";

const date = (t: number) => new Date(t).toISOString().slice(0, 10);
const at = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const D = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

interface Spell {
  start: number;
  end: number | null;
}

interface SampleClient {
  id: string;
  service: string;
  spells: Spell[];
}

/** Old clients (13 a service) who were clients before the servicing log starts; the leavers among them, by position. */
const SERVICES = [
  { code: "SEO", name: "SEO retainer", leavers: [1, 3, 4, 6, 8, 10], rejoin: [1, 3] },
  { code: "PPC", name: "PPC management", leavers: [1, 2, 4, 5, 7, 9, 10, 12], rejoin: [1, 4] },
] as const;

const LOG_FROM = D(2026, 4, 1);

/** The sample's clients: 20 a service, 13 who were clients when the log starts and 7 who joined during it. */
export function sampleClients(): SampleClient[] {
  const out: SampleClient[] = [];
  for (const sv of SERVICES) {
    for (let i = 0; i < 13; i++) {
      const spells: Spell[] = [{ start: D(2025, 1, 6) + i * 21 * DAY, end: null }];
      const k = (sv.leavers as readonly number[]).indexOf(i);
      if (k >= 0) {
        spells[0]!.end = D(2025, 10, 20) + k * 38 * DAY;
        // A few come back before the servicing log starts.
        if ((sv.rejoin as readonly number[]).includes(i)) spells.push({ start: D(2026, 2, 16) + (sv.rejoin as readonly number[]).indexOf(i) * 21 * DAY, end: null });
      }
      out.push({ id: `${sv.code}-${String(i + 1).padStart(2, "0")}`, service: sv.name, spells });
    }
    for (let j = 0; j < 7; j++) out.push({ id: `${sv.code}-${String(14 + j).padStart(2, "0")}`, service: sv.name, spells: [{ start: D(2026, 4, 6) + j * 21 * DAY, end: null }] });
  }
  return out;
}

/** Every client id in the sample files (what must never be stored). */
export const sampleClientIds = (): string[] => sampleClients().map((c) => c.id);

export function northbeamSampleClients(): string {
  const lines = ["client,service,started,ended"];
  for (const c of sampleClients()) for (const s of c.spells) lines.push(`${c.id},${c.service},${date(s.start)},${s.end === null ? "" : date(s.end)}`);
  return lines.join("\n") + "\n";
}

const activeAt = (c: SampleClient, t: number) => c.spells.some((s) => s.start <= t && (s.end === null || s.end > t));

export function northbeamSampleServicingLog(): string {
  const asOf = Date.parse(SAMPLE_AS_OF);
  const lines = ["task,client,due,done"];
  const clients = sampleClients();
  clients.forEach((c, idx) => {
    // Each client's first check-in, a week after joining: the onboarding speed.
    const joined = c.spells[0]!.start;
    if (joined >= LOG_FROM) lines.push(`Client check-in,${c.id},${date(joined + 7 * DAY)},${at(joined + (3 + (idx % 5)) * DAY + 15 * 3_600_000)}`);
    for (let m = 4; m <= 9; m++) {
      const report = D(2026, m, 5);
      if (activeAt(c, report) && report > joined + 14 * DAY) {
        const late = (idx * 7 + m * 3) % 7 === 0;
        const open = m >= 8 && (idx + m) % 19 === 0;
        const done = open ? "" : at(report + (late ? (2 + (idx % 3)) * DAY + 11 * 3_600_000 : 17 * 3_600_000 - (idx % 3) * DAY));
        lines.push(`Monthly report,${c.id},${date(report)},${done}`);
      }
      const checkin = D(2026, m, 15) + 17 * 3_600_000;
      if (activeAt(c, checkin) && checkin <= asOf && checkin > joined + 14 * DAY) {
        const late = (idx * 5 + m) % 8 === 0;
        const open = m === 9 && idx % 11 === 0;
        lines.push(`Client check-in,${c.id},${at(checkin)},${open ? "" : at(checkin - 3 * 3_600_000 + (late ? (1 + (idx % 2)) * DAY : 0))}`);
      }
    }
  });
  return lines.join("\n") + "\n";
}
