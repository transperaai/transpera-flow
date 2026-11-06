"use client";

// "Adopt" on the Solution page (Q12, D44): makes the solution the next version of its process, the safe way. It opens a draft of the process
// with this solution's steps in it, in the Editor, for the person to look over and press Publish. Nothing is ever published from here.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { adoptSolution } from "@/app/w/[slug]/solution-page-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function AdoptSolution({
  workspaceId,
  solutionId,
  name,
  processName,
  draftHref,
  onAdopted,
}: {
  workspaceId: string;
  solutionId: string;
  name: string;
  processName: string;
  /** The Editor on the process's draft, which Adopt goes to. */
  draftHref: string;
  onAdopted: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A draft with work in it is only replaced when the person says so.
  const [existing, setExisting] = useState<number | null>(null);

  const adopt = async (replace: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await adoptSolution(workspaceId, solutionId, replace);
      if (r.status === "ok") {
        onAdopted();
        router.push(draftHref);
      } else if (r.status === "draft_exists") setExisting(r.number);
      else setError(r.message);
    } catch {
      setError("Couldn't adopt it. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const close = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setExisting(null);
      setError(null);
    }
  };
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} data-adopt>
        Adopt
      </Button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="sm:max-w-md" data-adopt-dialog>
          <DialogHeader>
            <DialogTitle>{existing === null ? `Adopt “${name}”?` : `${processName} already has a draft`}</DialogTitle>
            <DialogDescription>
              {existing === null
                ? `This opens a new draft of ${processName} with this solution's steps, in the Editor. Look it over, then press Publish when you are happy. Nothing goes live until you do.`
                : `Version ${existing} of ${processName} is a draft with changes in it. Adopting this solution replaces those changes with the solution's steps. Keep the draft and nothing is lost.`}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              {existing === null ? "Cancel" : "Keep the draft"}
            </Button>
            <Button type="button" className="bg-edit text-edit-fg hover:bg-edit/90" disabled={busy} onClick={() => void adopt(existing !== null)} data-adopt-confirm>
              {busy ? "Adopting…" : existing === null ? "Adopt and open the Editor" : "Replace the draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
