"use client";

// "Copy invite message" on a pre-assigned email (issue #30, B1 1/3). Transpera Flow sends no emails: signing in with Google as
// the listed address is how someone accepts, so the owner copies this and sends it themselves. The link uses the address the
// owner is looking at, so it works on a preview deployment too.

import { useState } from "react";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { inviteMessage } from "@/lib/access";

export function CopyInviteButton({ workspaceName, email }: { workspaceName: string; email: string }) {
  const [state, setState] = useState<"idle" | "copied" | "blocked">("idle");
  const copy = async () => {
    const text = inviteMessage(workspaceName, email, window.location.origin);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      // Clipboard access can be blocked (an insecure page, a permission): fall back to selecting a hidden field.
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      setState(ok ? "copied" : "blocked");
    }
  };
  return (
    <span className="flex items-center">
      <Button type="button" variant="outline" size="sm" onClick={copy} aria-label={`Copy invite message for ${email}`}>
        Copy invite message
      </Button>
      <Help
        label="Copy invite message"
        description="Transpera Flow doesn't send emails. Send this to the person yourself."
        example="Copy it into a Slack message to Maya."
      />
      <span role="status" className="ml-2 text-muted-foreground">
        {state === "copied" ? "Copied." : state === "blocked" ? "Couldn't copy. Your browser blocked it." : ""}
      </span>
    </span>
  );
}
