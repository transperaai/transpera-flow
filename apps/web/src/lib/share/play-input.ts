// What a play-link visitor sends, checked (issue #33, B4). Pure: the Send dialog runs it before it asks the server, the Server Action
// runs it again, and `public.submit_play_proposal` repeats every check (the browser could call it directly with the anon key).
// Wording is plain and is the database's own: the same sentence whichever side refuses.
//
// `playPatchProblem` is the TypeScript twin of `private.play_patch_problem`, WITHOUT the workspace check (only the database can read
// the workspace's tables). Given the snapshot's hidden kinds and ids it also checks those, as the dialog can; the Server Action has
// no snapshot, so it passes none and the database does that part. A table of cases shared with the database test keeps them equal.
//
// What a visitor TYPES is not checked for names, emails or money here: the visitor can't read the workspace's names (and must not
// learn them). The database holds what fails for members and viewers and never says so (docs/adr/0016-share-links.md, B4).

import { parsePatches, type ScenarioPatch } from "@transpera-flow/engine";

export const MAX_TITLE = 120;
export const MAX_NAME = 100;
export const MAX_NOTE = 1000;
export const MAX_EMAIL = 254;
export const MAX_CHANGES = 50;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Control characters: none in a title or a name; a note may have line breaks and tabs.
const CONTROL_STRICT = /[\u0001-\u001f\u007f]/;
const CONTROL_NOTE = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** As the dialog sends it. */
export interface PlayIdeaInput {
  title: string;
  /** "Why it would help"; may be empty. */
  note: string;
  name: string;
  /** Typed on an open link; on a restricted link the verified address is used and this is ignored. */
  email: string;
  /** An open issue of the process from the snapshot, or null. */
  issue: string | null;
  /** The levers moved: `{path, op, value}` patches. */
  levers: unknown;
  /** The honeypot: a person leaves it empty. */
  website?: string;
}

export interface ParsedPlayIdea {
  title: string;
  note: string | null;
  name: string;
  /** Lower-case; null when none was typed (a restricted link doesn't need it). */
  email: string | null;
  issue: string | null;
  levers: ScenarioPatch[];
}

export type PlayParse = { ok: true; value: ParsedPlayIdea } | { ok: false; message: string };

export const MESSAGES = {
  invalid: "Those changes aren't valid.",
  none: "Move at least one lever first.",
  many: `Send at most ${MAX_CHANGES} changes.`,
  duplicate: "Each lever can only be sent once.",
  refused: "One of those changes can't be sent from a shared link.",
  range: "One of the values is out of range.",
  missing: "One of those changes points at something that isn't in this page.",
} as const;

/** What the snapshot says, when the caller has it (the dialog does; the Server Action doesn't). */
export interface PlaySnapshotIds {
  hidden?: readonly string[];
  /** The link shows people (their hours may be sent). */
  showPeople?: boolean;
  /** Ids the snapshot holds: steps (the process's and other processes'), roles, people and services. Omit to skip the id checks. */
  ids?: { steps: ReadonlySet<string>; roles: ReadonlySet<string>; people: ReadonlySet<string>; services: ReadonlySet<string> };
}

interface Family {
  kind: string;
  /** The largest value `set` accepts; undefined: `set` isn't allowed. */
  setMax?: number;
  whole?: boolean;
  multiply?: boolean;
}

const FIXED: Record<string, Family> = {
  "demand.leads_per_week": { kind: "demand.enquiries", setMax: 10000 },
  "demand.active_clients": { kind: "clients.count", setMax: 100000, whole: true },
  "demand.churn_monthly": { kind: "clients.churn", setMax: 1 },
  "finances.retainer": { kind: "finances.prices", setMax: 10000000 },
};
const WITH_ID: Record<string, Family> = {
  "services.price": { kind: "finances.prices", setMax: 10000000 },
  "roles.headcount": { kind: "people.headcount", setMax: 500, whole: true },
  "people.fte": { kind: "people.hours", setMax: 1.5 },
  "steps.work_hours": { kind: "process.time", multiply: true },
  "steps.wait_hours": { kind: "process.wait", multiply: true, setMax: 10000 },
  "steps.rework_rate": { kind: "process.rework", multiply: true, setMax: 0.5 },
};
const ID_PATH = /^(services|roles|people|steps)\.([^.]+)\.(price|headcount|fte|work_hours|wait_hours|rework_rate)$/;

