// What the process library asks the server to make (issue #164, B12): an empty new process, or one from a template. Shared by the
// Server Action (app/w/[slug]/library-actions.ts) and the library panel.

import type { ProcessCategory, ProcessRow } from "@transpera-flow/db";

export type LibraryCreateInput =
  /** A new process is made by category (D52); the engine kind follows from it (`kindForCategory`). */
  | { kind: "new"; name: string; category: ProcessCategory }
  | { kind: "template"; templateId: string; name?: string };

export type LibraryCreateResult =
  | { process: { id: string; name: string; kind: ProcessRow["kind"]; category: ProcessCategory; live: boolean }; error?: undefined }
  | { error: string; process?: undefined };

/** Makes a process for the library; the Editor passes the Server Action, a harness a stand-in. */
export type LibraryCreate = (input: LibraryCreateInput) => Promise<LibraryCreateResult>;
