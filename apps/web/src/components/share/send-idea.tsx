"use client";

// "Send your idea to {workspace}" (issue #33, B4): a play-link visitor names what they tried, says why, and signs it. It goes to the
// workspace's Suggestions through `public.submit_play_proposal`. The visitor is told only that it was sent: whether anything they wrote
// was held back from the team's members (a name, an email address or an amount) is never reported, so the answer can't be used to
// find out who is on the team or who the clients are.

import { useMemo, useState, useTransition, type ReactNode } from "react";
import type { ProcessBundle } from "@transpera-flow/db";
import type { ScenarioPatch } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import type { PlayConfig } from "@/components/share/play-section";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { MAX_NAME, MAX_NOTE, MAX_TITLE, parsePlayIdea, playResultMessage, type PlayIdeaInput } from "@/lib/share/play-input";
import { describeLeverChange } from "@/lib/suggestions/lever-changes";

export interface PlayIssue {
  id: string;
  number: number | null;
  title: string;
}

/** The (i) texts: what each field is, in plain words, with an example. */
export const SEND_HELP = {
  changes: {
    label: "The changes you're sending",
    description: "These are the levers you moved. The team sees exactly these, and can build them into a solution or turn them down.",
    example: "Strategist: 3 people; Leads per week: 12.",
  },
  title: {
    label: "Name your idea",
    description: "A short name the team will see in their list.",
    example: "One more strategist",
  },
  issue: {
    label: "What it should fix",
    description: "If your idea is for one of the problems on this page, pick it. The team then tests it against that problem.",
    example: "Leads wait too long for a first call",
  },
  note: {
    label: "Why it would help",
    description: "Anything the team should know: what you tried and what you saw. If you mention someone by name, an email address or an amount, only the team's owners and editors will see what you wrote.",
    example: "With 3 strategists, leads wait under a day and nothing else gets worse.",
  },
  name: {
    label: "Your name",
    description: "So the team knows who sent it. Everyone in their workspace who reads Suggestions sees it.",
    example: "Marta Okoye",
  },
  email: {
    label: "Your email",
    description: "So the team can reply. Only their owners and editors see it.",
    example: "marta@example.com",
  },
  verified: {
    label: "Your email",
    description: "You signed in with this address, so it's the one the team sees.",
    example: "marta@example.com",
  },
} as const;

function Field({ help, htmlFor, label, children }: { help: { label: string; description: string; example: string }; htmlFor?: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        <Help {...help} />
      </div>
      {children}
    </div>
  );
}

/** Names for the changes' ids, from the visitor's own copy (labels, never real names unless the link shows people). */
function namesFrom(bundle: ProcessBundle) {
  const steps: Record<string, string> = {};
  for (const s of [...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((p) => p.steps)]) steps[s.id] = s.name;
  return {
    steps,
    roles: Object.fromEntries(bundle.roles.map((r) => [r.id, r.name])),
    services: Object.fromEntries(bundle.services.map((s) => [s.id, s.name])),
    people: bundle.viewer?.seesEveryone === false ? undefined : Object.fromEntries(bundle.people.map((p) => [p.id, p.name])),
  };
}

export function SendIdea({ bundle, play, patches, onClose }: { bundle: ProcessBundle; play: PlayConfig; patches: ScenarioPatch[]; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [issue, setIssue] = useState("");
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();
  const names = useMemo(() => namesFrom(bundle), [bundle]);
  const currency = bundle.workspace.settings.currency;
  const lines = useMemo(() => patches.map((p) => describeLeverChange(p, names, currency)), [patches, names, currency]);
  const ids = useMemo(
    () => ({
      steps: new Set([...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((p) => p.steps)].map((s) => s.id)),
      roles: new Set(bundle.roles.map((r) => r.id)),
      people: new Set(bundle.people.map((p) => p.id)),
      services: new Set(bundle.services.map((s) => s.id)),
    }),
    [bundle],
  );

  const input: PlayIdeaInput = { title, note, name, email: play.restricted ? "" : email, issue: issue || null, levers: patches, website };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const checked = parsePlayIdea(input, { needEmail: !play.restricted, snapshot: { hidden: play.hiddenLevers, showPeople: play.showPeople, ids } });
    if (!checked.ok) return setError(checked.message);
    start(async () => {
      try {
        const r = await play.submit(input);
        if (r.status === "ok") setSent(true);
        else setError(playResultMessage(r));
      } catch {
        setError("Couldn't send. Try again.");
      }
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg" data-send-idea>
        <DialogHeader>
          <DialogTitle>Send your idea to {play.workspaceName}</DialogTitle>
          <DialogDescription>Nothing changes for them unless they build it.</DialogDescription>
        </DialogHeader>
        {sent ? (
          <div className="flex flex-col gap-3" data-send-done>
            <p className="text-sm" role="status">
              Sent. The team will find your idea in their Suggestions. Nothing changes unless they build it.
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center">
                <h3 className="text-sm font-medium">The changes you&apos;re sending</h3>
                <Help {...SEND_HELP.changes} />
              </div>
              <ul className="list-disc pl-5 text-sm text-fg-2" data-send-changes>
                {lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
            <Field label="Name your idea" htmlFor="send-title" help={SEND_HELP.title}>
              <Input id="send-title" value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value)} placeholder="One more strategist" data-send-title />
            </Field>
            <Field label="What it should fix" htmlFor="send-issue" help={SEND_HELP.issue}>
              <NativeSelect id="send-issue" value={issue} onChange={(e) => setIssue(e.target.value)} data-send-issue>
                <option value="">Nothing in particular</option>
                {play.issues.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.number != null ? `#${i.number} ` : ""}
                    {i.title}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Why it would help (optional)" htmlFor="send-note" help={SEND_HELP.note}>
              <Textarea id="send-note" value={note} maxLength={MAX_NOTE} rows={3} onChange={(e) => setNote(e.target.value)} placeholder="With 3 strategists, leads wait under a day and nothing else gets worse." data-send-note />
            </Field>
            <Field label="Your name" htmlFor="send-name" help={SEND_HELP.name}>
              <Input id="send-name" value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} placeholder="Marta Okoye" autoComplete="name" data-send-name />
            </Field>
            {play.restricted ? (
              <Field label="Your email" help={SEND_HELP.verified}>
                <p className="text-sm text-fg-2" data-send-verified>
                  Sent as {play.visitorEmail ?? "the address you signed in with"}
                </p>
              </Field>
            ) : (
              <Field label="Your email" htmlFor="send-email" help={SEND_HELP.email}>
                <Input id="send-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="marta@example.com" autoComplete="email" data-send-email />
              </Field>
            )}
            {/* The honeypot: a person never sees or fills it. Off-screen, not display:none, so a bot that skips hidden fields still meets it. */}
            <div aria-hidden style={{ position: "absolute", left: -9999, top: "auto", width: 1, height: 1, overflow: "hidden" }} data-send-honeypot>
              <label>
                Website
                <input name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
              </label>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive" data-send-error>
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending} data-send-submit>
                {pending ? "Sending…" : "Send"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
