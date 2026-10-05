"use client";

// Settings -> Levers (issue #123; prototype: Settings -> Levers). Every input you can change when testing, in six
// groups, each with a show/hide switch and an (i) saying what it is, with an example. A lever that is switched off
// has no slider on process pages and isn't offered in the Editor. Changes save as you go, per workspace; the
// public demo keeps them in this tab.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LeverSettings } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Page } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { GROUP_LABELS, LEVER_GROUP_ORDER, cleanHidden, kindsOf, type LeverKind } from "@/lib/scenarios/lever-catalogue";
import { getDemoHiddenLevers, setDemoHiddenLevers } from "@/lib/levers/demo-store";
import { cn } from "@/lib/utils";
import { saveLevers } from "@/app/w/[slug]/settings/levers/actions";

export type LeversMode = "live" | "readonly" | "demo";

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string } | { kind: "conflict"; theirs: LeverSettings };

const SAVE_DELAY_MS = 400;

const CONTROL_NOTE: Record<LeverKind["control"], string> = {
  slider: "Slider on process pages",
  settings: "Set in Settings",
  later: "No slider yet. Hiding this has no effect yet.",
};

export function LeversSettings({
  mode,
  workspaceId,
  initial,
  settingsBase,
}: {
  mode: LeversMode;
  workspaceId: string | null;
  initial: LeverSettings;
  /** Where the workspace's Settings page is, so a lever set elsewhere can link there; omitted on the demo. */
  settingsBase?: string;
}) {
  const canEdit = mode !== "readonly";
  const [hidden, setHidden] = useState<string[]>(() => (mode === "demo" ? getDemoHiddenLevers() : initial.hidden));
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const version = useRef(initial.version);
  const latest = useRef(hidden);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const dirty = useRef(false);

  // Saves what is pending, one request at a time; switches flipped while one is running go in the next.
  const flush = useCallback(async () => {
    if (inFlight.current || !workspaceId) return;
    inFlight.current = true;
    try {
      while (dirty.current) {
        dirty.current = false;
        setState({ kind: "saving" });
        try {
          const out = await saveLevers(workspaceId, latest.current, version.current);
          if (out.status === "saved") {
            version.current = out.settings.version;
            setState(dirty.current ? { kind: "saving" } : { kind: "saved" });
          } else if (out.status === "conflict") {
            dirty.current = false;
            setState({ kind: "conflict", theirs: out.settings });
          } else setState({ kind: "error", message: out.message });
        } catch {
          setState({ kind: "error", message: "Couldn't save. Check your connection and try again." });
        }
      }
    } finally {
      inFlight.current = false;
    }
  }, [workspaceId]);

  const update = useCallback(
    (next: string[]) => {
      latest.current = next;
      setHidden(next);
      if (mode === "demo") return setDemoHiddenLevers(next);
      if (mode !== "live") return;
      dirty.current = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [mode, flush],
  );

  useEffect(
    () => () => {
      // Leaving the page: save what is pending rather than drop it.
      if (timer.current) {
        clearTimeout(timer.current);
        void flush();
      }
    },
    [flush],
  );

  const setShown = (id: string, shown: boolean) => update(cleanHidden(shown ? hidden.filter((h) => h !== id) : [...hidden, id]));

  return (
    <Page
      title="Levers"
      eyebrow="Settings"
      description="Every input you can change when testing. Your choices are saved, but no page shows lever sliders at the moment: process pages no longer do, and the Overview has no what-if controls."
      actions={
        <>
          <SaveStatus state={state} mode={mode} />
          <Button variant="outline" size="sm" disabled={!canEdit || hidden.length === 0} onClick={() => update([])}>
            Show all
          </Button>
        </>
      }
    >
      {mode === "readonly" && (
        <p role="note" className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          Only owners and editors can change which levers show. You can see them here.
        </p>
      )}
      {mode === "demo" && (
        <p role="note" className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          Demo mode: switching a lever off takes its sliders off the demo&apos;s process page. It stays in this tab, gone when you reload.
        </p>
      )}
      {state.kind === "conflict" && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warn bg-warn-soft px-3 py-2 text-sm">
          <span>Someone else changed which levers show while you were editing.</span>
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (timer.current) clearTimeout(timer.current);
                timer.current = null;
                dirty.current = false;
                version.current = state.theirs.version;
                latest.current = state.theirs.hidden;
                setHidden(state.theirs.hidden);
                setState({ kind: "idle" });
              }}
            >
              Use theirs
            </Button>
            <Button
              size="sm"
              onClick={() => {
                version.current = state.theirs.version;
                dirty.current = true;
                void flush();
              }}
            >
              Keep mine
            </Button>
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {LEVER_GROUP_ORDER.map((group) => (
          <Card key={group} role="region" aria-labelledby={`levers-${group}`}>
            <CardHeader>
              <h2 id={`levers-${group}`} className="font-heading text-base font-medium">
                {GROUP_LABELS[group]}
              </h2>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {kindsOf(group).map((kind) => (
                <LeverRow key={kind.id} kind={kind} shown={!hidden.includes(kind.id)} disabled={!canEdit} onChange={(on) => setShown(kind.id, on)} settingsBase={settingsBase} />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </Page>
  );
}

function LeverRow({ kind, shown, disabled, onChange, settingsBase }: { kind: LeverKind; shown: boolean; disabled: boolean; onChange: (on: boolean) => void; settingsBase?: string }) {
  return (
    <div data-lever-kind={kind.id} className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 text-sm">
        {/* The switch is named by the visible text, so the two never differ. */}
        <label className="flex items-center gap-2">
          <Switch checked={shown} disabled={disabled} onCheckedChange={onChange} />
          <span className={cn("font-medium", !shown && "text-muted-foreground")}>{kind.label}</span>
        </label>
        <Help label={kind.label} description={kind.description} example={kind.example} />
      </div>
      <p className="pl-10 text-xs text-muted-foreground">
        {kind.control === "settings" && kind.settingsPath && settingsBase ? (
          <Link href={`${settingsBase}${kind.settingsPath}`} className="underline">
            {kind.settingsLabel}
          </Link>
        ) : kind.control === "settings" ? (
          (kind.settingsLabel ?? CONTROL_NOTE.settings)
        ) : (
          CONTROL_NOTE[kind.control]
        )}
        {kind.control === "settings" && " Hiding this has no effect yet."}
      </p>
    </div>
  );
}

function SaveStatus({ state, mode }: { state: SaveState; mode: LeversMode }) {
  if (mode !== "live") return null;
  const text =
    state.kind === "saving" ? "Saving…" : state.kind === "saved" ? "Saved" : state.kind === "error" ? state.message : state.kind === "conflict" ? "Not saved" : "";
  if (!text) return null;
  return (
    <span role="status" className={cn("text-xs", state.kind === "error" || state.kind === "conflict" ? "text-destructive" : "text-muted-foreground")}>
      {text}
    </span>
  );
}
