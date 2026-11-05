// The Issues list on a bare page, for ../issues-list-browser.test.ts: the real page component with the Northbeam fixture's process and
// its three issues, plus six more in the wording of the preview's example issues (Q6), so the list has every status, several owners, an
// unowned issue and two processes. Next's modules are stood in for by ../build-harness.ts (the URL is kept in `window.__harnessUrl`);
// the cost worker is stood in for by one that never answers, so costs stay absent. Nothing here ships.

import { createRoot } from "react-dom/client";
import { northbeamBundle, northbeamIssues, northbeamPersonIds, northbeamStepIds, type IssueRow } from "@transpera-flow/db";
import { IssuesPage } from "@/components/issues-page";
import { setHarnessUrl } from "../build-harness-stubs/navigation-url";

declare global {
  interface Window {
    mountIssues: (opts?: { canEdit?: boolean; url?: string }) => void;
    __harnessUrl?: string;
  }
}

window.Worker = class {
  postMessage() {}
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
  onmessage = null;
  onerror = null;
} as unknown as typeof Worker;

const bundle = northbeamBundle();
const SECOND = "50000000-0000-4000-8000-000000000002";
const processes = [
  { id: bundle.process.id, name: bundle.process.name },
  { id: SECOND, name: "Monthly reporting" },
];

const issues: IssueRow[] = northbeamIssues();
const template = issues[0]!;
const owner = (name: string) => northbeamPersonIds[name]!;

interface Extra {
  title: string;
  severity: IssueRow["severity"];
  status: IssueRow["status"];
  owners: string[];
  process?: string;
  step?: string | null;
}

const extras: Extra[] = [
  { title: "Pacing lives in three places", severity: "serious", status: "open", owners: ["Priya Shah"], process: SECOND },
  { title: "Link team runs near its line", severity: "warning", status: "testing", owners: ["Rosa Diaz", "Priya Shah"] },
  { title: "Meeting prep is data hunting", severity: "warning", status: "resolved", owners: ["Maya Collins"], process: SECOND },
  { title: "Only Karl can vet link domains", severity: "critical", status: "open", owners: [] },
  { title: "Ad QA repeats checks done at build", severity: "info", status: "wont_fix", owners: ["Maya Collins"] },
  { title: "Monthly plans wait on client approval", severity: "serious", status: "open", owners: [], process: SECOND },
];

extras.forEach((e, k) => {
  const n = issues.length + 1;
  const process_id = e.process ?? bundle.process.id;
  issues.push({
    ...template,
    id: `40000000-0000-4000-8000-${String(100 + k).padStart(12, "0")}`,
    number: n,
    title: e.title,
    severity: e.severity,
    status: e.status,
    type: "manual",
    detected_key: null,
    process_id,
    step_id: e.process ? null : northbeamStepIds.audit,
    links: [{ process_id, step_id: e.process ? null : northbeamStepIds.audit }],
    owner_ids: e.owners.map(owner),
    owner_person_id: e.owners[0] ? owner(e.owners[0]) : null,
    target_measure: null,
    target_now: null,
    target_goal: null,
    source_ids: [],
    resolved_at: e.status === "resolved" || e.status === "wont_fix" ? "2026-10-20T09:00:00Z" : null,
    resolved_how: e.status === "resolved" ? "process_change" : null,
  });
});

let root: ReturnType<typeof createRoot> | null = null;
window.mountIssues = (opts = {}) => {
  setHarnessUrl(opts.url ?? "/w/demo/issues");
  root?.unmount();
  const el = document.getElementById("root")!;
  root = createRoot(el);
  root.render(<IssuesPage bundle={bundle} issues={issues} scenarios={[]} processes={processes} sources={[]} mode={opts.canEdit === false ? "readonly" : "live"} base="/w/demo" />);
};
