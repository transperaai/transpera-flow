"use client";

import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { SettingsSection } from "@/app/w/[slug]/settings/section";
import type { removeWorkspaceLogo, saveBrandAccent } from "@/app/w/[slug]/settings/branding/actions";
import { ConflictPrompt } from "@/components/fields";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { failureMessage, formatRatio, resolveBranding, type Branding, type LogoResult } from "@/lib/branding/branding";
import { DEFAULT_ACCENT, SURFACES, checkAccent, contrastRatio, deriveDarkAccent, normaliseHex, reservedClash, type Hex, type Theme } from "@/lib/branding/contrast";
import { previewVars } from "@/lib/branding/preview";
import { uploadWorkspaceLogo } from "@/lib/branding/upload";
import { useField, type Field } from "@/lib/fields/use-field";

// Settings -> Branding (issue #34, B5): a workspace's logo and accent colour. Owners and agency admins change them; everyone
// else sees them. The writes come in as props (the server actions, or stand-ins in the browser tests). The readouts and the
// preview use the same contrast maths as the server, which checks again before saving.

const READ_ONLY = "Only workspace owners can change this.";
const NOT_A_COLOUR = "Enter a colour as six hex digits, like #0b6e8a.";

const CLASH_NOTE = {
  editing: "the purple that marks editing screens",
  critical: "the red that marks critical problems",
  warning: "the amber that marks warnings",
  good: "the green that marks things going well",
} as const;

export interface BrandingSettingsProps {
  mode: "live" | "readonly";
  workspaceId: string;
  name: string;
  branding: Branding;
  /** The logo's public URL, or null. */
  logoUrl: string | null;
  saveAccent: typeof saveBrandAccent;
  removeLogo: typeof removeWorkspaceLogo;
  /** Uploads a file and keeps it; the browser's Storage upload and then the server action by default. */
  uploadLogo?: (workspaceId: string, base: string | null, file: File) => Promise<LogoResult>;
}

/** What to say about the colour in a box, for one theme: its verdict, the text, and the fix that passes. */
function readColour(draft: string | null, theme: Theme): { kind: "default" | "invalid" | "fails" | "passes"; hex: Hex | null; text: string; fix: Hex | null; ratio: number | null } {
  if (draft === null || draft.trim() === "") {
    const hex = DEFAULT_ACCENT[theme];
    return { kind: "default", hex, text: "", fix: null, ratio: contrastRatio(hex, SURFACES[theme].bg) };
  }
  const hex = normaliseHex(draft);
  if (!hex) return { kind: "invalid", hex: null, text: NOT_A_COLOUR, fix: null, ratio: null };
  const verdict = checkAccent(hex, theme);
  if (!verdict.ok) return { kind: "fails", hex, text: failureMessage(verdict, theme), fix: verdict.suggestion, ratio: null };
  return { kind: "passes", hex, text: "", fix: null, ratio: contrastRatio(hex, SURFACES[theme].bg) };
}

const themeName = (theme: Theme) => (theme === "light" ? "Light theme" : "Dark theme");

function Status({ field, mine }: { field: Field<string | null>; mine: string }) {
  if (field.phase === "saving") {
    return (
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Saving…
      </p>
    );
  }
  if (field.phase === "conflict") {
    return <ConflictPrompt theirs={field.theirs ?? "the default"} mine={mine || "the default"} onKeepMine={() => void field.keepMine()} onKeepTheirs={field.keepTheirs} />;
  }
  if (field.phase === "error") {
    return (
      <p role="alert" className="text-xs text-crit">
        {field.message}{" "}
        <button type="button" onClick={field.revert} className="underline">
          Undo
        </button>
      </p>
    );
  }
  return null;
}

