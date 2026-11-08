"use client";

// A paragraph that is edited where it stands (Q10): click it, change it, Save. Readers see the text only; when it is empty an editor sees
// the empty message and an Add button, a reader sees `emptyReader` (or nothing). The caller saves and says what went wrong, if anything.

import { Pencil } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EDIT_ONLY } from "@/lib/phone";
import { cn } from "@/lib/utils";

export function EditableText({
  value,
  canEdit,
  onSave,
  emptyMessage,
  emptyReader,
  addLabel = "Add",
  label,
  maxLength = 4000,
  rows = 4,
  starter = "",
  className,
  ...rest
}: {
  value: string | null;
  canEdit: boolean;
  /** Saves the new text (trimmed; "" when cleared). Returns a sentence when it failed, null when it saved. */
  onSave: (next: string) => Promise<string | null>;
  /** What an empty field says to an editor. */
  emptyMessage: string;
  /** What an empty field says to a reader; absent shows nothing. */
  emptyReader?: string;
  addLabel?: string;
  /** Names the box to a screen reader. */
  label: string;
  maxLength?: number;
  rows?: number;
  /** The text an empty field starts with when someone edits it, such as questions to answer. */
  starter?: string;
  className?: string;
} & Record<`data-${string}`, string | undefined>) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = value?.trim() ?? "";
  const begin = () => {
    setText(value?.trim() ? value : starter);
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const problem = await onSave(text.trim());
      if (problem) setError(problem);
      else setEditing(false);
    } catch {
      setError("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className={cn("flex flex-col gap-2", className)} data-editing="" {...rest}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={rows} maxLength={maxLength} aria-label={label} autoFocus disabled={busy} />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void save()} data-save>
            Save
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  if (!shown) {
    return (
      <div className={cn("flex flex-wrap items-center gap-3", className)} data-empty="" {...rest}>
        {canEdit ? (
          <>
            <p className="text-sm text-fg-2">{emptyMessage}</p>
            <span className={EDIT_ONLY} data-edit-entry>
              <Button type="button" size="sm" variant="outline" onClick={begin} data-add>
                {addLabel}
              </Button>
            </span>
          </>
        ) : (
          emptyReader && <p className="text-sm text-fg-2">{emptyReader}</p>
        )}
      </div>
    );
  }
  return (
    <div className={cn("group/edit flex items-start gap-2", className)} {...rest}>
      {canEdit ? (
        <button type="button" onClick={begin} aria-label={`Edit ${label.toLowerCase()}`} className={cn("min-w-0 flex-1 rounded-md text-left text-sm whitespace-pre-line hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", EDIT_ONLY)} data-edit-entry>
          {shown}
          <Pencil aria-hidden className="ml-1.5 inline size-3 text-fg-3 opacity-0 group-hover/edit:opacity-100" />
        </button>
      ) : null}
      {/* On a phone the edit button is hidden, and the text is still there to read. */}
      <p className={cn("min-w-0 flex-1 text-sm whitespace-pre-line", canEdit && "sm:hidden")} data-readonly-text>
        {shown}
      </p>
    </div>
  );
}
