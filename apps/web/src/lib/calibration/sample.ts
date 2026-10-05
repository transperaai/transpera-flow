// A sample step log for Northbeam's pipeline (the public demo's process), so the demo's Calibration page has something
// to read: fifty-six leads over eight weeks (about Northbeam's seven qualified a week), with hands-on hours, the client's decision time, redone audits and which way
// each lead went. Deterministic: the same text every time.

const DAY = 86_400_000;
const START = Date.UTC(2026, 5, 1, 9); // Monday 1 June 2026, 09:00

const at = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const hours = (i: number, base: number, spread: number) => Math.round((base + (((i * 7) % 5) - 2) * spread) * 4) / 4;

export function northbeamSampleLog(): string {
  const lines = ["item,step,started,finished,hours,source"];
  const sources = ["Website enquiries", "Google Ads", "Client referrals", "Website enquiries", "Client referrals", "Google Ads", "Client referrals"];
  for (let i = 0; i < 56; i++) {
    const item = `NB-${String(101 + i)}`;
    let t = START + i * DAY + (i % 3) * 3_600_000;
    const step = (name: string, h: number | null, waitDays = 0) => {
      const done = t + (h ?? 0) * 3_600_000 + waitDays * DAY;
      lines.push(`${item},${name},${at(t)},${at(done)},${h ?? ""},${name === "Qualify lead" ? sources[i % 7] : ""}`);
      t = done + DAY;
    };
    step("Qualify lead", hours(i, 0.75, 0.25));
    if (i % 5 === 4 || i % 7 === 6) {
      step("Lost", null);
      continue;
    }
    step("Discovery call", hours(i, 1.5, 0.25));
    if (i % 4 === 3) {
      step("Lost", null);
      continue;
    }
    step("Audit & proposal", hours(i, 7, 1));
    if (i % 6 === 0) step("Audit & proposal", hours(i, 2, 0.5));
    step("Client decision", null, 3 + (i % 4));
    if (i % 3 === 1) {
      step("Contract & onboarding", hours(i, 3, 0.5));
      step("Kickoff & strategy", hours(i, 4, 0.5));
    } else step("Lost", null);
  }
  return lines.join("\n") + "\n";
}
