"use client";

// The Share button and its dialog (issue #32, B3), on the Overview, a process, an issue and a solution, for owners and editors. A
// link shows a frozen, read-only copy of the page. Two switches, both off: people's names, and costs and margins. Either on needs
// the email addresses allowed to open it (they sign in with Google) and an end date. Pay is never shared. The link is shown once.

import { useState, useTransition } from "react";
import Link from "next/link";
import { Share2 } from "lucide-react";
import type { ShareKind } from "@transpera-flow/db";
import { createShareLink, type ShareResult } from "@/app/w/[slug]/share-actions";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_DAYS, daysFromNow, parseShareInput, type ShareInput } from "@/lib/share/input";
import { EDIT_ONLY } from "@/lib/phone";

/** The (i) texts: what each field does, in plain words, with an example. */
export const SHARE_HELP = {
  what: {
    label: "What's shared",
    description: "Anyone with the link sees a read-only copy of this page as it is now. They can't change anything.",
    example: "Send the Overview to a new hire's manager.",
  },
  people: {
    label: "Show people's names",
    description: "Off: everyone is shown as Team member 1, 2, 3. On: real names. Pay is never shared.",
    example: "Off: “Team member 3 is too busy”. On: “Sam Rivera is too busy”.",
  },
  financials: {
    label: "Show costs and margins",
    description: "Off: only revenue is shown; costs, margins, overhead and the cost of each issue are hidden. On: they're shown, except anything that depends on one person's pay.",
    example: "Off: an issue's cost shows —. On: “£4.1k a month”.",
  },
  who: {
    label: "Who can open it",
    description: "Only these people can open the link, after signing in with Google using that email address.",
    example: "sam@northbeam.co, ops@northbeam.co",
  },
  until: {
    label: "Link works until",
    description: "The link stops working at the end of this day.",
    example: "30 days from today.",
  },
  play: {
    label: "Let people try changes",
    description: "Visitors can move the levers you show (Settings → Levers) and see what would change. Nothing they do is saved. They can send you what they tried: it arrives in Suggestions, and nothing changes unless you build it.",
    example: "A client tries one more strategist and sends it as “Hire for onboarding”.",
  },
  name: {
    label: "Name",
    description: "Only you and other editors see this, on Share links.",
    example: "For Northbeam's board, October.",
  },
} as const;

export interface ShareButtonProps {
  slug: string;
  kind: ShareKind;
  /** The process, issue or solution; null for the Overview. */
  targetId: string | null;
  /** What is shared, in words: "The Overview", the process's name, "Issue #12", the solution's name. */
  what: string;
  /** Makes the link. Defaults to the Server Action; a test passes its own. */
  create?: (input: ShareInput) => Promise<ShareResult>;
}

