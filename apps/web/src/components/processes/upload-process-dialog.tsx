"use client";

// "Upload process" on the Processes page (issue #166, B13): bring in a process someone, usually Claude, wrote as a file.
// Choose a file (or drop one), see what it would create and anything wrong with it in plain words, map the roles the
// company doesn't have, then create. The upload lands as a draft: nothing is live until it is published, and it never adds
// roles, people or clients. "Copy prompt for Claude" and "Download example" are for making the file in the first place.

import { useMemo, useState, useTransition, type DragEvent } from "react";
import { FileJson, Upload } from "lucide-react";
import { processTextFrom } from "@transpera-flow/db/process-file";
import { claudePrompt2, PROCESS_FILE_EXAMPLE_2 } from "@transpera-flow/db/process-file-2-schema";
import { findGaps } from "@transpera-flow/db/simulation-gaps";
import { Help } from "@/components/help";
import { GAPS_HELP, GapList } from "@/components/simulation-gaps";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { downloadHref, fileSizeProblem, isRedirect, uploadSizeProblem, type CreateUploadInput, type CreateUploadResult, type PreviewInput, type PreviewResult, type UploadPreview } from "@/lib/processes/upload";
import { cn } from "@/lib/utils";
import { EDIT_ONLY } from "@/lib/phone";

export interface UploadProcess {
  /** Check the file and say what it would create (writes nothing). */
  preview: (input: PreviewInput) => Promise<PreviewResult>;
  /** Create the process as a draft. Opens it in the editor, so it only comes back with an error. */
  create: (input: CreateUploadInput) => Promise<CreateUploadResult>;
}

/** The most errors or warnings listed at once; the rest are counted. */
const MAX_SHOWN = 20;
const EXAMPLE_TEXT = `${JSON.stringify(PROCESS_FILE_EXAMPLE_2, null, 2)}\n`;
const norm = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The (i) texts: what each part does, in plain words, with an example. */
export const UPLOAD_HELP = {
  upload: {
    label: "Upload process",
    description: "Brings in a process someone, usually Claude, wrote as a JSON file, a Claude Design page (HTML file or link), and makes it a new draft. Nothing is live until you publish it, and it never changes your people, roles or clients.",
    example: "Ask Claude to describe your sales process using the prompt from this dialog, save its reply as a .json file (or let Claude Design make a page), and upload it here.",
  },
  roles: {
    label: "Roles in the file",
    description: "Roles the file names that your company doesn't have yet. Pick one of your roles for each, or leave the step without a role. Uploading never adds a role for you.",
    example: "The file says Sales lead, you call that role Account manager: pick Account manager.",
  },
} as const;

/** The Processes page's "Upload process" button, with its dialog. */
export function UploadProcessButton({ upload }: { upload: UploadProcess }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`inline-flex items-center ${EDIT_ONLY}`} data-edit-entry>
      <Button variant="outline" onClick={() => setOpen(true)} data-upload-open>
        <Upload /> Upload process
      </Button>
      <Help {...UPLOAD_HELP.upload} />
      <UploadProcessDialog open={open} onOpenChange={setOpen} upload={upload} />
    </span>
  );
}

