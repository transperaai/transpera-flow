"use client";

// A visitor's page behind a share link (issue #32, B3): the same screens as the workspace's own, with `mode="share"`: read only,
// no server or Realtime call, no sidebar, links to other pages as plain text. The snapshot is the only data it has; what a toggle
// hides was never sent (the server built it redacted and Postgres checked it). Wording: docs/plans/b3-brief.md.

import { useMemo, useRef, type ReactNode } from "react";
import { isActiveStatus, type ShareSnapshot } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { IssuePage } from "@/components/issues/issue-page";
import { Overview } from "@/components/overview/overview";
import { ProcessPage } from "@/components/process-page";
import { PLAY_HELP, type PlayConfig } from "@/components/share/play-section";
import { submitPlayIdea } from "@/app/s/[token]/actions";
import { ShareContext } from "@/components/share/share-context";
import { ShareLinkingScope } from "@/components/share/share-linking-scope";
import { useInertLinks } from "@/components/share/inert-links";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { SolutionPage } from "@/components/solutions/solution-page";
import { processRatings, trailOf } from "@/lib/processes/rows";
import { shareDate } from "@/lib/share/format";
import type { PlayIdeaInput, PlayResult } from "@/lib/share/play-input";

export interface SharedViewData {
  snapshot: ShareSnapshot;
  /** When the copy was made (ISO). */
  snapshotAt: string;
  /** When the link stops working (ISO), or null for no end date. */
  expiresAt: string | null;
  /** `play`: a process page where the visitor can try levers and send an idea (B4). Absent: `view`. */
  mode?: "view" | "play";
  /** The link's token, which the Send action needs (the visitor already has it in the address). Play only. */
  token?: string;
  /** A restricted play link: the address the visitor signed in with, which the team sees. */
  visitorEmail?: string | null;
}

const PEOPLE_HELP = {
  label: "Team member names",
  description: "This shared view shows people as Team member 1, 2, 3 instead of their names. Pay is never shared.",
  example: "“Team member 3 is too busy” instead of “Sam Rivera is too busy”.",
} as const;
const FINANCIALS_HELP = {
  label: "Costs and margins",
  description: "This shared view hides costs, margins and overhead. Revenue is still shown.",
  example: "The cost of an issue shows —, but New MRR shows £12.4k.",
} as const;

/** Play mode applies to a process only: a play snapshot of any other kind reads as a view. */
const isPlay = (data: SharedViewData) => data.mode === "play" && data.snapshot.kind === "process";

export function SharedView({ data, submit }: { data: SharedViewData; /** Sends an idea. Defaults to the Server Action; a test passes its own. */ submit?: (input: PlayIdeaInput) => Promise<PlayResult> }) {
  const { snapshot } = data;
  const frame = useRef<HTMLDivElement>(null);
  useInertLinks(frame);
  const context = useMemo(() => ({ financials: snapshot.toggles.financials }), [snapshot.toggles.financials]);
  return (
    <ShareContext.Provider value={context}>
      <WorkspaceShell mode="share" defaultOpen={false}>
        <div ref={frame} data-share-frame data-share-kind={snapshot.kind} className="flex min-h-svh flex-col">
          <ShareBar data={data} />
          <div className="flex-1">
            <Screen snapshot={snapshot} play={isPlay(data) ? playConfig(data, submit) : undefined} />
          </div>
          <footer className="border-t px-4 py-4 text-center text-xs text-muted-foreground">Made with Transpera Flow</footer>
        </div>
      </WorkspaceShell>
    </ShareContext.Provider>
  );
}

function ShareBar({ data }: { data: SharedViewData }) {
  const { snapshot } = data;
  const play = isPlay(data);
  return (
    <header className="flex flex-col gap-1 border-b bg-background px-4 py-3 sm:px-6" data-share-bar>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="font-heading text-base font-semibold">{snapshot.workspaceName}</h1>
        <span className="text-sm font-medium text-muted-foreground" data-share-readonly={play ? undefined : ""} data-share-play-mode={play ? "" : undefined}>
          {play ? "Shared view · try changes" : "Shared view · read only"}
        </span>
        <span className="text-sm text-muted-foreground">As of {shareDate(data.snapshotAt)}</span>
        {data.expiresAt && <span className="text-sm text-muted-foreground">Link works until {shareDate(data.expiresAt)}</span>}
      </div>
      {play && (
        <p className="flex items-center text-xs text-muted-foreground" data-share-note="play">
          You can try changes here. Nothing is saved unless you send it to the team.
          <Help {...PLAY_HELP.section} />
        </p>
      )}
      {!snapshot.toggles.people && (
        <p className="flex items-center text-xs text-muted-foreground" data-share-note="people">
          People are shown as Team member 1, 2, 3.
          <Help {...PEOPLE_HELP} />
        </p>
      )}
      {!snapshot.toggles.financials && (
        <p className="flex items-center text-xs text-muted-foreground" data-share-note="financials">
          Costs, margins and overhead are hidden. Revenue is shown.
          <Help {...FINANCIALS_HELP} />
        </p>
      )}
    </header>
  );
}

