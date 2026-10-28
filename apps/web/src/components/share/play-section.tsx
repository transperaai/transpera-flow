"use client";

// "Try your own changes" on a play link's process page (issue #33, B4). The visitor moves the levers the workspace shows
// (Settings → Levers) and sees what would change, in their browser, on the redacted copy: nothing is saved, and reloading puts
// everything back. There is no way to send it back to the team.
// No state is kept anywhere but React's: no localStorage, no sessionStorage, no URL, no cookie.

import { useMemo } from "react";
import type { ProcessBundle } from "@transpera-flow/db";
import type { EngineModel } from "@transpera-flow/engine";
import { ScenarioPanel } from "@/components/scenario-panel";
import { buildLevers } from "@/lib/scenarios/levers";
import { visibleLevers } from "@/lib/scenarios/lever-catalogue";
import type { SimRun } from "@/lib/sim/client";

/** What the visitor's page gives the process page for play mode. */
export interface PlayConfig {
  /** The lever kinds the workspace hides, as frozen in the link. */
  hiddenLevers: readonly string[];
}

/** The (i) texts: what each part does, in plain words, with an example. */
export const PLAY_HELP = {
  section: {
    label: "Try your own changes",
    description: "Moving a lever changes the numbers on this page only, in your browser. Reloading the page puts everything back.",
    example: "Try 12 leads a week and see how long they wait.",
  },
} as const;

export function PlaySection({ model, baseline, bundle, play }: { model: EngineModel; baseline: SimRun | null; bundle: ProcessBundle; play: PlayConfig }) {
  // Are there any levers to move? The workspace may have switched every kind off.
  const shown = useMemo(() => visibleLevers(buildLevers(model, bundle.viewer), play.hiddenLevers).length, [model, bundle.viewer, play.hiddenLevers]);

  return (
    <div className="flex flex-col gap-3" data-play-section>
      <p className="text-sm text-fg-2" data-play-note>
        {shown === 0 ? "The team hasn't shown any levers on this page." : "Move a lever to see what would change. Nothing is saved."}
      </p>
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
        />
      )}
    </div>
  );
}
