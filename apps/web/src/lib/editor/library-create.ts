// What the process library asks the server to make (issue #164, B12): an empty new process, or one from a template. Shared by the
// Server Action (app/w/[slug]/library-actions.ts) and the library panel.

import type { ProcessRow } from "@transpera-flow/db";

export type LibraryCreateInput =
  | { kind: "new"; name: string; processKind: ProcessRow["kind"] }
  | { kind: "template"; templateId: string; name?: string };

export type LibraryCreateResult =
  | { process: { id: string; name: string; kind: ProcessRow["kind"]; live: boolean }; error?: undefined }
  | { error: string; process?: undefined };

/** Makes a process for the library; the Editor passes the Server Action, a harness a stand-in. */
export type LibraryCreate = (input: LibraryCreateInput) => Promise<LibraryCreateResult>;
