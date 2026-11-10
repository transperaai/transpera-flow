"use client";

// Restore a workspace backup (issue #39, B10 2b): choose the .json file an export made, see what would come back and what stays in
// the file, then restore it into this new, empty workspace. The file is checked here with the same code the server runs again
// (`checkWorkspaceBundle`), gzipped in the browser (a Route Handler takes up to 4 MB, and a backup is mostly repeated text), and
// posted to the restore route. Every process comes back as a draft of its live version; nothing is published.

import { useRouter } from "next/navigation";
import { FileJson } from "lucide-react";
import { useId, useState } from "react";
import { MAX_BACKUP_BYTES, MAX_COMPRESSED_BYTES, checkWorkspaceBundle, type BundleCheck, type SummaryLine } from "@transpera-flow/db/workspace-import";
import { SectionCard } from "@/components/page-kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LOST_CONNECTION_MESSAGE } from "@/lib/restore/errors";
import { noticeCookieValue, restoredMessage, RESTORE_NOTICE_COOKIE } from "@/lib/restore/notice";

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const num = (n: number) => n.toLocaleString("en-US");

type Step =
  | { kind: "choose" }
  | { kind: "problem"; message: string }
  | { kind: "ready"; fileName: string; text: string; check: BundleCheck }
  | { kind: "restoring"; fileName: string }
  | { kind: "failed"; fileName: string; text: string; check: BundleCheck; message: string };

/** The file as gzip: what the route takes. */
async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

function Lines({ lines }: { lines: SummaryLine[] }) {
  return (
    <ul className="mt-1 list-disc space-y-0.5 pl-5">
      {lines.map((l) => (
        <li key={l.key}>
          {num(l.count)} {l.label}
        </li>
      ))}
    </ul>
  );
}