/** The width and padding the workspace's own pages give an issue or a solution (`Page` without its sidebar header). */
function Column({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 px-4 pb-12 pt-6 sm:px-6">{children}</div>;
}

/** What the process page needs for play mode, from the snapshot: the kinds the workspace hides, and the process's open issues. */
function playConfig(data: SharedViewData, submit: ((input: PlayIdeaInput) => Promise<PlayResult>) | undefined): PlayConfig | undefined {
  const { snapshot } = data;
  if (snapshot.kind !== "process") return undefined;
  const processId = snapshot.bundle.process.id;
  const issues = snapshot.issues
    .filter((i) => i.number != null && i.source !== "detected" && isActiveStatus(i.status) && (i.process_id === processId || i.links.some((l) => l.process_id === processId)))
    .map((i) => ({ id: i.id, number: i.number, title: i.title }));
  return {
    hiddenLevers: snapshot.hiddenLevers ?? [],
    issues,
    workspaceName: snapshot.workspaceName,
    restricted: snapshot.toggles.people || snapshot.toggles.financials,
    visitorEmail: data.visitorEmail ?? null,
    showPeople: snapshot.toggles.people,
    submit: submit ?? ((input) => submitPlayIdea(data.token ?? "", input)),
  };
}

function Screen({ snapshot, play }: { snapshot: ShareSnapshot; play?: PlayConfig }) {
  switch (snapshot.kind) {
    case "overview":
      return (
        <ShareLinkingScope workspaceId={snapshot.live.workspace.id}>
          <Overview
            workspaceName={snapshot.workspaceName}
            live={snapshot.live}
            parts={snapshot.parts}
            company={snapshot.company}
            issues={snapshot.issues}
            sources={[]}
            mode="share"
            firstPrinciples={snapshot.firstPrinciples}
            solutions={snapshot.solutions}
            solutionBases={snapshot.solutionBases}
            hrefs={{}}
            processesHref=""
            issuesHref=""
            findings={snapshot.findings}
          />
        </ShareLinkingScope>
      );
    case "process":
      return <ProcessScreen snapshot={snapshot} play={play} />;
    case "issue": {
      const issue = snapshot.issues.find((i) => i.id === snapshot.issueId);
      if (!issue) return <Gone />;
      return (
        <Column>
          <ShareLinkingScope workspaceId={snapshot.bundle.workspace.id}>
            <IssuePage
              issue={issue}
              issues={snapshot.issues}
              bundle={snapshot.bundle}
              processes={snapshot.processes}
              sources={[]}
              events={[]}
              mode="share"
              base=""
              buildHref=""
              viewerId={null}
              liveRevisions={snapshot.liveRevisions}
              solutions={snapshot.solutions}
              memberNames={{}}
            />
          </ShareLinkingScope>
        </Column>
      );
    }
    case "solution": {
      const base = snapshot.compareBase;
      return (
        <Column>
          <ShareLinkingScope workspaceId={snapshot.bundle.workspace.id}>
            <SolutionPage
              workspaceId={snapshot.bundle.workspace.id}
              solutionId={snapshot.solutionId}
              data={snapshot.solutions}
              issues={snapshot.issues}
              processes={snapshot.processes}
              base=""
              mode="share"
              viewerId={null}
              memberNames={{}}
              compareBase={base ? { ...snapshot.bundle, revision: base.revision, steps: base.steps, edges: base.edges, retired: base.retired ?? [] } : null}
              movedOn={snapshot.movedOn}
            />
          </ShareLinkingScope>
        </Column>
      );
    }
  }
}

function ProcessScreen({ snapshot, play }: { snapshot: Extract<ShareSnapshot, { kind: "process" }>; play?: PlayConfig }) {
  const { bundle } = snapshot;
  const processes = snapshot.processes;
  const byId = new Map(processes.map((p) => [p.id, { id: p.id, name: p.name, parentId: p.parentId }]));
  const ratings = processRatings(processes, snapshot.issues, [...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((p) => p.steps)]);
  return (
    <ShareLinkingScope workspaceId={bundle.workspace.id}>
      <ProcessPage
        key={bundle.process.id}
        bundle={bundle}
        liveVersion={bundle.revision.number}
        mode="share"
        scenarios={snapshot.scenarios}
        issues={snapshot.issues}
        sources={[]}
        liveRevisions={snapshot.liveRevisions}
        rating={ratings[bundle.process.id] ?? null}
        historyHref=""
        solutions={{ data: snapshot.solutions, base: "", viewerId: null, memberNames: {} }}
        aboutInfo={{ trail: trailOf({ id: bundle.process.id, parentId: byId.get(bundle.process.id)?.parentId ?? null }, byId).map((t) => t.name), hasDraft: false, lastChange: null }}
        findings={snapshot.findings}
        firstPrinciples={{ doc: snapshot.firstPrinciples, href: "", draftChanged: false, inheritedFrom: null }}
        inside={[]}
        play={play}
      />
    </ShareLinkingScope>
  );
}

function Gone() {
  return (
    <Column>
      <p className="text-sm text-muted-foreground">This page is no longer in the shared copy.</p>
    </Column>
  );
}
