"use client";

import { useSearchParams } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * The line the Editor sends a person back with when it can't open (`?notice=` from `workspace-editor-page.tsx`): they may only view this
 * workspace, or the process is archived. Without it the redirect would leave them guessing why they're on the read-only page.
 */
const TEXT: Record<string, string> = {
  "read-only": "You can't edit this process: you can view this workspace but not change it. Ask an owner or editor for edit access.",
  archived: "You can't edit this process because it's archived. Restore it from the Processes list to edit it again.",
};

export function EditNotice() {
  const notice = useSearchParams().get("notice");
  const text = notice ? TEXT[notice] : undefined;
  if (!text) return null;
  return (
    <div className="px-4 pt-3 sm:px-6 lg:px-8" data-edit-notice={notice}>
      <Alert>
        <AlertDescription>{text}</AlertDescription>
      </Alert>
    </div>
  );
}