/** Why these lever changes can't be sent from a shared link, in plain words, or null. Mirrors `private.play_patch_problem`. */
export function playPatchProblem(levers: unknown, snapshot: PlaySnapshotIds = {}): string | null {
  if (!Array.isArray(levers)) return MESSAGES.invalid;
  if (levers.length === 0) return MESSAGES.none;
  if (levers.length > MAX_CHANGES) return MESSAGES.many;
  const parsed = parsePatches(levers);
  if (!parsed.ok) return MESSAGES.invalid;
  const patches = parsed.patches;
  if (new Set(patches.map((p) => p.path)).size !== patches.length) return MESSAGES.duplicate;
  const hidden = snapshot.hidden ?? [];

  for (const p of patches) {
    let family = FIXED[p.path];
    let fam: string | null = null;
    let id: string | null = null;
    if (!family) {
      const m = ID_PATH.exec(p.path);
      if (!m || m[2]!.startsWith("@")) return MESSAGES.refused;
      fam = `${m[1]}.${m[3]}`;
      id = m[2]!;
      family = WITH_ID[fam];
      if (!family) return MESSAGES.refused;
    }
    if (hidden.includes(family.kind)) return MESSAGES.refused;
    if (fam === "people.fte" && snapshot.showPeople === false) return MESSAGES.refused;

    if (p.op === "multiply") {
      if (!family.multiply || p.value < 0.1 || p.value > 2) return MESSAGES.range;
    } else if (p.op === "set") {
      if (family.setMax === undefined || p.value < 0 || p.value > family.setMax || (family.whole && !Number.isInteger(p.value))) return MESSAGES.range;
    } else {
      return MESSAGES.range;
    }

    if (id !== null && snapshot.ids) {
      const ids = snapshot.ids;
      const inSnapshot = fam === "services.price" ? ids.services.has(id) : fam === "roles.headcount" ? ids.roles.has(id) : fam === "people.fte" ? ids.people.has(id) : ids.steps.has(id);
      if (!inSnapshot || !UUID.test(id)) return MESSAGES.missing;
    }
  }
  return null;
}

/** The text and the changes of a visitor's idea, checked as the database checks them, or the plain reason they aren't ready. */
export function parsePlayIdea(input: unknown, options: { needEmail?: boolean; snapshot?: PlaySnapshotIds } = {}): PlayParse {
  const fail = (message: string): PlayParse => ({ ok: false, message });
  if (!input || typeof input !== "object") return fail("Something went wrong. Try again.");
  const i = input as Partial<Record<keyof PlayIdeaInput, unknown>>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const title = text(i.title);
  const name = text(i.name);
  const noteRaw = text(i.note);
  const email = text(i.email).toLowerCase();

  if (!title) return fail("Give your idea a name.");
  if (title.length > MAX_TITLE) return fail(`Keep the name under ${MAX_TITLE} characters.`);
  if (!name) return fail("Add your name.");
  if (name.length > MAX_NAME) return fail(`Keep your name under ${MAX_NAME} characters.`);
  if (noteRaw.length > MAX_NOTE) return fail("Keep the note under 1,000 characters.");
  if (CONTROL_STRICT.test(title) || CONTROL_STRICT.test(name) || CONTROL_NOTE.test(noteRaw)) return fail("Remove the unusual characters and try again.");
  // The email last here (the database checks it first): the dialog's fields run top to bottom, so the first problem shown is the first field's.
  if (options.needEmail !== false) {
    if (!email) return fail("Add your email address so the team can reply.");
    if (email.length > MAX_EMAIL || !EMAIL.test(email)) return fail("That isn't an email address.");
  } else if (email && (email.length > MAX_EMAIL || !EMAIL.test(email))) {
    return fail("That isn't an email address.");
  }

  const problem = playPatchProblem(i.levers, options.snapshot);
  if (problem) return fail(problem);
  const patches = (parsePatches(i.levers) as { ok: true; patches: ScenarioPatch[] }).patches;

  let issue: string | null = null;
  if (i.issue != null && i.issue !== "") {
    if (typeof i.issue !== "string" || !UUID.test(i.issue)) return fail("Pick an issue from this page, or none.");
    issue = i.issue;
  }
  return { ok: true, value: { title, note: noteRaw || null, name, email: email || null, issue, levers: patches } };
}

/** What the Server Action answers, and what the dialog says for each. `error` carries the database's own plain message. */
export type PlayResult = { status: "ok" } | { status: "rate_limited" } | { status: "busy" } | { status: "gone" } | { status: "sign_in" } | { status: "not_allowed" } | { status: "error"; message: string };

/** The dialog's words for each answer. */
export function playResultMessage(r: Exclude<PlayResult, { status: "ok" }>): string {
  switch (r.status) {
    case "rate_limited":
      return "A lot of ideas have been sent from this link recently. Try again in an hour.";
    case "busy":
      return "The team has a lot of ideas waiting. Try again later.";
    case "gone":
      return "This link has expired or been turned off.";
    case "sign_in":
    case "not_allowed":
      return "Sign in again with the address this link was sent to.";
    case "error":
      return r.message;
  }
}
