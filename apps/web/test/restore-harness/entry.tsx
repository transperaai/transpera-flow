// The restore page's client component on a bare page, for ../restore-browser.test.ts. Bundled by esbuild and driven through
// `window.mountRestore`; nothing here ships. The server is stood in for by a function that notes the request the component made
// (its gzip body included) and answers as told; the file checker is the real one.

import { createRoot } from "react-dom/client";
import { RestoreBackup } from "@/components/restore/restore-backup";

interface Answer {
  status: number;
  body: unknown;
}

export interface Posted {
  url: string;
  contentType: string | null;
  backupName: string | null;
  /** The first two bytes of the body: a gzip stream starts 1f 8b. */
  magic: number[];
  size: number;
  /** The body unpacked in the page, so a test can read what was sent. */
  text: string;
}

declare global {
  interface Window {
    mountRestore: (answer?: Answer) => void;
    posts: Posted[];
  }
}

window.posts = [];

window.mountRestore = (answer = { status: 200, body: { processes: [{ id: "p1", name: "Intake" }], counts: {}, leftOut: [], settings: "applied" } }) => {
  const root = document.getElementById("root")!;
  createRoot(root).render(
    <RestoreBackup
      slug="mini"
      post={async (url, init) => {
        const headers = new Headers(init.headers);
        const blob = init.body as Blob;
        const buf = new Uint8Array(await blob.arrayBuffer());
        const text = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
        window.posts.push({ url, contentType: headers.get("content-type"), backupName: headers.get("x-backup-name"), magic: [buf[0]!, buf[1]!], size: buf.length, text });
        return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
      }}
    />,
  );
};
