// A share link's page (issue #32, B3) on a bare page, for ../share-browser.test.ts: the real SharedView for each kind of snapshot,
// built from the Northbeam fixture by the real `redactShareSnapshot`, with its simulations in real Web Workers; and the real
// ShareDialog with its Server Action stood in for. Next's modules and Server Actions are stood in for by ../build-harness.ts.
// Nothing here ships.

import { createRoot, type Root } from "react-dom/client";
import {
  SHARE_SNAPSHOT_VERSION,
  northbeamIssues,
  partOf,
  redactShareSnapshot,
  type IssueRow,
  type ProcessBundle,
  type ShareKind,
  type ShareSecrets,
  type ShareSnapshot,
  type ShareToggles,
  type SolutionRow,
} from "@transpera-flow/db";
import { ShareButton } from "@/components/share/share-dialog";
import { ShareLinksTable } from "@/components/share/share-links-table";
import { SharedView } from "@/components/share/shared-view";
import type { ShareInput } from "@/lib/share/input";
import type { ShareLinkRow } from "@/lib/share/list";
import { solutionCopy } from "@/lib/solutions/bundle";
import { demoBundle } from "@/lib/sources/demo";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    workerPosts: string[];
    mountShare: (kind: ShareKind, toggles: ShareToggles) => { clientNames: string[]; personNames: string[]; personFirst: string[] };
    unmountShare: () => void;
    /** The Share dialog, with its Server Action stood in for: what it asked to make, and what to answer. */
    mountShareDialog: () => void;
    shareCreates: ShareInput[];
    shareAnswer: { status: "ok"; url?: string } | { status: "error"; message: string };
    /** The Share links table, with its actions stood in for: the ids it asked to update and to turn off. */
    mountShareList: (links: ShareLinkRow[]) => void;
    shareRefreshes: string[];
    shareRevokes: string[];
  }
}

const NativeWorker = window.Worker;
window.workerPosts = [];
window.Worker = class extends NativeWorker {
  private readonly file: string;
  constructor(url: string | URL) {
    const file = String(url).split("/").pop()!;
    const script = window.workerScripts[file];
    if (!script) throw new Error(`No bundled worker for ${file}`);
    super(URL.createObjectURL(new Blob([script], { type: "text/javascript" })));
    this.file = file;
  }
  postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
    window.workerPosts.push(this.file);
    super.postMessage(message, options as StructuredSerializeOptions);
  }
} as typeof Worker;

/** The editor's real bundle: names, pay rates and notes on people, notes on clients, role rates, margins and overhead. */
function editorBundle(): ProcessBundle {
  const b = structuredClone(demoBundle());
  b.people = b.people.map((p, i) => ({ ...p, cost_rate: 40 + i, email: `${p.name.split(" ")[0]!.toLowerCase()}@northbeam.example`, notes: `Private note about ${p.name}` }) as never);
  b.clients = (b.clients ?? []).map((c) => ({ ...c, notes: `Renewal talk with ${c.name}` }));
  b.roles = b.roles.map((r) => ({ ...r, default_cost_rate: r.default_cost_rate || 55 }));
  b.services = b.services.map((s) => ({ ...s, margin: 0.3 }));
  b.workspace = { ...b.workspace, settings: { ...b.workspace.settings, overhead_monthly: 9000, target_margin: 0.25 } as never };
  return b;
}

