import type { Breadcrumb, ErrorEvent, EventHint } from "@sentry/nextjs";
import { moneyRegex, shareMoneyRegex } from "@transpera-flow/db/money";
import { ALLOWED_WORDS } from "./words";

// The one place that decides what leaves the app for Sentry (issue #44, ADR 0017). Sentry stores what it receives, so an event is
// rebuilt from an allow-list of fields, and every message is cut down to a fixed vocabulary. Pure functions: no Sentry runtime here.

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_WHOLE = new RegExp(`^${UUID}$`);

// The path segments an address may keep (deny by default): the app's own static route segments, Next's build files, and the
// Supabase and Anthropic API words the app calls. Any other segment becomes "[part]": a file's name in a Storage path
// (`/storage/v1/object/sources/<ids>/Maya Collins interview.pdf`), a workspace's slug, a share token, anything new.
// test/monitoring-scrub.test.ts checks every static route segment under src/app is here, and that no name is.
export const ROUTE_WORDS: ReadonlySet<string> = new Set([
  // The app's routes (src/app).
  "access", "ai", "api", "auth", "blocks", "branding", "bundle", "calibration", "callback", "churn-drivers", "demo", "edit",
  "export", "first-principles", "forecast", "history", "issues", "levers", "library", "login", "market", "mcp", "monitoring-check",
  "narrate", "overview", "p", "people", "privacy", "processes", "restore", "s", "settings", "share", "signout", "solutions",
  "sources", "suggestions", "tokens", "w",
  // Next's build files.
  "_next", "chunks", "css", "media", "static",
  // Supabase (REST, Auth, Storage, Realtime) and Anthropic.
  "authenticated", "buckets", "functions", "info", "logout", "messages", "object", "otp", "public", "realtime", "recover", "rest",
  "rpc", "sign", "storage", "token", "user", "v1", "verify", "websocket",
]);

// A route pattern's placeholders (Next's `[slug]`, and the ones this file writes).
const ROUTE_PARAM = /^\[(?:\.\.\.)?(?:slug|token|processId|number|id|part)\]$/;
// Postgres table and function names in a Supabase REST path (`/rest/v1/rpc/import_workspace_bundle`).
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function keepSegment(segment: string, index: number, segments: readonly string[]): string {
  if (segment === "" || UUID_WHOLE.test(segment) || /^\d+$/.test(segment) || ROUTE_PARAM.test(segment)) return segment;
  // segments[0] is "" (the path starts with a slash); the one after /s or /w is the secret or the company's name.
  if (index === 2 && segments[1] === "s") return "[token]";
  if (index === 2 && segments[1] === "w") return "[slug]";
  const lower = segment.toLowerCase();
  if (segment === lower && (ROUTE_WORDS.has(segment) || ALLOWED_WORDS.has(segment))) return segment;
  if (segments[1] === "rest" && SNAKE_CASE.test(segment)) return segment;
  // Next's build files are named by content hashes: nothing personal, and the stack trace needs them.
  if (segments[1] === "_next" && segments[2] === "static" && /^[\w.-]+$/.test(segment)) return segment;
  return "[part]";
}

type Parsed = { origin: string; segments: string[] };

