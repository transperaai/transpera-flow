// Sample files for the demo's Historical data page (issue #40, C1): one for each kind, for Northbeam (the public demo's workspace).
// Deterministic: the same text every time. Where an earlier sample covers the kind, it is reused under another export's headers:
//   deals       the step log's rows under CRM headers, with two stages named as a CRM would ("Qualified lead", "Proposal sent"), so
//               matching names to the model has something to do;
//   time logs   about 300 time entries over Northbeam's task steps;
//   jobs        the servicing log under helpdesk headers;
//   leads       about 200 over 16 weeks across Northbeam's lead sources, plus one the model doesn't have;
//   invoices    about 150.
// The names in the people and client columns are made up.

import type { ImportKind } from "@transpera-flow/db/csv-import";
import { SAMPLE_AS_OF, northbeamSampleClients, northbeamSampleServicingLog } from "./client-sample";
import { northbeamSampleLog } from "./sample";

const DAY = 86_400_000;
const date = (t: number) => new Date(t).toISOString().slice(0, 10);

const rowsOf = (csv: string): string[][] =>
  csv
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.split(","));

/** Northbeam's step log under a CRM's headers: one row for each stage a deal entered. */
export function northbeamSampleDeals(): string {
  const stage: Record<string, string> = { "Qualify lead": "Qualified lead", "Audit & proposal": "Proposal sent" };
  const lines = ["Deal,Deal Stage,Date entered stage,Date left,Original Source,Amount,Deal owner"];
  for (const [item, step, started, finished, , source] of rowsOf(northbeamSampleLog())) {
    const n = Number(item!.slice(3));
    lines.push([item, stage[step!] ?? step, started, finished, source, 2000 + (n % 9) * 450, `Sales rep ${(n % 3) + 1}`].join(","));
  }
  return lines.join("\n") + "\n";
}

/** About 300 time entries: each of 56 jobs logs time on its qualifying and discovery, and most on the audit and onboarding. */
export function northbeamSampleTimeLogs(): string {
  const start = Date.UTC(2026, 5, 1);
  const lines = ["Job,Task,Date,Hours,Person,Client"];
  for (let i = 0; i < 56; i++) {
    const job = `J-${101 + i}`;
    const day = start + i * DAY;
    const entry = (task: string, offset: number, hours: number) =>
      lines.push([job, task, date(day + offset * DAY), hours, `Team member ${(i % 4) + 1}`, `C-${String((i % 20) + 1).padStart(3, "0")}`].join(","));
    entry("Qualify lead", 0, 0.5 + (i % 3) * 0.25);
    entry("Discovery call", 1, 1 + (i % 2) * 0.5);
    if (i % 4 === 3) continue;
    entry("Audit & proposal", 2, 3 + (i % 3));
    entry("Audit & proposal", 3, 2 + (i % 2));
    if (i % 3 === 1) {
      entry("Contract & onboarding", 8, 2 + (i % 2));
      entry("Kickoff & strategy", 10, 3 + (i % 3) * 0.5);
    }
  }
  return lines.join("\n") + "\n";
}

/** The servicing log under helpdesk headers. */
export function northbeamSampleJobs(): string {
  const lines = ["Ticket ID,Type,Company,Due date,Resolved,Created"];
  rowsOf(northbeamSampleServicingLog()).forEach(([task, client, due, done], i) => lines.push([`T-${2000 + i}`, task, client, due, done, ""].join(",")));
  return lines.join("\n") + "\n";
}

/** About 200 leads over 16 weeks to the end of September 2026. */
export function northbeamSampleLeads(): string {
  const first = Date.UTC(2026, 5, 8);
  const lines = ["Lead,Date created,Lead source"];
  let n = 1000;
  for (let w = 0; w < 16; w++) {
    const week: [string, number][] = [
      ["Website enquiries", 6 + (w % 3)],
      ["Google Ads", 3 + (w % 2)],
      ["Client referrals", 2 + (w % 2 === 0 ? 0 : 1)],
      ["Podcast", w % 3 === 0 ? 1 : 0],
    ];
    for (const [source, count] of week) {
      for (let k = 0; k < count; k++) lines.push([`L-${n++}`, date(first + (w * 7 + ((k * 3 + w) % 7)) * DAY), source].join(","));
    }
  }
  return lines.join("\n") + "\n";
}

/** About 150 invoices to 40 clients over the six months to the end of September 2026, some paid late and some unpaid. */
export function northbeamSampleInvoices(): string {
  const lines = ["Invoice,Client,Date issued,Date due,Date paid,Amount"];
  const asOf = Date.parse(SAMPLE_AS_OF);
  for (let i = 0; i < 150; i++) {
    const issued = Date.UTC(2026, 3, 1) + Math.floor((i * 183) / 150) * DAY;
    const due = issued + 14 * DAY;
    const lateBy = i % 7 === 0 ? 3 + (i % 5) : i % 3 === 0 ? -2 : 0;
    const paid = due + lateBy * DAY;
    const open = i % 23 === 0 || paid > asOf;
    lines.push([`INV-${String(1000 + i)}`, `C-${String((i % 40) + 1).padStart(3, "0")}`, date(issued), date(due), open ? "" : date(paid), 900 + (i % 6) * 150].join(","));
  }
  return lines.join("\n") + "\n";
}

/** A sample for each kind. */
export function importSamples(): Record<ImportKind, { name: string; text: string }> {
  return {
    step_log: { name: "northbeam-pipeline-sample.csv", text: northbeamSampleLog() },
    deals: { name: "northbeam-deals-sample.csv", text: northbeamSampleDeals() },
    time_logs: { name: "northbeam-time-logs-sample.csv", text: northbeamSampleTimeLogs() },
    leads: { name: "northbeam-leads-sample.csv", text: northbeamSampleLeads() },
    clients: { name: "northbeam-clients-sample.csv", text: northbeamSampleClients() },
    servicing_log: { name: "northbeam-servicing-sample.csv", text: northbeamSampleServicingLog() },
    jobs: { name: "northbeam-tickets-sample.csv", text: northbeamSampleJobs() },
    invoices: { name: "northbeam-invoices-sample.csv", text: northbeamSampleInvoices() },
  };
}