export function UploadProcessDialog({ open, onOpenChange, upload }: { open: boolean; onOpenChange: (open: boolean) => void; upload: UploadProcess }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-xl" data-upload-dialog>
        <DialogHeader>
          <DialogTitle>Upload a process</DialogTitle>
          <DialogDescription>Bring in a process from a file or a link. It becomes a new draft for you to check; nothing goes live until you publish it.</DialogDescription>
        </DialogHeader>
        {/* Keyed on opening, so each time starts from the file choice. */}
        {open && <Flow upload={upload} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

interface Loaded {
  text: string;
  preview: UploadPreview;
}

function Flow({ upload, onCancel }: { upload: UploadProcess; onCancel: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  return loaded ? (
    <Preview upload={upload} loaded={loaded} onBack={() => setLoaded(null)} onCancel={onCancel} />
  ) : (
    <Choose upload={upload} onLoaded={setLoaded} onCancel={onCancel} />
  );
}

function Choose({ upload, onLoaded, onCancel }: { upload: UploadProcess; onLoaded: (l: Loaded) => void; onCancel: () => void }) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"yes" | "blocked" | null>(null);
  const [link, setLink] = useState("");
  const [pending, start] = useTransition();

  const read = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const tooBig = fileSizeProblem(file.size);
    if (tooBig) return setError(tooBig);
    start(async () => {
      try {
        // A .json file is the process; an HTML page carries it in one embedded block, and only that block is sent on.
        const content = await file.text();
        // A .json file (or JSON content type) is the process as it is; anything else is a page, searched for its one embedded block.
        const found = processTextFrom(content, { json: /\.json$/i.test(file.name) || file.type === "application/json" });
        if (found.error !== undefined) return setError(found.error);
        const big = uploadSizeProblem(new Blob([found.text]).size);
        if (big) return setError(big);
        const r = await upload.preview({ kind: "file", text: found.text, fileName: file.name });
        if (r.error !== undefined) setError(r.error);
        else onLoaded({ text: found.text, preview: r.preview });
      } catch {
        setError("Couldn't read that file. Try again.");
      }
    });
  };
  const fetchLink = () => {
    const url = link.trim();
    if (!url) return setError("Paste the link to the page first.");
    setError(null);
    start(async () => {
      try {
        const r = await upload.preview({ kind: "link", url });
        if (r.error !== undefined) setError(r.error);
        else onLoaded({ text: r.text ?? "", preview: r.preview });
      } catch {
        setError("Couldn't open that link. Try again.");
      }
    });
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    read(e.dataTransfer.files[0]);
  };
  const copy = async () => {
    const text = claudePrompt2();
    try {
      await navigator.clipboard.writeText(text);
      setCopied("yes");
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
      setCopied(ok ? "yes" : "blocked");
    }
  };

  return (
    <div className="flex flex-col gap-4" data-upload-step="choose">
      <label
        htmlFor="upload-file"
        data-dropzone
        data-over={over || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-line bg-panel-2 px-4 py-8 text-center transition-colors",
          "hover:border-accent has-[:focus-visible]:border-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring data-[over]:border-accent data-[over]:bg-accent-soft",
        )}
      >
        <FileJson aria-hidden className="size-8 text-fg-3" />
        <span className="text-sm font-medium">{pending ? "Reading…" : "Drop a .json or .html file here, or choose one"}</span>
        <span className="text-xs text-muted-foreground">A process file in the transpera-process/2 (or /1) format, or a Claude Design page that carries one.</span>
        <input
          id="upload-file"
          type="file"
          accept=".json,.html,.htm,application/json,text/html"
          className="sr-only"
          onChange={(e) => {
            read(e.target.files?.[0]);
            // So choosing the same file again (after fixing it) still counts as a choice.
            e.target.value = "";
          }}
        />
      </label>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          fetchLink();
        }}
      >
        <label htmlFor="upload-link" className="text-sm font-medium">
          Or paste a link to a Claude Design page
        </label>
        <div className="flex gap-2">
          <Input id="upload-link" type="url" inputMode="url" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} disabled={pending} data-upload-link />
          <Button type="submit" variant="outline" disabled={pending || !link.trim()} data-upload-fetch>
            Fetch
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">The page has to be viewable by anyone with the link.</p>
      </form>
      {error && (
        <p role="alert" className="text-sm text-crit" data-upload-error>
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <span className="text-sm text-muted-foreground">Don&apos;t have a file yet?</span>
        <Button type="button" variant="outline" size="sm" onClick={copy} data-upload-copy>
          {copied === "yes" ? "Copied" : "Copy prompt for Claude"}
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={downloadHref(EXAMPLE_TEXT)} download="transpera-process-example.json" data-upload-example>
            Download example
          </a>
        </Button>
        <span role="status" className="basis-full text-xs text-muted-foreground">
          {copied === "yes"
            ? "Paste it into Claude along with a description of your process, then save its reply as a .json file."
            : copied === "blocked"
              ? "Your browser didn't allow copying. Download the example and ask Claude to follow its format."
              : "The prompt asks Claude for a process in the right format."}
        </span>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </DialogFooter>
    </div>
  );
}

