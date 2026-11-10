import { describe, expect, it } from "vitest";
import { downloadBundle, fileNameFromDisposition, localDate } from "@/components/export/bundle-download";

// The JSON backup is fetched, not followed as a link (issue #39, B10): a refusal from the route (`{ message }` as JSON)
// must show as a sentence and never be saved as the backup file.

const fakeFetch = (response: Response | Error) => (async () => {
  if (response instanceof Error) throw response;
  return response;
}) as unknown as typeof fetch;

const collect = () => {
  const saved: { blob: Blob; name: string }[] = [];
  return { saved, save: (blob: Blob, name: string) => saved.push({ blob, name }) };
};

describe("downloadBundle", () => {
  it.each([
    [401, "Your session has ended. Sign in again."],
    [403, "Only Agency admins and the Owner can export the workspace."],
    [500, "The export failed. Try again."],
  ])("on %i shows the route's message and saves nothing", async (status, message) => {
    const { saved, save } = collect();
    const r = await downloadBundle("/w/acme/export/bundle", save, { fetch: fakeFetch(Response.json({ message }, { status })) });
    expect(r).toEqual({ ok: false, message });
    expect(saved).toEqual([]);
  });

  it("falls back to a plain sentence when the error body isn't the route's JSON, or the network fails", async () => {
    const { saved, save } = collect();
    const html = await downloadBundle("/x", save, { fetch: fakeFetch(new Response("<html>Bad gateway</html>", { status: 502 })) });
    expect(html).toEqual({ ok: false, message: "The backup couldn't be downloaded. Try again." });
    const offline = await downloadBundle("/x", save, { fetch: fakeFetch(new TypeError("Failed to fetch")) });
    expect(offline.ok).toBe(false);
    expect(saved).toEqual([]);
  });

  it("saves a good answer under the server's file name and passes on the size warning", async () => {
    const { saved, save } = collect();
    const response = new Response('{"format":"transpera-workspace/1"}', {
      headers: { "Content-Disposition": 'attachment; filename="acme-workspace-2026-11-10.json"', "X-Backup-Warning": "Too big to restore." },
    });
    const r = await downloadBundle("/w/acme/export/bundle", save, { fetch: fakeFetch(response) });
    expect(r).toEqual({ ok: true, fileName: "acme-workspace-2026-11-10.json", warning: "Too big to restore." });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe("acme-workspace-2026-11-10.json");
    expect(await saved[0]!.blob.text()).toBe('{"format":"transpera-workspace/1"}');
  });

  it("names the file itself with the local date when the server gives no name", async () => {
    const { save } = collect();
    const now = new Date(2026, 0, 2, 23, 30); // local time, late in the day
    const r = await downloadBundle("/x", save, { fetch: fakeFetch(new Response("{}")), now: () => now });
    expect(r).toEqual({ ok: true, fileName: "workspace-backup-2026-01-02.json", warning: null });
  });
});

describe("file names", () => {
  it("reads both forms of Content-Disposition", () => {
    expect(fileNameFromDisposition('attachment; filename="a b.json"')).toBe("a b.json");
    expect(fileNameFromDisposition("attachment; filename=plain.json")).toBe("plain.json");
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''caf%C3%A9.json; filename=\"cafe.json\"")).toBe("café.json");
    expect(fileNameFromDisposition("attachment")).toBeNull();
    expect(fileNameFromDisposition(null)).toBeNull();
  });

  it("dates by the local calendar day", () => {
    expect(localDate(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
    expect(localDate(new Date(2026, 0, 1, 0, 1))).toBe("2026-01-01");
  });
});
