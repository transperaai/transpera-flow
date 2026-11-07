"use client";

// "+ New purpose…" under a step's "What it achieves" (editor brainstorm, item 1): a name and an optional description, saved to the workspace's
// purposes straight away (the same list as Settings -> Purposes) and then set on the step. Anyone who can edit the workspace can; others don't
// see it. At the limit it says so instead.

import { useId, useState } from "react";
import { MAX_PURPOSES, MAX_PURPOSE_DESCRIPTION, MAX_PURPOSE_NAME } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** What the Editor does to add a purpose to the workspace; the step takes the new key when it is `ok`. */
export interface PurposeAdder {
  /** How many purposes the workspace has now. */
  count: number;
  add: (input: { name: string; description: string }) => Promise<{ ok: true; key: string } | { ok: false; message: string }>;
}

export const PURPOSE_LIMIT_NOTE = `You have ${MAX_PURPOSES} purposes, the most there can be`;

export function NewPurpose({ adder, onAdded }: { adder: PurposeAdder; onAdded: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  if (adder.count >= MAX_PURPOSES) {
    return (
      <p data-purpose-limit className="text-xs text-muted-foreground">
        {PURPOSE_LIMIT_NOTE}
      </p>
    );
  }
  if (!open) {
    return (
      <button type="button" data-new-purpose onClick={() => setOpen(true)} className="self-start text-xs font-semibold text-accent underline">
        + New purpose…
      </button>
    );
  }
  const submit = async () => {
    if (!name.trim()) return setError("Give the purpose a name.");
    setSaving(true);
    setError(null);
    const out = await adder.add({ name, description });
    setSaving(false);
    if (!out.ok) return setError(out.message);
    setOpen(false);
    setName("");
    setDescription("");
    onAdded(out.key);
  };
  return (
    <form
      data-new-purpose-form
      aria-label="New purpose"
      className="flex flex-col gap-2 rounded-token border border-line bg-bg p-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-xs text-fg-2">Added to your workspace&apos;s purposes (Settings → Purposes) and set on this step.</p>
      <div className="flex flex-col gap-1">
        <span className="flex items-center">
          <label htmlFor={`${id}-name`} className="text-xs font-medium text-fg-2">
            Name
          </label>
          <Help label="Name" description="What the purpose is called, in the lists and charts that add up working time by purpose." example="“Chasing the client”." />
        </span>
        <Input id={`${id}-name`} autoFocus value={name} maxLength={MAX_PURPOSE_NAME} onChange={(e) => setName(e.target.value)} placeholder="Chasing the client" />
      </div>
      <div className="flex flex-col gap-1">
        <span className="flex items-center">
          <label htmlFor={`${id}-description`} className="text-xs font-medium text-fg-2">
            Description <span className="font-normal text-fg-3">(optional)</span>
          </label>
          <Help label="Description" description="A line to remind people what belongs under this purpose. It is shown in Settings, under Purposes." example="“Emails and calls to get answers or sign-off.”" />
        </span>
        <Textarea id={`${id}-description`} rows={2} value={description} maxLength={MAX_PURPOSE_DESCRIPTION} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {error && (
        <p role="alert" className="text-xs text-crit">
          {error}
        </p>
      )}
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Adding…" : "Add purpose"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