/** Parses an address; null when it isn't one. A query and a fragment are always dropped. */
function parseAddress(url: string): Parsed | null {
  const input = url.trim();
  // A query or fragment is dropped, so only what stays has to look like an address (browsers encode spaces; a raw one is not a URL).
  if (!input || input === "[url]" || /\s/.test(input.replace(/[?#][\s\S]*$/, ""))) return null;
  const hasOrigin = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  let parsed: URL;
  try {
    parsed = new URL(input, "http://x");
  } catch {
    return null;
  }
  // Credentials in the address ("https://user:pass@host") are dropped with `origin`.
  // Next's browser files live at "app:///_next/..."; a non-http scheme has no `origin`, so rebuild it.
  const origin = hasOrigin ? (parsed.origin !== "null" ? parsed.origin : `${parsed.protocol}//${parsed.host}`) : "";
  return { origin, segments: parsed.pathname.split("/") };
}

/**
 * A URL or path cut to what is safe: no query, no fragment, and only path segments that are route words, ids or numbers;
 * /s/<token> → /s/[token]; /w/<slug> → /w/[slug]; any other segment → [part].
 */
export function scrubUrl(url: string): string {
  const parsed = parseAddress(url);
  if (!parsed) return "[url]";
  return parsed.origin + parsed.segments.map(keepSegment).join("/");
}

/** A stack frame's file (a bundle's path on the server or in the browser): query, fragment, the share token and the slug cut. */
function scrubCodePath(url: string): string {
  const parsed = parseAddress(url);
  if (!parsed) return "[url]";
  const { segments } = parsed;
  if ((segments[1] === "s" || segments[1] === "w") && segments.length > 2 && segments[2] !== "") segments[2] = segments[1] === "s" ? "[token]" : "[slug]";
  return parsed.origin + segments.join("/");
}

const TRAILING = /[.,;:!?)'"”’]+$/;
/** Scrubs a URL found in running text, keeping the punctuation that ended the sentence. */
function scrubFound(found: string): string {
  const tail = TRAILING.exec(found)?.[0] ?? "";
  const core = tail ? found.slice(0, found.length - tail.length) : found;
  return scrubUrl(core) + tail;
}

const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g;
// In a file path an address has no slash and ends in a real top-level domain, so pnpm's store paths
// (`.pnpm/next@16.3.6_@babel+core@7.29.7_/node_modules/...`) stay readable.
const EMAIL_IN_CODE = /[^\s@"'<>/]+@[^\s@"'<>/]+\.[A-Za-z]{2,}(?![\w.])/g;
const KEY_DETAIL = /Key \(([^)]*)\)=\(([^)]*)\)/g;
// Quotes that open or close text, not apostrophes inside a word (can't, Orla's).
const QUOTED = [
  /(?<![\p{L}\p{N}])"[^"\n]*"/gu,
  /(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu,
  /“[^”\n]*”/gu,
  /(?<![\p{L}\p{N}])‘[^’\n]*’(?![\p{L}\p{N}])/gu,
  /`[^`\n]*`/gu,
];
const OPAQUE = /[A-Za-z0-9_-]{24,}/g;

function scrubOpaque(run: string): string {
  if (UUID_WHOLE.test(run)) return run;
  // snake_case code names (import_workspace_bundle) are identifiers, not secrets.
  if (/^[a-z]+(?:_[a-z]+)+$/.test(run)) return run;
  return "[token]";
}

function scrub(text: string, code: boolean): string {
  let out = text;
  out = out.replace(/https?:\/\/\S+/gi, scrubFound);
  out = out.replace(/(?<![\p{L}\p{N}_.\-/])\/(?:s|w)\/[^\s"'<>]*/gu, scrubFound);
  // Before the email rule, which would otherwise swallow the whole "Key (email)=(a@b.c)" and hide that it was a key detail.
  out = out.replace(KEY_DETAIL, "Key ([column])=([value])");
  out = out.replace(code ? EMAIL_IN_CODE : EMAIL, "[email]");
  out = out.replace(moneyRegex(), "[amount]");
  out = out.replace(shareMoneyRegex(), "[amount]");
  // Source code (a stack frame's file, function and line) keeps its quotes and long names; the steps above still apply to it.
  if (code) return out;
  for (const quoted of QUOTED) out = out.replace(quoted, "[text]");
  return out.replace(OPAQUE, scrubOpaque);
}

/** Free text with emails, money, quoted text, long tokens and URLs replaced (used on every string in an event). */
export function scrubText(text: string): string {
  return scrub(text, false);
}

const PLACEHOLDERS = new Set(["[email]", "[amount]", "[text]", "[token]", "[url]", "[slug]", "[part]", "[column]", "[value]", "[type]"]);
// Order matters: a uuid and a placeholder are matched whole before the word rule can split them.
const PIECE = new RegExp(`${UUID}|\\[[a-z]+\\]|[\\p{L}\\p{N}_](?:[\\p{L}\\p{N}_]|['’](?=\\p{L}))*`, "gu");
const SQLSTATE = /^(?=.*\d)[0-9A-Z]{5}$/;

function keepWord(piece: string): boolean {
  if (PLACEHOLDERS.has(piece) || UUID_WHOLE.test(piece)) return true;
  if (/^\p{N}+$/u.test(piece)) return true;
  if (SQLSTATE.test(piece) || /^PGRST\d{3}$/.test(piece)) return true;
  // Code identifiers: import_workspace_bundle, NEXT_REDIRECT, toFixed, ChunkLoadError.
  if (piece.includes("_") && /^[A-Za-z0-9_]+$/.test(piece)) return true;
  if (/^[a-z][A-Za-z0-9]*$/.test(piece) && /[A-Z]/.test(piece)) return true;
  if (/^[A-Za-z][A-Za-z0-9]*(?:Error|Exception)$/.test(piece)) return true;
  const lower = piece.toLowerCase().replace(/’/g, "'");
  if (ALLOWED_WORDS.has(lower)) return true;
  // "workspace's": the word before 's is what counts.
  return lower.endsWith("'s") && ALLOWED_WORDS.has(lower.slice(0, -2));
}

/** An error message reduced to allow-listed words: scrubText, then every other word becomes "…" (runs collapse). */
export function shapeMessage(message: string): string {
  const cleaned = scrubText(message);
  const shaped = cleaned.replace(PIECE, (piece) => (keepWord(piece) ? piece : "…"));
  const collapsed = shaped.replace(/…(?:\s*…)+/g, "…");
  return collapsed.length > 500 ? `${collapsed.slice(0, 499)}…` : collapsed;
}

const CONTROL_FLOW = /NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK/;

function isDropped(event: Obj): boolean {
  const values = isObj(event.exception) && Array.isArray(event.exception.values) ? event.exception.values : [];
  return values.some((v) => {
    if (!isObj(v)) return false;
    const type = str(v.type) ?? "";
    const value = str(v.value) ?? "";
    return type === "AbortError" || type === "SimulationCancelled" || value.startsWith("SimulationCancelled") || CONTROL_FLOW.test(value) || CONTROL_FLOW.test(type);
  });
}

function scrubFrame(frame: unknown): Obj | null {
  if (!isObj(frame)) return null;
  const out: Obj = {};
  for (const key of ["filename", "abs_path"]) {
    const v = str(frame[key]);
    if (v !== undefined) out[key] = scrubFile(v);
  }
  for (const key of ["function", "module"]) {
    const v = str(frame[key]);
    if (v !== undefined) out[key] = scrub(v, true);
  }
  for (const key of ["lineno", "colno", "in_app"]) if (frame[key] !== undefined) out[key] = frame[key];
  const context = str(frame.context_line);
  if (context !== undefined) out.context_line = scrubText(context);
  for (const key of ["pre_context", "post_context"]) {
    const lines = frame[key];
    if (Array.isArray(lines)) out[key] = lines.map((l) => (typeof l === "string" ? scrubText(l) : ""));
  }
  return out;
}

/**
 * A frame's file. A web page's own address (an inline script) is cut like any address; a bundle's path (`app:///_next/...`, a
 * server path, `/_next/static/...`) keeps its path so source maps match; anything else ("<anonymous>") gets the code-safe rules.
 */
function scrubFile(file: string): string {
  if (!/^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i.test(file)) return scrub(file, true);
  const page = /^https?:\/\//i.test(file) && !/^https?:\/\/[^/]*\/_next\//i.test(file);
  const url = page ? scrubUrl(file) : scrubCodePath(file);
  return url === "[url]" ? scrub(file, true) : url;
}

function scrubException(value: unknown): Obj | null {
  if (!isObj(value)) return null;
  const out: Obj = {};
  const type = str(value.type);
  // A class name (TypeError, PostgrestError). Anything that isn't an identifier was set by hand, so it may be text.
  if (type !== undefined) out.type = /^[A-Za-z_$][\w$.]*$/.test(type) ? type : "[type]";
  const message = str(value.value);
  if (message !== undefined) out.value = shapeMessage(message);
  if (isObj(value.mechanism)) {
    const { data: _data, ...rest } = value.mechanism;
    void _data;
    out.mechanism = rest;
  }
  if (isObj(value.stacktrace) && Array.isArray(value.stacktrace.frames)) {
    out.stacktrace = { frames: value.stacktrace.frames.map(scrubFrame).filter((f): f is Obj => f !== null) };
  }
  if (value.module !== undefined && typeof value.module === "string") out.module = scrub(value.module, true);
  if (typeof value.thread_id === "number") out.thread_id = value.thread_id;
  return out;
}

function scrubTransaction(name: string): string {
  const match = /^([A-Z]+) (\S.*)$/.exec(name);
  return match ? `${match[1]} ${scrubUrl(match[2]!)}` : scrubUrl(name) === "[url]" ? "[route]" : scrubUrl(name);
}

function copyKeys(source: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function scrubContexts(contexts: unknown): Obj | undefined {
  if (!isObj(contexts)) return undefined;
  const out: Obj = {};
  for (const key of ["runtime", "os", "browser"]) if (isObj(contexts[key])) out[key] = { ...contexts[key] };
  if (isObj(contexts.device)) {
    const { name: _name, ...rest } = contexts.device;
    void _name;
    out.device = rest;
  }
  if (isObj(contexts.app)) {
    const { app_name: _appName, ...rest } = contexts.app;
    void _appName;
    out.app = rest;
  }
  if (isObj(contexts.nextjs)) {
    const next = contexts.nextjs;
    const kept = copyKeys(next, ["route_type", "router_kind", "router_path"]);
    const requestPath = str(next.request_path);
    if (requestPath !== undefined) kept.request_path = scrubUrl(requestPath);
    out.nextjs = kept;
  }
  if (isObj(contexts.trace)) out.trace = copyKeys(contexts.trace, ["trace_id", "span_id", "parent_span_id", "op", "origin", "status"]);
  return out;
}

const TAG_KEYS = new Set(["runtime", "handled", "mechanism", "level", "transaction", "url", "environment", "release", "routerKind", "routePath", "routeType", "renderSource", "area"]);

function scrubTags(tags: unknown): Obj | undefined {
  if (!isObj(tags)) return undefined;
  const out: Obj = {};
  for (const [key, value] of Object.entries(tags)) {
    if (!TAG_KEYS.has(key) || typeof value !== "string") continue;
    // Addresses and route patterns are cut like any address; every other value is words, so it is held to the vocabulary too.
    out[key] = key === "url" ? scrubUrl(value) : key === "transaction" || key === "routePath" ? scrubTransaction(value) : key === "release" || key === "environment" ? value : shapeMessage(value);
  }
  return out;
}

function scrubDebugMeta(meta: unknown): Obj | undefined {
  if (!isObj(meta)) return undefined;
  const out: Obj = {};
  if (Array.isArray(meta.images)) {
    out.images = meta.images.filter(isObj).map((image) => {
      const copy: Obj = { ...image };
      const codeFile = str(image.code_file);
      if (codeFile !== undefined) copy.code_file = scrubFile(codeFile);
      return copy;
    });
  }
  return out;
}

// Keys whose strings are identifiers or code, not text: the last pass leaves their long names and quotes alone.
const ID_KEYS = new Set(["event_id", "trace_id", "span_id", "parent_span_id", "debug_id", "release", "dist", "timestamp", "sdk", "environment", "platform", "level", "type", "fingerprint"]);
const CODE_KEYS = new Set(["filename", "abs_path", "function", "module", "code_file", "code_id", "debug_file"]);

/** The backstop: every string left in the event goes through scrubText (code and ids keep their names). */
function finalPass(value: unknown, key = ""): unknown {
  if (ID_KEYS.has(key)) return value;
  if (typeof value === "string") return scrub(value, CODE_KEYS.has(key));
  if (Array.isArray(value)) return value.map((v) => finalPass(v, key));
  if (isObj(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) out[k] = finalPass(v, k);
    return out;
  }
  return value;
}

/** beforeSend: the event with only what ADR 0017 allows, or null to drop it. */
export function scrubEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  void _hint;
  const source = event as unknown as Obj;
  if (isDropped(source)) return null;

  const out: Obj = copyKeys(source, ["event_id", "timestamp", "level", "platform", "environment", "release", "dist", "sdk", "server_name", "fingerprint", "type"]);

  const transaction = str(source.transaction);
  if (transaction !== undefined) out.transaction = scrubTransaction(transaction);

  if (isObj(source.exception) && Array.isArray(source.exception.values)) {
    out.exception = { values: source.exception.values.map(scrubException).filter((v): v is Obj => v !== null) };
  }

  const message = str(source.message);
  if (message !== undefined) out.message = shapeMessage(message);
  if (isObj(source.logentry)) {
    const logMessage = str(source.logentry.message);
    out.logentry = logMessage !== undefined ? { message: shapeMessage(logMessage) } : {};
  }

  if (isObj(source.request)) {
    const request: Obj = {};
    const method = str(source.request.method);
    const url = str(source.request.url);
    if (method !== undefined) request.method = method;
    if (url !== undefined) request.url = scrubUrl(url);
    out.request = request;
  }

  const contexts = scrubContexts(source.contexts);
  if (contexts) out.contexts = contexts;
  const tags = scrubTags(source.tags);
  if (tags) out.tags = tags;

  if (Array.isArray(source.breadcrumbs)) {
    out.breadcrumbs = source.breadcrumbs.map((b) => (isObj(b) ? scrubBreadcrumb(b as Breadcrumb) : null)).filter((b): b is Breadcrumb => b !== null);
  }

  const debugMeta = scrubDebugMeta(source.debug_meta);
  if (debugMeta) out.debug_meta = debugMeta;

  // Dropped on purpose: user, extra, modules, spans, measurements, attachments, and everything not listed above.
  return finalPass(out) as unknown as ErrorEvent;
}

const HTTP_CATEGORIES = new Set(["fetch", "xhr", "http"]);

/** beforeBreadcrumb: navigation and http/fetch/xhr breadcrumbs with scrubbed URLs; everything else is dropped. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  const category = breadcrumb.category;
  if (category !== "navigation" && !(category !== undefined && HTTP_CATEGORIES.has(category))) return null;
  const data = isObj(breadcrumb.data) ? breadcrumb.data : {};
  const out: Breadcrumb = { category };
  if (breadcrumb.timestamp !== undefined) out.timestamp = breadcrumb.timestamp;
  if (breadcrumb.type !== undefined) out.type = breadcrumb.type;
  if (breadcrumb.level !== undefined) out.level = breadcrumb.level;
  if (category === "navigation") {
    const kept: Obj = {};
    for (const key of ["from", "to"]) {
      const v = str(data[key]);
      if (v !== undefined) kept[key] = scrubUrl(v);
    }
    out.data = kept;
  } else {
    const kept: Obj = {};
    const method = str(data.method);
    const url = str(data.url);
    if (method !== undefined) kept.method = method;
    if (url !== undefined) kept.url = scrubUrl(url);
    if (typeof data.status_code === "number") kept.status_code = data.status_code;
    out.data = kept;
  }
  return out;
}
