"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

function Confirm() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" size="sm" disabled={pending}>
      {pending ? "Removing…" : "Remove"}
    </Button>
  );
}

/**
 * Remove for one "Who can sign in" rule, asked once first ("Remove @acme.com?"), as a role's Remove is. Removing the rule that lets the
 * signed-in person in says so: they would be signed out at their next page load.
 */
export function RemoveRule({ action, id, name, value, locksYouOut }: { action: (form: FormData) => void | Promise<void>; id: string; name: string; value: string; locksYouOut: boolean }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button type="button" variant="ghost" size="sm" className="text-destructive" aria-label={`Remove ${value}`} onClick={() => setConfirming(true)}>
        Remove
      </Button>
    );
  }
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" data-confirm-remove-rule>
      <input type="hidden" name="id" value={id} />
      <span className="text-sm">
        Remove {name}?
        {locksYouOut && (
          <strong role="alert" className="ml-1 font-medium text-crit">
            This is the rule that lets you sign in: you&apos;ll be signed out.
          </strong>
        )}
      </span>
      <Confirm />
      <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </form>
  );
}
