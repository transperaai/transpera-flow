// Fetching the workspace JSON backup (issue #39, B10) instead of following a plain download link. A link saves whatever
// comes back, so a 401, 403 or 500 (the route answers `{ message }` as JSON) arrived as a "backup" file. Fetched, a good
// answer is saved under the server's file name and a bad one becomes a sentence the menu shows. Pure apart from `fetch`
// and `save`, both passed in, so the error path is unit-tested (test/export-bundle-download.test.ts).

/** `YYYY-MM-DD` in the viewer's own time zone: the date a file the browser names carries (toISOString would give UTC's). */
export function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The file name in a Content-Disposition header (`filename*=UTF-8''…` or `filename="…"`), or null. */
export function fileNameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      // Fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/.exec(header);
  const name = (plain?.[1] ?? plain?.[2])?.trim();
  return name ? name : null;
}

export type BundleDownload =
  | { ok: true; fileName: string; /** The route's `X-Backup-Warning`: the file is too big for a restore to take. */ warning: string | null }
  | { ok: false; message: string };

const FALLBACK_MESSAGE = "The backup couldn't be downloaded. Try again.";

/**
 * Fetches the backup at `href` and hands a good answer to `save` under the server's file name (or, if the header is
 * missing, `workspace-backup-<local date>.json`). A bad answer, or none, saves nothing and returns the route's message.
 */
export async function downloadBundle(
  href: string,
  save: (blob: Blob, fileName: string) => void,
  deps: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<BundleDownload> {
  const doFetch = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(href, { credentials: "same-origin", cache: "no-store" });
  } catch {
    return { ok: false, message: "The backup couldn't be downloaded. Check your connection and try again." };
  }
  if (!response.ok) {
    let message: string | null = null;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "message" in body && typeof body.message === "string" && body.message.trim()) message = body.message;
    } catch {
      // Not JSON (a proxy's error page, say): the generic sentence.
    }
    return { ok: false, message: message ?? FALLBACK_MESSAGE };
  }
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    return { ok: false, message: FALLBACK_MESSAGE };
  }
  const fileName = fileNameFromDisposition(response.headers.get("Content-Disposition")) ?? `workspace-backup-${localDate(deps.now?.() ?? new Date())}.json`;
  save(blob, fileName);
  return { ok: true, fileName, warning: response.headers.get("X-Backup-Warning") };
}
