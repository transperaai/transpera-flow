"use client";

import { PROCESS_CATEGORIES, PROCESS_CATEGORY_HELP, PROCESS_CATEGORY_LABELS } from "@transpera-flow/db";
import { Plus } from "lucide-react";
import { startTransition, useActionState, useState } from "react";
import type { CreateProcessResult } from "@/app/w/[slug]/process-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EDIT_ONLY } from "@/lib/phone";

export type CreateProcess = (prev: CreateProcessResult, form: FormData) => Promise<CreateProcessResult>;

/** The Processes page's "New process" button (the page's one primary action, teal like every other): asks for a name and the category (which picks the engine kind, D52), then opens the new process in a draft. */
export function NewProcessButton({ create }: { create: CreateProcess }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`inline-flex items-center ${EDIT_ONLY}`} data-edit-entry>
      <Button onClick={() => setOpen(true)} data-new-process-open>
        <Plus aria-hidden /> New process
      </Button>
      <NewProcessDialog open={open} onOpenChange={setOpen} create={create} />
    </span>
  );
}

/** The "New process" dialog, shared by the process switcher and the Processes page. Creating opens the new process in a draft. */
export function NewProcessDialog({ open, onOpenChange, create }: { open: boolean; onOpenChange: (open: boolean) => void; create: CreateProcess }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New process</DialogTitle>
          <DialogDescription>It belongs to this workspace only and gets a card on the company map. You can rename it or change its type later.</DialogDescription>
        </DialogHeader>
        <NewProcessForm create={create} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function NewProcessForm({ create, onCancel }: { create: CreateProcess; onCancel: () => void }) {
  const [state, action, pending] = useActionState(create, {});
  // Submitted through onSubmit, not `action`: React resets a form after its action runs, which would clear the name and the type
  // whenever the server says no. This way what was typed stays for the person to correct.
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        startTransition(() => action(form));
      }}
      className="flex flex-col gap-3"
      data-new-process
    >
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground uppercase" htmlFor="new-process-name">
          Name
        </label>
        <Input id="new-process-name" name="name" required maxLength={120} autoFocus placeholder="e.g. Quarterly review" />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground uppercase">Type</legend>
        {PROCESS_CATEGORIES.map((c) => (
          <label key={c} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
            <input type="radio" name="category" value={c} required className="mt-1 accent-[var(--accent)]" />
            <span>
              <span className="font-semibold">{PROCESS_CATEGORY_LABELS[c]}</span>
              <span className="block text-xs text-muted-foreground">{PROCESS_CATEGORY_HELP[c]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}
