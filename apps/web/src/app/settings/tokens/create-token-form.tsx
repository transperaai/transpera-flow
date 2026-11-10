"use client";

import { Plus } from "lucide-react";
import { startTransition, useActionState, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createToken, revokeToken, type CreateTokenState } from "./actions";

/** The API tokens page's one primary action: "Create token", which asks for a name in a dialog and then shows the token once. */
export function CreateTokenButton({ endpoint }: { endpoint: string }) {
  const [open, setOpen] = useState(false);
  // A fresh form each time the dialog opens, so a token shown once is not shown again.
  const [round, setRound] = useState(0);
  return (
    <>
      <Button
        type="button"
        onClick={() => {
          setRound((n) => n + 1);
          setOpen(true);
        }}
        data-create-token
      >
        <Plus aria-hidden /> Create token
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create a token</DialogTitle>
            <DialogDescription>Give it a name that says where it is used. It is shown once.</DialogDescription>
          </DialogHeader>
          <CreateTokenForm key={round} endpoint={endpoint} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The token's name, then the token and the command to connect Claude Code. Sent through onSubmit, not `action`: React resets a form after
 * its action, which would clear the name whenever the server says no.
 */
export function CreateTokenForm({ endpoint, onDone }: { endpoint: string; onDone?: () => void }) {
  const [state, action, pending] = useActionState<CreateTokenState, FormData>(createToken, null);
  const [label, setLabel] = useState("");
  const created = state && "token" in state ? state : null;
  const id = useId();

  if (created) {
    return (
      <div className="flex flex-col gap-3">
        <div role="status" className="rounded-lg border border-line bg-muted/50 p-3 text-sm">
          <p className="font-medium">Copy “{created.label}” now. It won&apos;t be shown again.</p>
          <code className="mt-2 block rounded-md border border-line bg-card p-2 font-mono break-all">{created.token}</code>
          <p className="mt-3 text-muted-foreground">Connect Claude Code:</p>
          <code className="mt-1 block rounded-md border border-line bg-card p-2 font-mono text-xs break-all">
            {`claude mcp add --transport http transpera-flow ${endpoint} --header "Authorization: Bearer ${created.token}"`}
          </code>
        </div>
        {onDone && (
          <DialogFooter>
            <Button type="button" onClick={onDone}>
              Done
            </Button>
          </DialogFooter>
        )}
      </div>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        startTransition(() => action(form));
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <span className="flex items-center">
          <label htmlFor={id} className="text-xs font-medium text-fg-2">
            Name
          </label>
          <Help label="Token name" description="A name to remember what this token is for, so you can tell tokens apart and revoke the right one." example="Claude Code on my laptop" />
        </span>
        <Input id={id} name="label" required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Claude Code on my laptop" className="max-w-md" autoFocus />
      </div>
      {state && "error" in state && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <DialogFooter>
        {onDone && (
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create token"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A token's Revoke: it asks first, in the row, because the clients using the token stop working at once. */
export function RevokeTokenButton({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!confirming) {
    return (
      <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirming(true)} aria-label={`Revoke ${label}`} data-revoke>
        Revoke
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2" data-revoke-confirm>
      <span className="text-sm">
        Revoke {label}? Connected Claude clients stop working.
      </span>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            const r = await revokeToken(id);
            if (r.status === "error") setError(r.message);
            else {
              setConfirming(false);
              router.refresh();
            }
          } catch {
            setError("Couldn't revoke the token. Try again.");
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Revoking…" : "Revoke"}
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
      {error && (
        <span role="alert" className="w-full text-right text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
