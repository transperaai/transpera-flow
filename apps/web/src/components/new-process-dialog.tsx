"use client";

import { useActionState, useState } from "react";
import type { CreateProcessResult } from "@/app/w/[slug]/process-actions";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PROCESS_KIND_CHOICES } from "@/lib/processes/admin";

export type CreateProcess = (prev: CreateProcessResult, form: FormData) => Promise<CreateProcessResult>;

/** The Processes page's "New process" button: asks for a name and the kind, then opens the new process in a draft. */
export function NewProcessButton({ create }: { create: CreateProcess }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex items-center">
      <Button className="bg-edit text-edit-fg hover:bg-edit/90" onClick={() => setOpen(true)}>
        ✎ New process
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
  return (
    <form action={action} className="flex flex-col gap-3" data-new-process>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground uppercase" htmlFor="new-process-name">
          Name
        </label>
        <Input id="new-process-name" name="name" required maxLength={120} autoFocus placeholder="e.g. Quarterly review" />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 flex items-center text-xs font-medium text-muted-foreground uppercase">
          Type
          <Help
            label="Type"
            description="A sales pipeline is how new work comes in: leads arrive from Demand and some are won. Client work is something this company does again and again for the clients it already has, run per client by the services linked to it."
            example="Northbeam's enquiry-to-signed process is a sales pipeline; its monthly reporting is client work."
          />
        </legend>
        {PROCESS_KIND_CHOICES.map((k) => (
          <label key={k.value} className="flex cursor-pointer items-start gap-2 rounded-token border p-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
            <input type="radio" name="kind" value={k.value} required className="mt-1 accent-[var(--accent)]" />
            <span>
              <span className="font-semibold">{k.label}</span>
              <span className="block text-xs text-muted-foreground">{k.description}</span>
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
