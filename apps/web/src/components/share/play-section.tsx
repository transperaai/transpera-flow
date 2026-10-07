"use client";

// "Try your own changes" on a play link's process page (issue #33, B4). The visitor moves the levers the workspace shows
// (Settings → Levers) and sees what would change, in their browser, on the redacted copy: nothing is saved, and reloading puts
// everything back. They can send what they tried to the team ("Send this idea"); it arrives in the workspace's Suggestions.
// No state is kept anywhere but React's: no localStorage, no sessionStorage, no URL, no cookie.

import { useCallback, useMemo, useState } from "react";
import type { ProcessBundle } from "@transpera-flow/db";
import type { EngineModel, ScenarioPatch } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { ScenarioPanel } from "@/components/scenario-panel";
import { SendIdea, type PlayIssue } from "@/components/share/send-idea";
import { Button } from "@/components/ui/button";
import { buildLevers } from "@/lib/scenarios/levers";
import { visibleLevers } from "@/lib/scenarios/lever-catalogue";
import type { SimRun } from "@/lib/sim/client";
import type { PlayIdeaInput, PlayResult } from "@/lib/share/play-input";

/** What the visitor's page gives the process page for play mode. */
export interface PlayConfig {
  /** The lever kinds the workspace hides, as frozen in the link. */
  hiddenLevers: readonly string[];
  /** The process's open issues from the snapshot, for "What it should fix". */
  issues: PlayIssue[];
  workspaceName: string;
  /** The link shows names or costs, so the visitor signed in and their verified address is the one the team sees. */
  restricted: boolean;
  /** That verified address (read only), when the visitor is signed in on a restricted link. */
  visitorEmail: string | null;
  /** The people toggle of the link: a person's hours may be sent. */
  showPeople: boolean;
  /** Sends the idea (the Server Action, or a test's stub). */
  submit: (input: PlayIdeaInput) => Promise<PlayResult>;
}

/** The (i) texts: what each part does, in plain words, with an example. */
export const PLAY_HELP = {
  section: {
    label: "Try your own changes",
    description: "Moving a lever changes the numbers on this page only, in your browser. Reloading the page puts everything back.",
    example: "Try 12 leads a week and see how long they wait.",
  },
  send: {
    label: "Send this idea",
    description: "Sends the levers you moved to the team, with your name and a note. Nothing changes for them unless they build it.",
    example: "You moved Strategist to 3 people and send it as “One more strategist”.",
  },
} as const;

export function PlaySection({ model, baseline, bundle, play }: { model: EngineModel; baseline: SimRun | null; bundle: ProcessBundle; play: PlayConfig }) {
  const [patches, setPatches] = useState<ScenarioPatch[]>([]);
  const [sending, setSending] = useState(false);
  const onLeversChange = useCallback((p: ScenarioPatch[]) => setPatches(p), []);
  // Are there any levers to move? The workspace may have switched every kind off.
  const shown = useMemo(() => visibleLevers(buildLevers(model, bundle.viewer, true), play.hiddenLevers).length, [model, bundle.viewer, play.hiddenLevers]);
  const moved = patches.length > 0;

  return (
    <div className="flex flex-col gap-3" data-play-section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-2" data-play-note>
          {shown === 0 ? "The team hasn't shown any levers on this page." : "Move a lever to see what would change. Nothing is saved unless you send it to the team."}
        </p>
        <span className="inline-flex items-center">
          <Button type="button" disabled={!moved} title={moved ? undefined : "Move at least one lever first."} onClick={() => setSending(true)} data-play-send>
            Send this idea
          </Button>
          <Help {...PLAY_HELP.send} />
        </span>
      </div>
      {shown > 0 && (
        <ScenarioPanel
          model={model}
          baseline={baseline}
          currency={bundle.workspace.settings.currency}
          workspaceId={bundle.workspace.id}
          initialScenarios={[]}
          mode="share"
          hiddenLevers={play.hiddenLevers}
          viewer={bundle.viewer}
          library={false}
          clampToCaps
          onLeversChange={onLeversChange}
        />
      )}
      {sending && <SendIdea bundle={bundle} play={play} patches={patches} onClose={() => setSending(false)} />}
    </div>
  );
}