function Preview({ upload, loaded, onBack, onCancel }: { upload: UploadProcess; loaded: Loaded; onBack: () => void; onCancel: () => void }) {
  const { preview: p, text } = loaded;
  const [name, setName] = useState(p.name);
  // A Map: a role can be called anything, "constructor" and "__proto__" included.
  const [roles, setRoles] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const stopped = p.errors.length > 0;
  // "Missing for simulation": the same check the process page runs, re-run as roles are mapped (a role left blank is still a gap).
  const gaps = useMemo(() => {
    if (!p.gap) return [];
    const mapped = (role: string | undefined) => !!role && !!roles.get(role);
    return findGaps({ ...p.gap.input, steps: p.gap.input.steps.map((s) => ({ ...s, role: s.role || mapped(p.gap!.roleOf[s.id]) })) });
  }, [p.gap, roles]);
  const taken = p.nameTaken !== null && norm(name) === norm(p.nameTaken);
  const blocked = taken || !name.trim();

  const create = () => {
    setError(null);
    start(async () => {
      try {
        const r = await upload.create({ text, source: p.source, name: name.trim(), roleMap: p.unknownRoles.map((role) => [role, roles.get(role) || null]) });
        if (r?.error) setError(r.error);
      } catch (e) {
        // The redirect to the editor ends the page's work here; anything else is a failed request, and is said plainly.
        if (!isRedirect(e)) setError("Couldn't create it. Try again.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-4" data-upload-step="preview">
      <p className="text-xs text-muted-foreground">
        From <b className="font-medium text-foreground break-all">{p.source}</b>
      </p>

      {stopped ? (
        <Problems tone="error" title="This file can't be uploaded yet" items={p.errors} />
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="upload-name" className="text-sm font-medium">
              Process name
            </label>
            <Input id="upload-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-invalid={taken || undefined} />
            {taken && (
              <p role="alert" className="text-sm text-crit" data-upload-taken>
                {`You already have a process called '${p.nameTaken}'. Give this one a different name.`}
              </p>
            )}
          </div>
          <p className="text-sm" data-upload-counts>
            <b>{p.steps}</b> {p.steps === 1 ? "step" : "steps"} · <b>{p.links}</b> {p.links === 1 ? "link" : "links"}
            {p.groups > 0 && (
              <>
                {" "}
                · <b>{p.groups}</b> {p.groups === 1 ? "group" : "groups"}
              </>
            )}{" "}
            · a {p.kind === "pipeline" ? "pipeline" : "servicing process"}
          </p>
          {p.extras && (
            <p className="text-sm" data-upload-extra-counts>
              <b>{p.extras.sources.length}</b> {p.extras.sources.length === 1 ? "source" : "sources"} · <b>{p.extras.suggestions.length}</b> {p.extras.suggestions.length === 1 ? "suggestion" : "suggestions"} · <b>{p.extras.proposals.length}</b>{" "}
              {p.extras.proposals.length === 1 ? "proposal" : "proposals"}
              {p.extras.firstPrinciplesParts > 0 && (
                <>
                  {" "}
                  · first principles: <b>{p.extras.firstPrinciplesParts}</b> {p.extras.firstPrinciplesParts === 1 ? "part" : "parts"}
                </>
              )}
            </p>
          )}
        </>
      )}

      {!stopped && p.extras && p.extras.conflicts.length > 0 && <Problems tone="warning" title="Conflicts (nothing is changed for you)" items={p.extras.conflicts} dataKey="conflicts" />}

      {!stopped && gaps.length > 0 && (
        <div role="status" data-upload-gaps data-missing-for-simulation className="rounded-lg border border-warn bg-warn-soft px-3 py-2.5 text-sm">
          <p className="flex items-center font-medium">
            Missing for simulation ({gaps.length})
            <Help {...GAPS_HELP} />
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">The upload still goes ahead. Fill these in on the map afterwards.</p>
          <div className="mt-1.5 pl-1">
            <GapList gaps={gaps} />
          </div>
        </div>
      )}

      {!stopped && p.extras && (p.extras.sources.length > 0 || p.extras.suggestions.length > 0 || p.extras.proposals.length > 0 || p.extras.notes.length > 0) && (
        <section className="flex flex-col gap-2 text-sm" data-upload-extras>
          <h3 className="font-medium">Comes with it</h3>
          {p.extras.sources.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Added to Sources and linked to this process: {p.extras.sources.map((s) => s.title).join("; ")}.
            </p>
          )}
          {p.extras.suggestions.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground">Waiting in Suggestions for someone to accept or reject. Nothing about your company changes until then.</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                {p.extras.suggestions.slice(0, MAX_SHOWN).map((s, i) => (
                  <li key={i} className="break-words">
                    {s.headline}
                  </li>
                ))}
                {p.extras.suggestions.length > MAX_SHOWN && <li>…and {p.extras.suggestions.length - MAX_SHOWN} more.</li>}
              </ul>
            </div>
          )}
          {p.extras.proposals.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground">Proposed issues and ideas, waiting in Suggestions. None is created until someone accepts it.</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                {p.extras.proposals.map((x, i) => (
                  <li key={i} className="break-words">
                    {x.kind === "issue" ? "Issue" : `Idea for ${x.forIssue}`}: {x.title}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.extras.notes.length > 0 && <Problems tone="warning" title="Left out or changed" items={p.extras.notes} dataKey="notes" />}
        </section>
      )}

      {p.warnings.length > 0 && <Problems tone="warning" title={stopped ? "Also worth knowing" : "Worth a look (the upload still goes ahead)"} items={p.warnings} />}

      {!stopped && (p.unknownRoles.length > 0 || p.matchedRoles.length > 0) && (
        <section className="flex flex-col gap-2" data-upload-roles>
          <h3 className="text-sm font-medium">
            Roles
            <Help {...UPLOAD_HELP.roles} />
          </h3>
          {p.matchedRoles.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Matched to your roles by name: {p.matchedRoles.map((m) => (norm(m.name) === norm(m.role) ? m.role : `${m.name} → ${m.role}`)).join(", ")}.
            </p>
          )}
          {p.unknownRoles.length > 0 && (
            <>
              <p className="text-sm text-muted-foreground">
                {p.unknownRoles.length === 1 ? "This role isn't one of yours" : "These roles aren't ones you have"}. Pick one of yours, or leave the steps without a role. Nothing is added to your roles.
              </p>
              <ul className="flex flex-col gap-2">
                {p.unknownRoles.map((role, i) => (
                  <li key={role} className="grid grid-cols-1 items-center gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-3">
                    <label htmlFor={`upload-role-${i}`} className="text-sm break-words">
                      “{role}”
                    </label>
                    <NativeSelect id={`upload-role-${i}`} value={roles.get(role) ?? ""} onChange={(e) => setRoles((r) => new Map(r).set(role, e.target.value))}>
                      <option value="">No role (leave blank)</option>
                      {p.roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {error && (
        <p role="alert" className="text-sm text-crit" data-upload-error>
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onBack} disabled={pending}>
          Choose a different file
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending} className="sm:hidden">
          Cancel
        </Button>
        {!stopped && (
          <Button type="button" onClick={create} disabled={blocked || pending} data-upload-create>
            {pending ? "Creating…" : "Create draft"}
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}

function Problems({ tone, title, items, dataKey }: { tone: "error" | "warning"; title: string; items: string[]; dataKey?: string }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-upload-problems={dataKey ?? tone}
      className={cn("rounded-lg border px-3 py-2.5 text-sm", tone === "error" ? "border-crit bg-crit-soft" : "border-warn bg-warn-soft")}
    >
      <p className="font-medium">{title}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {items.slice(0, MAX_SHOWN).map((m, i) => (
          <li key={i} className="break-words">
            {m}
          </li>
        ))}
        {items.length > MAX_SHOWN && <li>…and {items.length - MAX_SHOWN} more.</li>}
      </ul>
    </div>
  );
}
