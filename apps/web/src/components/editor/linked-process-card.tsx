"use client";

// A step that already holds another process (editor brainstorm, item 3). The Editor makes no new links, but the old ones stay visible and
// can be turned into steps: "Turn into steps" copies the process's steps in, to change freely, and cuts the link.

import { Button } from "@/components/ui/button";

export function LinkedProcessCard({
  name,
  onTurnInto,
  problem,
  said,
}: {
  /** The linked process's name (the step is named after it). */
  name: string;
  onTurnInto: () => void;
  /** Why it can't be turned into steps now (no published version yet, say); null when it can. */
  problem: string | null;
  /** What the last press of the button said, when it didn't work. */
  said: string | null;
}) {
  return (
    <section aria-label="Linked process" data-linked-card className="flex flex-col gap-2 rounded-token border border-line bg-panel-2 p-2.5 text-xs">
      <p className="font-semibold text-fg">Linked process: changes when &lsquo;{name}&rsquo; changes</p>
      <p className="text-fg-2">
        This step stands for another process, with its own page and versions. The Editor doesn&apos;t make new links. Turn it into steps to copy that
        process&apos;s steps in here, where they are yours to change; the link is cut.
      </p>
      <Button type="button" variant="outline" size="sm" className="self-start" data-turn-into-steps disabled={!!problem} title={problem ?? undefined} onClick={onTurnInto}>
        Turn into steps
      </Button>
      {problem && <p className="text-fg-2">{problem}</p>}
      {said && !problem && (
        <p role="alert" className="text-crit">
          {said}
        </p>
      )}
    </section>
  );
}
