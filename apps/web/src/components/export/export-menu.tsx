"use client";

// The Export button (issue #39, B10): a small menu on a map ("Export image": PNG or SVG) and, where a workspace is
// connected, the whole workspace as a JSON bundle. Everything is made in the browser from what the page already holds,
// except the bundle, which is a download from the server (as the signed-in user, so only what they can read).
import { Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { buildMapImage, downloadBlob, exportFileName, readPalette, svgToPng, type MapImageInput } from "@/lib/export/map-image";

export type MapExportInput = Omit<MapImageInput, "palette" | "date">;

/**
 * Export menu for a map. `input` is read when an item is chosen (so it draws the map as it is then); `bundleHref`, when
 * given, adds the workspace JSON bundle (a link to the route, which sends it as a file).
 */
export function ExportMenu({ input, name, bundleHref, label = "Export", note }: { input: () => MapExportInput; name: string; bundleHref?: string; label?: string; note?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (kind: "png" | "svg") => {
    setError(null);
    setBusy(true);
    try {
      const date = new Date().toISOString().slice(0, 10);
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" data-export-menu disabled={busy}>
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
              <DropdownMenuItem asChild data-export="bundle">
                {/* A plain link: the server sends the file, and signs nobody in who is not already. */}
                <a href={bundleHref} download>
                  JSON backup
                </a>
              </DropdownMenuItem>
              <p className="px-1.5 pb-1 text-xs text-muted-foreground">Every process and version, issues, sources and the company model. Named clients stay hidden but are kept. No emails or tokens.</p>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
