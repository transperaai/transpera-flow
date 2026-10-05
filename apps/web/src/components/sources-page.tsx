"use client";

// The Sources library (docs/PRD.md §8 screen 7, issues #21, #118, #176): transcripts, notes, data exports and screenshots from
// the audit as a searchable table. A row opens a side panel with the full text, what it is linked to ("Link to…") and the values
// that quote it, so any inferred number can be traced to what someone said. A source linked to nothing is flagged: it doesn't
// count as evidence.

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  EVIDENCE_LABELS,
  formatParameter,
  isEvidenceColumn,
  unlinkedSources,
  type LinkTargets,
  type SourceCitation,
  type SourceLinkRow,
  type SourceRow,
} from "@transpera-flow/db";
import { DateField, SelectField, TextField } from "@/components/fields";
import { LinkChips, LinkedToLabel, UnlinkedWarning } from "@/components/sources/link-chips";
import { SourceDialog, type SourceSubmission } from "@/components/sources/source-dialog";
import { SourcesLibrary } from "@/components/sources/sources-library";
import { buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { Saver } from "@/lib/fields/field-controller";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { demoSourceStore } from "@/lib/sources/demo-store";
import { liveSourceStore } from "@/lib/sources/live-store";
import { MemorySourceStore, sourceFieldValue, type SourceStore } from "@/lib/sources/store";
import { SOURCE_KIND_LABELS, SOURCE_KINDS, parseSpeakers, type SourceField } from "@/lib/sources/validate";

/** Plain-English (i) text for a source's fields, with an example (issue #123). */
const SOURCE_HELP = {
  kind: { description: "What sort of material this is: a transcript of a conversation, notes someone wrote up, a data export, or a screenshot.", example: "Transcript, for the typed-up discovery interview." },
  title: { description: "A name that tells people what this is.", example: "Discovery interview with Maya." },
  speakers: { description: "Who is talking or wrote it, separated by commas. Quotes show who said them.", example: "Maya Collins, Rosa Diaz." },
  date: { description: "When it was recorded or written.", example: "3 October." },
  link: { description: "Where the original file or recording lives, if you have one.", example: "A link to the recording or screenshot." },
  body: { description: "The words themselves. Values in the model can quote from here as their evidence.", example: "Maya: \"A proper audit is a day's work.\"" },
} as const;


const button = buttonVariants({ variant: "outline", size: "sm" });
const primary = buttonVariants({ size: "sm" });
const kindOptions = SOURCE_KINDS.map((k) => ({ value: k, label: SOURCE_KIND_LABELS[k] }));

const FIELD_NAMES: Record<string, string> = {
  volume_week: "leads a week",
  conversion_to_qualified: "conversion to qualified",
  multiplier: "multiplier",
  growth_monthly: "monthly growth",
};

/** "Audit & proposal · hands-on time". */
const citedWhat = (c: SourceCitation) =>
  `${c.rowName} · ${isEvidenceColumn(c.column) ? EVIDENCE_LABELS[c.column] : (FIELD_NAMES[c.column] ?? c.column)}`;
const statedValue = (c: SourceCitation) =>
  typeof c.value === "number" ? (isEvidenceColumn(c.column) ? formatParameter(c.column, c.value) : String(c.value)) : null;

export function SourcesPage({
  workspaceId,
  sources: initial,
  citations,
  links: initialLinks,
  targets: initialTargets,
  mode,
  processBase,
  initialOpenId = null,
}: {
  workspaceId: string;
  sources: SourceRow[];
  /** What cites each source, by source id. */
  citations: Record<string, SourceCitation[]>;
  /** What each source is linked to. */
  links: SourceLinkRow[];
  /** What a source can be linked to, for the dialog and the chips. */
  targets: LinkTargets;
  mode: "live" | "demo" | "readonly";
  /** Link to the process page, so a citing step can be opened. */
  processBase?: string;
  /** A source to open in the side panel on arrival. */
  initialOpenId?: string | null;
}) {
  const canEdit = mode !== "readonly";
  const router = useRouter();
  const demoSolutions = useDemoSolutions().solutions;
  // In the demo every page of the tab shares one store, so a link made on a step or an issue is here too.
  const [store] = useState<SourceStore>(() =>
    mode === "live" ? liveSourceStore(workspaceId) : mode === "demo" ? demoSourceStore(workspaceId, initial, initialLinks) : new MemorySourceStore(workspaceId, initial, undefined, initialLinks),
  );
  const shared = mode === "demo" && store instanceof MemorySourceStore ? store.snapshot() : null;
  const [sources, setSources] = useState(shared?.sources ?? initial);
  const [links, setLinks] = useState(shared?.links ?? initialLinks);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ source: SourceRow | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const open = sources.find((x) => x.id === openId) ?? null;
  const cited = new Set(Object.keys(citations));
  const orphans = Object.entries(citations).filter(([id]) => !sources.some((s) => s.id === id));
  const unlinked = unlinkedSources(sources, links);
  // The demo's solutions live in the tab; a workspace's come with the page.
  const targets = mode === "demo" ? { ...initialTargets, solutions: demoSolutions.map((s) => ({ id: s.id, name: s.name })) } : initialTargets;
  // The sidebar's count comes from the server: ask for it again after a change.
  const changed = (message: string) => {
    setStatus(message);
    setError(null);
    if (mode === "live") router.refresh();
  };

  const saver =
    (id: string, field: SourceField): Saver<string | null> =>
    async (base, next) => {
      const outcome = await store.saveField(id, field, base, next);
      if (outcome.status === "saved") {
        const value = field === "speakers" ? parseSpeakers(outcome.value as string | null) : outcome.value;
        setSources((list) => list.map((s) => (s.id === id ? ({ ...s, [field]: value } as SourceRow) : s)));
      }
      return outcome as Awaited<ReturnType<Saver<string | null>>>;
    };

  const submit = async (s: SourceSubmission): Promise<string | null> => {
    if (s.kind === "add") {
      const r = await store.create(s.input, [s.link]);
      if (r.status === "error") return r.message;
      setSources((list) => [r.source, ...list]);
      setLinks((list) => [...list, ...r.links]);
      changed("Source added and linked.");
      return null;
    }
    const r = await store.link(s.source.id, s.link);
    if (r.status === "error") return r.message;
    setLinks((list) => [...list, r.link]);
    changed("Source linked.");
    return null;
  };

  const unlink = async (link: SourceLinkRow) => {
    setBusy(true);
    try {
      const r = await store.unlink(link.id);
      if (r.status === "error") return setError(r.message);
      setLinks((list) => list.filter((l) => l.id !== link.id));
      changed("Link removed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-fg-2">
          {canEdit ? "Owners and editors add sources and link them." : "You can read the sources here; owners and editors can add and change them."}
          {unlinked.length > 0 && (
            <span className="ml-1 font-semibold text-fg" data-unlinked-count={unlinked.length}>
              {unlinked.length === 1 ? "1 source isn't linked to anything yet." : `${unlinked.length} sources aren't linked to anything yet.`}
            </span>
          )}
        </p>
        {canEdit && (
          <button type="button" className={primary} onClick={() => setDialog({ source: null })}>
            + Add source
          </button>
        )}
      </div>
      <p role="status" aria-live="polite" className={status ? "text-xs text-fg-2" : "sr-only"}>
        {status}
      </p>
      {error && (
        <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2">
          {error}{" "}
          <button type="button" className="underline" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}
      {sources.length === 0 ? (
        <p data-no-sources className="rounded-lg border border-dashed border-line p-4 text-fg-2">
          No sources yet. Add the audit&apos;s transcripts and notes and link each one to what it is evidence for (a process, a step, an
          insight, an issue or a solution), or let Claude add them through the MCP server, so every number can be traced to what someone said.
        </p>
      ) : (
        <SourcesLibrary
          sources={sources}
          links={links}
          targets={targets}
          citations={Object.fromEntries(Object.entries(citations).map(([id, list]) => [id, list.length]))}
          openId={openId}
          onOpen={setOpenId}
        />
      )}
      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent side="right" className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl" aria-describedby={undefined} data-source-panel>
          {open && (
            <SourcePanel
              key={open.id}
              source={open}
              citations={citations[open.id] ?? []}
              links={links.filter((l) => l.source_id === open.id)}
              targets={targets}
              canEdit={canEdit}
              busy={busy}
              saver={saver}
              processBase={processBase}
              onLink={() => setDialog({ source: open })}
              onUnlink={(l) => void unlink(l)}
              onRemove={async () => {
                const r = await store.remove(open.id);
                if (r.status === "error") setError(r.message);
                else {
                  setOpenId(null);
                  setSources((list) => list.filter((x) => x.id !== open.id));
                  setLinks((list) => list.filter((l) => l.source_id !== open.id));
                  changed("Source deleted.");
                }
              }}
              cited={cited.has(open.id)}
            />
          )}
        </SheetContent>
      </Sheet>
      {orphans.length > 0 && (
        <section aria-label="Citations of deleted sources" className="rounded-lg border border-warn bg-warn-soft p-3 text-xs">
          <h2 className="mb-1 text-sm font-bold">Citing a deleted source</h2>
          <Citations citations={orphans.flatMap(([, list]) => list)} processBase={processBase} />
        </section>
      )}
      <SourceDialog open={dialog !== null} source={dialog?.source ?? null} targets={targets} onSubmit={submit} onClose={() => setDialog(null)} />
    </div>
  );
}

function SourcePanel({
  source: s,
  citations,
  links,
  targets,
  canEdit,
  busy,
  saver,
  onLink,
  onUnlink,
  onRemove,
  processBase,
  cited,
}: {
  source: SourceRow;
  citations: SourceCitation[];
  links: SourceLinkRow[];
  targets: LinkTargets;
  canEdit: boolean;
  busy: boolean;
  saver: (id: string, field: SourceField) => Saver<string | null>;
  onLink: () => void;
  onUnlink: (link: SourceLinkRow) => void;
  onRemove: () => Promise<void>;
  processBase?: string;
  cited: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const value = (f: SourceField) => sourceFieldValue(s, f) as string | null;
  const text = (s.body ?? "").trim();
  return (
    <article aria-label={s.title} data-linked={links.length > 0} className="flex flex-col gap-3 p-4">
      <SheetHeader className="p-0 pr-10">
        <SheetTitle className="text-base font-bold">{s.title}</SheetTitle>
        <SheetDescription asChild>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="rounded-full border border-line px-1.5 text-[11px] font-semibold text-fg-2">{SOURCE_KIND_LABELS[s.kind]}</span>
            {s.recorded_at && <span className="text-fg-3 tabular-nums">{s.recorded_at}</span>}
            {s.speakers.length > 0 && <span className="text-fg-2">{s.speakers.join(", ")}</span>}
            <span className="text-fg-3">{citations.length ? `Cited by ${citations.length} value${citations.length === 1 ? "" : "s"}` : "Not cited yet"}</span>
          </div>
        </SheetDescription>
      </SheetHeader>
      {canEdit && (
        <div>
          <button type="button" className={button} onClick={onLink} aria-label={`Link ${s.title} to something`}>
            Link to…
          </button>
        </div>
      )}
      {links.length > 0 ? (
        <div className="flex flex-col gap-1">
          <LinkedToLabel />
          <LinkChips links={links} targets={targets} onUnlink={canEdit ? onUnlink : undefined} disabled={busy} />
        </div>
      ) : (
        <UnlinkedWarning />
      )}
      <section aria-label="Full text" className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold text-fg-2">Full text</h3>
        {text ? (
          <p data-full-text className="max-h-80 overflow-y-auto rounded-lg bg-panel-2 p-2 whitespace-pre-wrap break-words text-fg">
            {text}
          </p>
        ) : (
          <p className="text-fg-3">No text. {s.file_url ? "The original is at the link below." : "Add some under Details and edit."}</p>
        )}
        {s.file_url && (
          <a href={s.file_url} target="_blank" rel="noreferrer noopener" className="text-xs text-accent underline">
            Open {s.kind === "screenshot" ? "the screenshot" : "the file"}
          </a>
        )}
      </section>
      <section aria-label="Cited in" className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold text-fg-2">Cited in</h3>
        {citations.length ? <Citations citations={citations} processBase={processBase} /> : <p className="text-fg-3">No value quotes this yet. Cite it from a step&apos;s details.</p>}
      </section>
      <details className="mt-1">
        <summary className="cursor-pointer text-fg-2 hover:underline">{canEdit ? "Details and edit" : "Details"}</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <TextField label="Title" value={s.title} save={saver(s.id, "title")} disabled={!canEdit} help={SOURCE_HELP.title} />
          <SelectField
            label="Kind"
            value={s.kind}
            options={kindOptions}
            save={saver(s.id, "kind")}
            disabled={!canEdit}
            help={SOURCE_HELP.kind}
          />
          <TextField
            label="Speakers"
            value={value("speakers")}
            optional
            save={saver(s.id, "speakers")}
            disabled={!canEdit}
            hint="Comma-separated."
            help={SOURCE_HELP.speakers}
          />
          <DateField label="Date" value={s.recorded_at} save={saver(s.id, "recorded_at")} disabled={!canEdit} help={SOURCE_HELP.date} />
          <div className="sm:col-span-2">
            <TextField label="Link (file or recording)" value={s.file_url} optional save={saver(s.id, "file_url")} disabled={!canEdit} help={SOURCE_HELP.link} />
          </div>
          <div className="sm:col-span-2">
            <TextField label="Transcript or notes" value={s.body} optional multiline save={saver(s.id, "body")} disabled={!canEdit} help={SOURCE_HELP.body} />
          </div>
        </div>
        {canEdit &&
          (confirming ? (
            <div role="alertdialog" aria-label={`Delete ${s.title}`} className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-crit bg-crit-soft p-2">
              <p className="grow">
                Delete this source?{" "}
                {cited ? "The values citing it keep their quotes, listed as citing a deleted source." : "Nothing cites it."}
              </p>
              <button type="button" className="rounded-lg border border-crit px-2 py-1 font-semibold text-crit" onClick={() => void onRemove()}>
                Delete source
              </button>
              <button type="button" className={button} onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </div>
          ) : (
            <button type="button" className="mt-2 rounded-lg border border-crit px-2 py-1 text-crit hover:bg-crit-soft" onClick={() => setConfirming(true)}>
              Delete source…
            </button>
          ))}
      </details>
    </article>
  );
}

function Citations({ citations, processBase }: { citations: SourceCitation[]; processBase?: string }) {
  if (!citations.length) return null;
  return (
    <ul aria-label="Values citing this source" className="mt-2 flex flex-col gap-1.5">
      {citations.map((c, i) => {
        const value = statedValue(c);
        const what = citedWhat(c);
        return (
          <li key={`${c.table}:${c.rowId}:${c.column}:${i}`} className="rounded-lg bg-panel-2 px-2 py-1.5 text-xs">
            <p className="flex flex-wrap items-baseline gap-x-2">
              {c.processId && processBase ? (
                <a href={`${processBase}/${c.processId}`} className="font-semibold hover:underline">
                  {what}
                </a>
              ) : (
                <span className="font-semibold">{what}</span>
              )}
              {value && <span className="tabular-nums text-fg-2">says {value}</span>}
              {c.revision === "draft" && <span className="rounded-full border border-dashed border-accent px-1 text-[10px]">draft only</span>}
            </p>
            <blockquote className="mt-0.5 text-fg-2">
              “{c.quote}”{c.speaker ? <span className="text-fg-3"> · {c.speaker}</span> : null}
              {c.timestamp ? <span className="text-fg-3 tabular-nums"> · {c.timestamp}</span> : null}
            </blockquote>
          </li>
        );
      })}
    </ul>
  );
}