/** One accent colour: a picker, a hex box, the live readout, the nearest passing colour, and Reset. */
function AccentControl({
  theme,
  label,
  field,
  disabled,
  resetLabel,
  readout,
  fallback,
}: {
  theme: Theme;
  label: string;
  field: Field<string | null>;
  disabled: boolean;
  resetLabel: string;
  /** The line under the box when the colour passes (or is the default). */
  readout: (r: ReturnType<typeof readColour>) => string;
  /** What the picker shows while the box is empty. */
  fallback: Hex;
}) {
  const id = useId();
  const r = readColour(field.draft, theme);
  const clash = r.hex && (r.kind === "passes" || r.kind === "default") ? reservedClash(r.hex, theme) : null;
  // Saves only a colour that parses and passes; anything else stays in the box, with the readout saying why.
  const commit = (value: string | null = field.draft) => {
    if (value === null || value.trim() === "") return;
    const hex = normaliseHex(value);
    if (!hex || !checkAccent(hex, theme).ok) return;
    void field.commit(hex);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="color"
          aria-label={`${label}, colour picker`}
          disabled={disabled}
          value={normaliseHex(field.draft ?? "") ?? fallback}
          onChange={(e) => field.edit(e.target.value)}
          onBlur={() => commit()}
          className="size-8 shrink-0 cursor-pointer rounded-md border border-line bg-panel p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Input
          id={id}
          aria-label={label}
          aria-describedby={`${id}-readout`}
          aria-invalid={r.kind === "invalid" || r.kind === "fails" || undefined}
          disabled={disabled}
          placeholder="Default"
          spellCheck={false}
          autoComplete="off"
          value={field.draft ?? ""}
          onChange={(e) => field.edit(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === "Escape") field.revert();
            if (e.key === "Enter") commit();
          }}
          className="w-32 font-mono"
        />
        <Button type="button" variant="outline" size="sm" disabled={disabled || (field.base === null && (field.draft ?? "") === "")} onClick={() => void field.commit(null)}>
          {resetLabel}
        </Button>
      </div>
      <div id={`${id}-readout`} aria-live="polite" className="flex flex-col gap-1 text-xs">
        {r.kind === "fails" || r.kind === "invalid" ? (
          <p className="text-crit">{r.text}</p>
        ) : (
          <p className="text-fg-2">{readout(r)}</p>
        )}
        {r.kind === "fails" && field.draft === field.base && (
          <p className="text-muted-foreground">This saved colour isn&apos;t being used; the default stays until you change it.</p>
        )}
        {r.fix && (
          <div>
            <Button type="button" size="xs" disabled={disabled} onClick={() => void field.commit(r.fix)}>
              Use {r.fix}
            </Button>
          </div>
        )}
        {clash && <p className="text-muted-foreground">This is close to {CLASH_NOTE[clash]}; people may misread it.</p>}
      </div>
      <Status field={field} mine={field.draft ?? ""} />
    </div>
  );
}

function Panel({ theme, accent, accentDark, children, label }: { theme: Theme; accent: Hex | null; accentDark: Hex | null; children: ReactNode; label: string }) {
  // The preview sets the tokens on its own wrapper: it is the only place that does.
  const resolved = resolveBranding({ accent, accentDark, logoPath: null });
  const vars = previewVars(theme, theme === "light" ? resolved.light : resolved.dark);
  return (
    <div role="group" aria-label={label} style={vars as CSSProperties} className="flex min-w-0 flex-1 flex-col gap-3 rounded-lg border border-line bg-bg p-4 text-fg">
      {children}
    </div>
  );
}

