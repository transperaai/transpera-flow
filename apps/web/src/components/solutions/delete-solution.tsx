"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// "Delete solution" on the Solution page (issue #182, B19), for owners and editors: a confirm that says what goes and what is
// kept. The issues it was linked to keep a line in their history, and the links are kept in the audit log (the database does
// both). The delete comes in as `remove`, so the browser tests can stand in for the server.

export function DeleteSolution({
  name,
  linked,
  remove,
  onDeleted,
}: {
  name: string;
  /** How many issues it is linked to. */
  linked: number;
  remove: () => Promise<{ status: "ok" } | { status: "error"; message: string }>;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await remove();
      if (r.status === "error") return setError(r.message);
      setOpen(false);
      onDeleted();
    } catch {
      setError("Couldn't delete. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-delete-solution>
        Delete solution
      </Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="sm:max-w-md" data-delete-solution-dialog>
          <DialogHeader>
            <DialogTitle>Delete “{name}”?</DialogTitle>
            <DialogDescription>
              The solution and its copy of the map are deleted. This can&apos;t be undone.
              {linked > 0
                ? ` The ${linked === 1 ? "issue it was linked to keeps" : `${linked} issues it was linked to keep`} a note in ${linked === 1 ? "its" : "their"} history, and its verdicts stay in the audit log. An issue being tested with no other solution goes back to Open.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
