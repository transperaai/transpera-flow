"use client";

// Settings -> AI analysis (issue #111, A46; prototype: Settings -> AI analysis). Five switches, each with an (i) saying
// what it does with an example. They save as you flip them, one switch at a time, per workspace; the public demo keeps
// them in this tab. Reading sources is off until someone turns it on, because it sends quotes to the AI company.

import { useRef, useState } from "react";
import type { AiSettings } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Page } from "@/components/shell/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { AI_NOT_SET_UP } from "@/lib/ai/types";
import { AI_SWITCHES } from "@/lib/ai/switches";
import { cn } from "@/lib/utils";
import { saveAiSwitch } from "@/app/w/[slug]/settings/ai/actions";

export type AiSettingsMode = "live" | "readonly" | "demo";

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

export function AiSettingsPage({ mode, workspaceId, initial, configured }: { mode: AiSettingsMode; workspaceId: string | null; initial: AiSettings; configured: boolean }) {
  const canEdit = mode !== "readonly";
  const [values, setValues] = useState<AiSettings>(initial);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  // Switches flipped one after another save in order, so the last flip wins.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const flip = (key: keyof AiSettings, on: boolean) => {
    const before = values[key];
    setValues((v) => ({ ...v, [key]: on }));
    if (mode !== "live" || !workspaceId) return;
    setState({ kind: "saving" });
    queue.current = queue.current.then(async () => {
      try {
        const out = await saveAiSwitch(workspaceId, key, on);
        if (out.status === "saved") setState({ kind: "saved" });
        else {
          setValues((v) => ({ ...v, [key]: before }));
          setState({ kind: "error", message: out.message });
        }
      } catch {
        setValues((v) => ({ ...v, [key]: before }));
        setState({ kind: "error", message: "Couldn't save. Check your connection and try again." });
      }
    });
  };

  return (
    <Page
      title="AI analysis"
      eyebrow="Settings"
      description="Runs when you press Analyse on a process or on the Overview. It reads the facts from the simulation, each process's first principles and your sources, and proposes findings for you to accept or dismiss. It never invents numbers: every figure it uses comes from the simulation."
      actions={<SaveStatus state={state} mode={mode} />}
    >
      {mode === "readonly" && (
        <p role="note" className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          Only owners and editors can change these. You can see them here.
        </p>
      )}
      {mode === "demo" && (
        <p role="note" className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          Demo mode: the switches stay in this tab, gone when you reload. The AI text in the demo is written in advance; nothing here calls an AI.
        </p>
      )}
      {!configured && mode !== "demo" && (
        <p role="note" data-ai-not-set-up className="rounded-lg border border-warn bg-warn-soft px-3 py-2 text-sm">
          {AI_NOT_SET_UP}: this server has no Anthropic API key. The switches are saved, and take effect once an administrator adds one.
        </p>
      )}

      <Card>
        <CardContent className="flex flex-col gap-4">
          {AI_SWITCHES.map((s) => (
            <div key={s.key} data-ai-switch={s.key} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2 text-sm">
                {/* The switch is named by the visible text, so the two never differ. */}
                <label className="flex items-center gap-2">
                  <Switch checked={values[s.key]} disabled={!canEdit} onCheckedChange={(on) => flip(s.key, on)} />
                  <span className={cn("font-medium", !values[s.key] && "text-muted-foreground")}>{s.label}</span>
                </label>
                <Help label={s.label} description={s.description} example={s.example} />
                {s.later && <Badge variant="outline">Coming soon</Badge>}
              </div>
              {s.later && <p className="pl-10 text-xs text-muted-foreground">Saved now. It does nothing until the page it feeds arrives.</p>}
              {s.key === "read_sources" && <p className="pl-10 text-xs text-muted-foreground">Sends short quotes from your sources to Anthropic. Off until you turn it on.</p>}
            </div>
          ))}
        </CardContent>
      </Card>
    </Page>
  );
}

function SaveStatus({ state, mode }: { state: SaveState; mode: AiSettingsMode }) {
  if (mode !== "live") return null;
  const text = state.kind === "saving" ? "Saving…" : state.kind === "saved" ? "Saved" : state.kind === "error" ? state.message : "";
  if (!text) return null;
  return (
    <span role="status" className={cn("text-xs", state.kind === "error" ? "text-destructive" : "text-muted-foreground")}>
      {text}
    </span>
  );
}