export function RestoreBackup({ slug, canManage = true, post }: { slug: string; /** Whether the restore applies the backup's workspace settings: true for the Owner and every Agency admin, the only people who can restore. */ canManage?: boolean; /** Replaces `fetch` in tests. */ post?: (url: string, init: RequestInit) => Promise<Response> }) {
  const router = useRouter();
  const inputId = useId();
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [dragging, setDragging] = useState(false);

  async function choose(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
      setStep({ kind: "problem", message: `That file is ${mb(file.size)}; a restore takes at most ${mb(MAX_BACKUP_BYTES)}.` });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setStep({ kind: "problem", message: "That file couldn't be read." });
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      setStep({ kind: "problem", message: "That file isn't valid JSON." });
      return;
    }
    setStep({ kind: "ready", fileName: file.name, text, check: checkWorkspaceBundle(value, { canManage }) });
  }

  async function restore(fileName: string, text: string, check: BundleCheck) {
    setStep({ kind: "restoring", fileName });
    let body: Blob;
    try {
      body = await gzip(text);
    } catch {
      setStep({ kind: "failed", fileName, text, check, message: "The restore failed. Nothing was restored. Try again." });
      return;
    }
    if (body.size > MAX_COMPRESSED_BYTES) {
      setStep({ kind: "failed", fileName, text, check, message: "This backup is too big to restore in one go." });
      return;
    }
    // From here the request is on its way: a restore can run for up to 40 s, and the database may commit after the connection drops, so
    // when no answer comes back from the route (a thrown fetch, or a gateway's own page such as an HTML 504) the page can't say "Nothing was restored".
    const lost = () => setStep({ kind: "failed", fileName, text, check, message: LOST_CONNECTION_MESSAGE });
    try {
      const res = await (post ?? fetch)(`/w/${slug}/restore/bundle`, {
        method: "POST",
        headers: { "Content-Type": "application/gzip", "X-Backup-Name": encodeURIComponent(fileName) },
        body,
      });
      const answer = (await res.json().catch(() => null)) as { message?: unknown; processes?: unknown[]; settings?: string } | null;
      if (!res.ok) {
        // The route's own answers carry a message; anything else came from somewhere between.
        if (typeof answer?.message === "string" && answer.message) setStep({ kind: "failed", fileName, text, check, message: answer.message });
        else lost();
        return;
      }
      try {
        document.cookie = `${RESTORE_NOTICE_COOKIE}=${noticeCookieValue(restoredMessage((answer?.processes ?? []).length, answer?.settings ?? "none"))}; path=/; max-age=60; samesite=lax`;
      } catch {
        // The notice is only a courtesy.
      }
      router.push(`/w/${slug}`);
      router.refresh();
    } catch {
      lost();
    }
  }

  const check = step.kind === "ready" || step.kind === "failed" ? step.check : null;
  const busy = step.kind === "restoring";
  const chosen = step.kind === "ready" || step.kind === "failed" || step.kind === "restoring" ? step.fileName : null;
  return (
    <div data-restore-backup className="flex flex-col gap-6">
      <SectionCard id="restore-file" title="1. Choose the backup" description="The .json file an export made (Export → JSON backup). Nothing is sent until you press Restore.">
        {/* The drop zone is the file input's label: a click opens the picker, and a file dropped on it is read the same way. */}
        <label
          htmlFor={inputId}
          data-restore-drop
          data-dragging={dragging || undefined}
          onDragOver={(e) => {
            if (busy) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!busy) void choose(e.dataTransfer.files?.[0]);
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-line px-6 py-8 text-center text-sm text-fg-2 transition-colors hover:border-accent hover:bg-accent-soft/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
            dragging && "border-accent bg-accent-soft/60",
            busy && "pointer-events-none opacity-60",
          )}
        >
          <FileJson aria-hidden className="size-8 text-fg-3" />
          <span className="font-medium text-foreground">{chosen ?? "Drop the backup file here, or click to choose it"}</span>
          <span className="text-xs">{chosen ? "Choose another file to replace it." : `A .json file of up to ${mb(MAX_BACKUP_BYTES)}.`}</span>
          <span className="sr-only">Backup file</span>
          <input
            id={inputId}
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(e) => void choose(e.target.files?.[0])}
            className="sr-only"
          />
        </label>

        {step.kind === "problem" && (
          <p role="alert" data-restore-problem className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            {step.message}
          </p>
        )}
      </SectionCard>

      {check && (
        <SectionCard id="restore-summary" title="2. Check what comes back">
          <section data-restore-summary className="flex flex-col gap-3 text-sm">
            {check.errors.length > 0 && (
              <div role="alert" data-restore-errors className="rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                <p className="font-medium">This backup can&apos;t be restored:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {check.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
            {check.ok && (
              <>
                <div>
                  <h3 className="text-sm font-semibold">Will be restored</h3>
                  <Lines lines={check.summary.restored} />
                  {check.summary.settings !== "none" && (
                    <p className="mt-1 text-fg-2">
                      {check.summary.settings === "applied"
                        ? "The workspace settings (hours a week, horizon, currency) are applied."
                        : "The workspace settings are not applied, because only an Agency admin or the Owner can apply them. This workspace keeps its own."}
                    </p>
                  )}
                </div>
                {check.summary.leftOut.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold">Stays in the file</h3>
                    <Lines lines={check.summary.leftOut} />
                  </div>
                )}
                <p className="max-w-prose text-fg-2">
                  A backup never holds members, people&apos;s emails, API tokens, share links, so they are not restored. Dismissed items come
                  back dismissed and may show again after the first publish. This workspace keeps its own company map.
                </p>
                {check.warnings.length > 0 && (
                  <div data-restore-warnings>
                    <h3 className="text-sm font-semibold">Worth knowing</h3>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {check.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </section>
        </SectionCard>
      )}

      {(step.kind === "ready" || step.kind === "failed" || step.kind === "restoring") && (
        <SectionCard id="restore-run" title="3. Restore" description="Every process comes back as a draft of its latest published version; publish each to see its numbers.">
          {step.kind === "failed" && (
            <p role="alert" data-restore-failed className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
              {step.message}
            </p>
          )}
          <div>
            <Button
              type="button"
              data-restore-submit
              disabled={busy || !check?.ok}
              onClick={() => {
                if (step.kind === "ready" || step.kind === "failed") void restore(step.fileName, step.text, step.check);
              }}
            >
              {busy ? "Restoring…" : "Restore"}
            </Button>
            {busy && (
              <p data-restore-wait role="status" className="mt-2 text-sm text-fg-2">
                A big backup can take up to a minute. Keep this page open.
              </p>
            )}
          </div>
        </SectionCard>
      )}
    </div>
  );
}
