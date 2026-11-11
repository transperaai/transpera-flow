"use client";

// The Export button (issue #39, B10): a small menu on a map ("Export image": PNG or SVG) and, where a workspace is
// connected, the whole workspace as a JSON bundle. Everything is made in the browser from what the page already holds,
// except the bundle, which is fetched from the server (as the signed-in user, so only what they can read) and saved under
// the server's file name; when the server says no, its message shows in the menu (bundle-download.ts).
import { Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { buildMapImage, downloadBlob, exportFileName, readPalette, svgToPng, type MapImageInput } from "@/lib/export/map-image";
import { downloadBundle, localDate } from "./bundle-download";

export type MapExportInput = Omit<MapImageInput, "palette" | "date">;

/**
 * Export menu for a map. `input` is read when an item is chosen (so it draws the map as it is then); `bundleHref`, when
 * given, adds the workspace JSON bundle (fetched from that route; its error message, if any, shows in the menu).
 */
export function ExportMenu({
  input,
  name,
  bundleHref,
  label = "Export",
  note,
  size = "sm",
}: {
  input: () => MapExportInput;
  name: string;
  bundleHref?: string;
  label?: string;
  note?: string;
  /** The button's size, to match the buttons beside it (a detail page's header uses the default size). */
  size?: "sm" | "default";
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleNote, setBundleNote] = useState<{ tone: "error" | "warning"; text: string } | null>(null);

  const backup = async (href: string) => {
    setBundleNote(null);
    setBundleBusy(true);
    try {
      const r = await downloadBundle(href, downloadBlob);
      if (!r.ok) setBundleNote({ tone: "error", text: r.message });
      else if (r.warning) setBundleNote({ tone: "warning", text: r.warning });
      else setOpen(false);
    } finally {
      setBundleBusy(false);
    }
  };

  const run = async (kind: "png" | "svg") => {
    setError(null);
    setBusy(true);
    try {
      const date = localDate();
      const image = buildMapImage({ ...input(), palette: readPalette(), date });
      if (kind === "svg") downloadBlob(new Blob([image.svg], { type: "image/svg+xml;charset=utf-8" }), exportFileName(name, "svg", date));
      else downloadBlob(await svgToPng(image, 2), exportFileName(name, "png", date));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The export failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setBundleNote(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size={size} data-export-menu disabled={busy}>
            <Download aria-hidden />
            {busy ? "Exporting…" : label}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuLabel>Map image, with a legend</DropdownMenuLabel>
          <DropdownMenuItem data-export="png" onSelect={() => void run("png")}>
            PNG (2x)
          </DropdownMenuItem>
          <DropdownMenuItem data-export="svg" onSelect={() => void run("svg")}>
            SVG
          </DropdownMenuItem>
          {note && <p className="px-1.5 pb-1 text-xs text-muted-foreground">{note}</p>}
          {bundleHref && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Whole workspace</DropdownMenuLabel>
              <DropdownMenuItem
                data-export="bundle"
                disabled={bundleBusy}
                onSelect={(e) => {
                  // Stay open: the menu is where a refusal or a size warning is shown.
                  e.preventDefault();
                  void backup(bundleHref);
                }}
              >
                {bundleBusy ? "Preparing the backup…" : "JSON backup"}
              </DropdownMenuItem>
              {bundleNote && (
                <p role={bundleNote.tone === "error" ? "alert" : "status"} data-export-bundle-note={bundleNote.tone} className={bundleNote.tone === "error" ? "px-1.5 pb-1 text-xs text-destructive" : "px-1.5 pb-1 text-xs text-fg-2"}>
                  {bundleNote.tone === "warning" ? `Downloaded. ${bundleNote.text}` : bundleNote.text}
                </p>
              )}
              <p className="px-1.5 pb-1 text-xs text-muted-foreground">Every process and version, issues, sources and the company model. Named clients stay hidden but are kept. No emails or tokens.</p>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