/** "Share" with its dialog. Shown only to owners and editors (the page that renders it decides). */
export function ShareButton(props: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" className={EDIT_ONLY} onClick={() => setOpen(true)} data-share-open data-edit-entry>
        <Share2 aria-hidden /> Share
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg" data-share-dialog>
          <DialogHeader>
            <DialogTitle>Share</DialogTitle>
            <DialogDescription>Make a link to a read-only copy of this page.</DialogDescription>
          </DialogHeader>
          {/* Keyed on opening, so each time starts from the defaults. */}
          {open && <Form {...props} onClose={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({ help, htmlFor, children, label }: { help: (typeof SHARE_HELP)[keyof typeof SHARE_HELP]; htmlFor?: string; children: React.ReactNode; label: string }) {
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

function Form({ slug, kind, targetId, what, create, onClose }: ShareButtonProps & { onClose: () => void }) {
  const [people, setPeople] = useState(false);
  const [financials, setFinancials] = useState(false);
  const [emails, setEmails] = useState("");
  const [expiresOn, setExpiresOn] = useState(() => daysFromNow(DEFAULT_DAYS));
  const [noEnd, setNoEnd] = useState(false);
  const [play, setPlay] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const restricted = people || financials;
  const make = create ?? ((input: ShareInput) => createShareLink(slug, input));

  const input: ShareInput = { kind, targetId, people, financials, emails, expiresOn: noEnd && !restricted ? null : expiresOn || null, label, play: kind === "process" && play };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const checked = parseShareInput(input);
    if (!checked.ok) return setError(checked.message);
    start(async () => {
      try {
        const r = await make(input);
        if (r.status === "error") setError(r.message);
        else if (r.url) setUrl(r.url);
        else setError("Something went wrong. Try again.");
      } catch {
        setError("Couldn't make the link. Check your connection and try again.");
      }
    });
  };

  if (url) {
    return (
      <div className="flex flex-col gap-3" data-share-done>
        <label htmlFor="share-url" className="text-sm font-medium">
          Your link
        </label>
        <div className="flex gap-2">
          <Input id="share-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} data-share-url />
          <Button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
            data-share-copy
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
        <p className="text-sm text-fg-2" role="status">
          Copy it now: you won&apos;t see this link again. You can turn it off any time on{" "}
          <Link href={`/w/${slug}/share`} className="underline">
            Share links
          </Link>
          .
        </p>
        {input.play && (
          <p className="text-sm text-fg-2" data-share-play-done>
            People who open it can send you ideas. You&apos;ll find them in Suggestions.
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Field label="What's shared" help={SHARE_HELP.what}>
        <p className="text-sm text-fg-2" data-share-what>
          {what}
        </p>
      </Field>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center">
            <label htmlFor="share-people" className="text-sm font-medium">
              Show people&apos;s names
            </label>
            <Help {...SHARE_HELP.people} />
          </div>
          <Switch id="share-people" checked={people} onCheckedChange={setPeople} data-share-people />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center">
            <label htmlFor="share-financials" className="text-sm font-medium">
              Show costs and margins
            </label>
            <Help {...SHARE_HELP.financials} />
          </div>
          <Switch id="share-financials" checked={financials} onCheckedChange={setFinancials} data-share-financials />
        </div>
        {kind === "process" && (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center">
              <label htmlFor="share-play" className="text-sm font-medium">
                Let people try changes
              </label>
              <Help {...SHARE_HELP.play} />
            </div>
            <Switch id="share-play" checked={play} onCheckedChange={setPlay} data-share-play />
          </div>
        )}
      </div>
      {restricted && (
        <Field label="Who can open it" htmlFor="share-emails" help={SHARE_HELP.who}>
          <Textarea id="share-emails" value={emails} onChange={(e) => setEmails(e.target.value)} rows={3} placeholder="sam@northbeam.co, ops@northbeam.co" required aria-required data-share-emails />
          <p className="text-xs text-muted-foreground">One address, or several separated by commas or new lines. They sign in with Google.</p>
        </Field>
      )}
      <Field label="Link works until" htmlFor="share-until" help={SHARE_HELP.until}>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            id="share-until"
            type="date"
            value={noEnd && !restricted ? "" : expiresOn}
            min={daysFromNow(1)}
            disabled={noEnd && !restricted}
            onChange={(e) => setExpiresOn(e.target.value)}
            className="w-44"
            data-share-until
          />
          <label className="flex items-center gap-2 text-sm text-fg-2">
            <input
              type="checkbox"
              checked={noEnd && !restricted}
              disabled={restricted}
              onChange={(e) => setNoEnd(e.target.checked)}
              data-share-no-end
            />
            No end date
          </label>
        </div>
        {restricted && <p className="text-xs text-muted-foreground">A link that shows names or costs always needs an end date.</p>}
      </Field>
      <Field label="Name (optional)" htmlFor="share-name" help={SHARE_HELP.name}>
        <Input id="share-name" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} placeholder="For Northbeam's board, October." data-share-name />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-destructive" data-share-error>
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} data-share-create>
          {pending ? "Making the link…" : "Create link"}
        </Button>
      </DialogFooter>
    </form>
  );
}
