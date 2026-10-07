// The words an error message may keep when it is reported to Sentry (issue #44, ADR 0017). Everything else becomes "…", so a name
// can't get through even when a database error spells it out unquoted. The list holds no names: a test (monitoring-scrub.test.ts)
// fails if a fixture name or a common first name that is also a word is added. A word you're unsure of stays out.
// Each group is sorted; a word in two groups is listed once in the set.

// English function words and common verbs.
const ENGLISH = [
  "a", "after", "again", "all", "allowed", "already", "also", "an", "and", "another", "any", "archive", "archived", "are",
  "as", "at", "be", "because", "been", "before", "but", "by", "call", "called", "can", "can't", "cannot", "change",
  "changed", "changing", "choose", "choosing", "close", "come", "comes", "could", "down", "each", "else", "empty", "every",
  "expected", "failed", "failure", "false", "find", "first", "for", "found", "from", "get", "had", "has", "have", "held",
  "here", "hold", "holds", "how", "if", "in", "into", "invalid", "is", "it", "its", "large", "last", "least", "less",
  "link", "linked", "long", "made", "make", "many", "missing", "more", "most", "move", "moving", "much", "must", "nan",
  "new", "no", "none", "not", "null", "of", "off", "old", "on", "one", "only", "onto", "open", "or", "other", "out",
  "over", "own", "place", "placing", "publish", "published", "publishing", "put", "read", "reading", "remove", "removed",
  "rename", "restore", "restored", "same", "set", "should", "sit", "sits", "small", "so", "some", "still", "take", "than",
  "that", "the", "then", "there", "these", "this", "those", "to", "too", "true", "two", "undefined", "under", "unexpected",
  "unknown", "unlink", "up", "use", "used", "was", "were", "what", "when", "where", "which", "while", "who", "whose",
  "why", "with", "without", "work", "would", "write", "writing", "yet",
];

// JavaScript, React, Next and network words.
const JAVASCRIPT = [
  "aborted", "aborterror", "action", "actions", "array", "assign", "at", "auth", "bucket", "bytes", "call", "cannot",
  "character", "check", "chunk", "chunkloaderror", "client", "column", "columns", "component", "components", "connection",
  "constant", "constraint", "constructor", "convert", "deadlock", "defined", "denied", "detected", "digest", "document",
  "duplicate", "element", "end", "error", "errors", "exceeded", "expired", "fetch", "file", "files", "forbidden",
  "foreign", "function", "hydrate", "hydration", "import", "index", "initialization", "initialized", "input", "instance",
  "iterable", "json", "jwt", "kb", "key", "keys", "length", "level", "limit", "limits", "load", "loaded", "loading",
  "lock", "login", "maximum", "mb", "memory", "mismatch", "module", "near", "network", "networkerror", "node", "notfound",
  "number", "object", "page", "parse", "permission", "policy", "promise", "properties", "property", "prototype",
  "rangeerror", "rate", "reading", "redirect", "referenceerror", "refused", "rejected", "relation", "render", "rendering",
  "request", "reset", "response", "route", "routes", "row", "rows", "security", "sentry", "server", "session", "sign",
  "signal", "signed", "size", "stack", "status", "storage", "string", "syntax", "syntaxerror", "table", "tables", "timed",
  "timeout", "token", "transaction", "type", "typeerror", "types", "unauthorized", "unexpected", "unique", "upload",
  "uploaded", "user", "users", "value", "values", "variable", "violates", "window", "worker",
];

// Values the Sentry SDK and Next put in tags (mechanism, router kind).
const SDK = [
  "app", "auto", "browser", "http", "nextjs", "onerror", "pages", "router", "yes",
];

// Product words, from the app's own UI and SQL messages.
const PRODUCT = [
  "admin", "agency", "analyse", "analysis", "api", "backup", "block", "blocks", "bundle", "calibration", "child", "churn",
  "client", "clients", "company", "copy", "decision", "demand", "draft", "drafts", "edge", "edges", "editor", "editors",
  "end", "engine", "export", "finding", "findings", "first", "forecast", "group", "groups", "held", "history", "horizon",
  "idea", "ideas", "import", "inside", "insight", "insights", "issue", "issues", "itself", "lever", "levers", "link",
  "links", "live", "map", "marker", "markers", "market", "mcp", "member", "members", "model", "models", "narration",
  "owner", "owners", "parent", "people", "person", "placeholder", "plan", "plans", "play", "principles", "process",
  "processes", "proposal", "proposals", "report", "result", "results", "revision", "revisions", "role", "roles", "run",
  "runs", "scenario", "scenarios", "service", "services", "servicing", "settings", "share", "simulate", "simulation",
  "snapshot", "solution", "solutions", "source", "sources", "start", "step", "steps", "suggestion", "suggestions", "team",
  "terminal", "token", "tokens", "version", "versions", "viewer", "viewers", "wait", "workspace", "workspaces",
];

/** Lower-case words that may appear in a reported message. */
export const ALLOWED_WORDS: ReadonlySet<string> = new Set([...ENGLISH, ...JAVASCRIPT, ...SDK, ...PRODUCT]);