function snapshotOf(kind: ShareKind, toggles: ShareToggles): { snapshot: ShareSnapshot; secrets: ShareSecrets } {
  const live = editorBundle();
  const secrets: ShareSecrets = {
    people: live.people.map((p, i) => ({ id: p.id, name: p.name, label: `Team member ${i + 1}` })),
    clients: (live.clients ?? []).map((c, i) => ({ id: c.id, name: c.name, label: `Client ${i + 1}` })),
  };
  const person = live.people[0]!;
  const client = live.clients![0]!;
  // A solution (a copy of the pipeline with one task made quicker) and an issue about it, naming a person, a client and money.
  const copy = solutionCopy(live);
  const target = copy.steps.find((s) => s.kind === "task" && Number(s.work_hours) > 1)!;
  target.work_hours = 0.1 as never;
  const solution: SolutionRow = {
    id: "00000000-0000-4000-8000-0000000000a1",
    workspace_id: live.workspace.id,
    process_id: live.process.id,
    base_revision_id: live.revision.id,
    name: "Faster audits",
    notes: `${person.name} will own it; budget £9,000 for ${client.name}.`,
    steps: copy,
    changed_step_ids: [target.id],
    lever_changes: [],
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    created_by: null,
  };
  const issue: IssueRow = {
    ...northbeamIssues()[0]!,
    id: "00000000-0000-4000-8000-0000000000a2",
    workspace_id: live.workspace.id,
    number: 7,
    title: `Audits take too long for ${client.name}`,
    evidence: `${person.name} says it costs about £4,100 a month. Mail ${person.name.split(" ")[0]!.toLowerCase()}@northbeam.example.`,
    process_id: live.process.id,
    step_id: target.id,
    links: [],
    status: "open",
    detected_key: null,
  };
  const solutions = { solutions: [solution], links: [{ solution_id: solution.id, issue_id: issue.id, workspace_id: live.workspace.id, auto_verdict: null, holds_pct: null, auto_note: "", user_verdict: null, user_notes: "", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", created_by: null }] };
  const base = { v: SHARE_SNAPSHOT_VERSION, toggles, workspaceName: live.workspace.name } as const;
  const issues = [issue, ...northbeamIssues().slice(1)];
  const processes = [live, ...(live.otherProcesses ?? [])].map((b) => ("process" in b ? b.process : b)).map((p) => ({ id: p.id, name: p.name, parentId: null, kind: p.kind }));
  let raw: ShareSnapshot;
  switch (kind) {
    case "overview":
      raw = { ...base, kind, live, parts: [partOf(live), ...(live.otherProcesses ?? [])], company: null, issues, solutions, solutionBases: {}, findings: [], firstPrinciples: null };
      break;
    case "process":
      raw = { ...base, kind, bundle: live, hiddenLevers: ["process.rework"], processes, scenarios: [], issues, liveRevisions: { [live.process.id]: live.revision.id }, solutions, findings: [], firstPrinciples: null };
      break;
    case "issue":
      raw = { ...base, kind, issueId: issue.id, bundle: live, issues, processes: processes.map(({ id, name }) => ({ id, name })), liveRevisions: { [live.process.id]: live.revision.id }, solutions };
      break;
    case "solution":
      raw = {
        ...base,
        kind,
        solutionId: solution.id,
        bundle: live,
        solutions,
        issues,
        processes: processes.map(({ id, name }) => ({ id, name })),
        compareBase: { revision: live.revision, steps: live.steps, edges: live.edges },
        movedOn: null,
      };
      break;
  }
  return { snapshot: redactShareSnapshot(raw, toggles, secrets), secrets };
}

let root: Root | null = null;
window.mountShare = (kind, toggles) => {
  const { snapshot, secrets } = snapshotOf(kind, toggles);
  root = createRoot(document.getElementById("root")!);
  root.render(<SharedView data={{ snapshot, snapshotAt: "2026-10-05T09:00:00Z", expiresAt: toggles.people || toggles.financials ? "2026-11-05T23:59:59Z" : null }} />);
  return {
    clientNames: secrets.clients.map((c) => c.name),
    personNames: secrets.people.map((p) => p.name),
    personFirst: [...new Set(secrets.people.map((p) => p.name.split(" ")[0]!))],
  };
};
window.unmountShare = () => root?.unmount();

window.shareCreates = [];
window.shareAnswer = { status: "ok", url: "https://flow.example/s/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde" };
window.mountShareDialog = () => {
  root = createRoot(document.getElementById("root")!);
  root.render(
    <ShareButton
      slug="northbeam"
      kind="process"
      targetId="00000000-0000-4000-8000-0000000000c1"
      what="Lead to live"
      create={async (input) => {
        window.shareCreates.push(input);
        return window.shareAnswer;
      }}
    />,
  );
};
window.shareRefreshes = [];
window.shareRevokes = [];
window.mountShareList = (links) => {
  root = createRoot(document.getElementById("root")!);
  root.render(
    <ShareLinksTable
      slug="northbeam"
      links={links}
      refresh={async (id) => {
        window.shareRefreshes.push(id);
        return { status: "ok" };
      }}
      revoke={async (id) => {
        window.shareRevokes.push(id);
        return { status: "ok" };
      }}
    />,
  );
};