export function BrandingSettings({ mode, workspaceId, name, branding, logoUrl, saveAccent, removeLogo, uploadLogo = uploadWorkspaceLogo }: BrandingSettingsProps) {
  const disabled = mode === "readonly";
  const light = useField<string | null>(branding.accent, (base, next) => saveAccent(workspaceId, "light", base, next));
  const dark = useField<string | null>(branding.accentDark, (base, next) => saveAccent(workspaceId, "dark", base, next));

  // The logo: the path it is stored under (the base for the next change), and the URL it shows from.
  const [logo, setLogo] = useState<{ path: string | null; url: string | null }>({ path: branding.logoPath, url: logoUrl });
  const [broken, setBroken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const shownLogo = logo.url && broken !== logo.url ? logo.url : null;

  const apply = (result: LogoResult, done: string) => {
    if (result.status === "ok") {
      setLogo({ path: result.path, url: result.url });
      setNotice({ tone: "ok", text: done });
    } else setNotice({ tone: "error", text: result.message });
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setNotice({ tone: "ok", text: "Uploading…" });
    try {
      apply(await uploadLogo(workspaceId, logo.path, file), "Logo saved.");
    } catch {
      setNotice({ tone: "error", text: "Couldn't upload the logo. Try again." });
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const remove = async () => {
    if (!logo.path) return;
    setBusy(true);
    setNotice(null);
    try {
      apply(await removeLogo(workspaceId, logo.path), "Logo removed.");
    } catch {
      setNotice({ tone: "error", text: "Couldn't remove the logo. Try again." });
    } finally {
      setBusy(false);
    }
  };

  // What the preview shows: the colours in the boxes that parse and pass; anything else leaves the default.
  const lightRead = readColour(light.draft, "light");
  const darkRead = readColour(dark.draft, "dark");
  const lightOk = lightRead.kind === "passes" ? lightRead.hex : null;
  const darkOk = darkRead.kind === "passes" ? darkRead.hex : null;
  const automatic = dark.base === null && (dark.draft ?? "") === "";
  const autoDark = lightOk ? deriveDarkAccent(lightOk) : DEFAULT_ACCENT.dark;

  const monogram = name.trim().charAt(0).toUpperCase() || "T";
  const tile = (size: "sm" | "lg") =>
    shownLogo ? (
      <span aria-hidden data-allow-light className={`grid shrink-0 place-items-center overflow-hidden rounded-md bg-logo-tile ring-1 ring-line ${size === "sm" ? "size-8" : "size-24"}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a small public logo; no optimiser, no remotePatterns */}
        <img src={shownLogo} alt="" decoding="async" className="size-full object-contain p-0.5" onError={() => setBroken(shownLogo)} />
      </span>
    ) : (
      <span aria-hidden className={`grid shrink-0 place-items-center rounded-md bg-accent font-display font-bold text-accent-fg ${size === "sm" ? "size-8 text-sm" : "size-24 text-3xl"}`}>
        {monogram}
      </span>
    );

  return (
    <>
      <SettingsSection id="logo" title="Logo" description="Shown at the top of the sidebar for everyone in this workspace.">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center text-xs font-medium text-fg-2">
            Company logo
            <Help label="Company logo" description="Your logo, shown at the top of the sidebar for everyone in this workspace." example="A 256 × 256 PNG of the company mark." />
          </span>
        </div>
        <div className="flex flex-wrap gap-3" data-logo-preview>
          <div role="group" aria-label="Logo in the sidebar" className="flex items-center gap-3 rounded-lg border border-line bg-panel p-3">
            {tile("sm")}
            <span className="text-xs text-muted-foreground">In the sidebar</span>
          </div>
          {(["light", "dark"] as const).map((theme) => (
            <div key={theme} role="group" aria-label={`Logo on a ${theme} page`} style={previewVars(theme, null) as CSSProperties} className="flex items-center gap-3 rounded-lg border border-line bg-bg p-3 text-fg">
              {tile("lg")}
              <span className="text-xs text-fg-2">On a {theme} page</span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void upload(e.target.files?.[0])} />
          <Button type="button" variant="outline" disabled={disabled || busy} onClick={() => fileInput.current?.click()}>
            Upload logo
          </Button>
          <Button type="button" variant="ghost" disabled={disabled || busy || !logo.path} onClick={() => void remove()}>
            Remove
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {disabled ? READ_ONLY : "PNG, JPG or WebP, up to 512 KB and 2048 × 2048 pixels. A square logo with a transparent background works best."}
        </p>
        <p aria-live="polite" role="status" className={notice?.tone === "error" ? "text-xs text-crit" : "text-xs text-muted-foreground"} data-logo-status>
          {notice?.text ?? ""}
        </p>
      </SettingsSection>

      <SettingsSection id="accent" title="Accent colour" description="The colour of buttons, links and highlights in this workspace. It must be readable on light and dark backgrounds.">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="flex items-center text-xs font-medium text-fg-2">
              Accent colour
              <Help
                label="Accent colour"
                description="The colour of buttons, links and highlights in this workspace. It must be readable on light and dark backgrounds."
                example="A brand purple like #7a1fa2; dark mode then uses a lighter shade of it."
              />
            </span>
            <AccentControl
              theme="light"
              label="Accent colour"
              field={light}
              disabled={disabled}
              resetLabel="Reset to default"
              fallback={DEFAULT_ACCENT.light}
              readout={(r) => (r.kind === "default" ? `Light theme: Transpera's default, ${formatRatio(r.ratio ?? 0, true)} on the page. Passes.` : `Light theme: ${formatRatio(r.ratio ?? 0, true)} on the page. Passes.`)}
            />
            <p className="text-xs text-fg-2" data-dark-readout>
              {automatic
                ? `Dark theme (automatic): ${autoDark}, ${formatRatio(contrastRatio(autoDark, SURFACES.dark.bg), true)} on the page. Passes.`
                : darkOk
                  ? `Dark theme (your colour): ${darkOk}, ${formatRatio(contrastRatio(darkOk, SURFACES.dark.bg), true)} on the page. Passes.`
                  : "Dark theme: the colour below doesn't pass yet, so dark mode keeps the automatic shade."}
            </p>
            {disabled && <p className="text-xs text-muted-foreground">{READ_ONLY}</p>}
          </div>

          <details className="group rounded-lg border border-line p-3" open={branding.accentDark !== null || undefined}>
            <summary className="cursor-pointer text-sm font-medium text-fg-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">Use a different colour in dark mode</summary>
            <div className="mt-3 flex flex-col gap-1">
              <span className="flex items-center text-xs font-medium text-fg-2">
                Dark mode accent
                <Help
                  label="Dark mode accent"
                  description="By default dark mode uses a lighter shade of your accent so it stays readable. Set your own here if you prefer a different colour on dark pages."
                  example="A pale lavender for dark mode beside a deep purple in light mode."
                />
              </span>
              <AccentControl
                theme="dark"
                label="Dark mode accent"
                field={dark}
                disabled={disabled}
                resetLabel="Use automatic"
                fallback={autoDark}
                readout={(r) => (r.kind === "default" ? "Dark theme: automatic, a lighter shade of the accent." : `Dark theme: ${formatRatio(r.ratio ?? 0, true)} on the page. Passes.`)}
              />
            </div>
          </details>
        </div>
      </SettingsSection>

      <SettingsSection id="preview" title="Preview" description="How buttons, links, counts and focused fields look in each theme.">
        <div className="grid gap-3 sm:grid-cols-2" data-brand-preview>
          {(["light", "dark"] as const).map((theme) => (
            <Panel key={theme} theme={theme} accent={lightOk} accentDark={darkOk} label={`${themeName(theme)} preview`}>
              <span className="text-xs font-medium text-fg-2">{themeName(theme)}</span>
              <div aria-hidden className="flex flex-wrap items-center gap-3">
                <span className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg">Run simulation</span>
                <span className="text-sm text-accent underline">A link</span>
                <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[11px] text-accent">3</span>
              </div>
              <div aria-hidden className="rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm text-fg-2 ring-2 ring-accent">
                A focused field
              </div>
            </Panel>
          ))}
        </div>
      </SettingsSection>
    </>
  );
}
