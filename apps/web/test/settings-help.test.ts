import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// "No setting, lever or rule without an (i)" (issue #123, A58), checked on the source. Every screen that holds
// settings is read as TypeScript, and each control a person can change must carry help: a field component given a
// `help` prop, or a raw control (an input, switch, select, checkbox) with a `help` prop or an (i) next to it in
// the same row. Levers and rules are checked as data in lever-catalogue.test.ts and analysis-rules.test.ts.

const SRC = join(__dirname, "..", "src");

/** The screens that hold settings, as paths under src/ (directories are read recursively). */
const SETTINGS_SOURCES = ["app/w/[slug]/settings", "components/levers", "app/new-workspace-form.tsx", "app/settings", "components/sources-page.tsx", "components/sources", "components/issues-register.tsx", "components/step-inspector.tsx", "components/editor", "components/evidence.tsx", "components/process-page.tsx", "components/wait-by-step.tsx", "components/utilisation-bars.tsx", "components/overview/health-cards.tsx", "components/lever-panel.tsx", "components/horizon-picker.tsx", "components/history", "components/first-principles", "components/ai", "components/calibration"];

/** Components that draw a label, a control and (when given `help`) its (i). */
const FIELD_COMPONENTS = new Set(["TextField", "DateField", "NumberField", "SelectField", "ToggleField", "ChecklistField", "Field", "Setting"]);
/** Raw controls: each needs an (i) of its own. */
const CONTROLS = new Set(["MoneyBox", "Input", "Textarea", "Switch", "Select", "Checkbox", "Slider", "NativeSelect", "input", "textarea", "select"]);
/** Components that draw an (i) inside themselves (a rule's name carries its own). */
const HELP_BEARERS = new Set(["RuleName"]);
/** Screens where each switch must carry its own (i) in its own cell (the rows of other screens share the (i) of their name). */
const STRICT_SWITCH_FILES = ["churn-drivers-settings.tsx"];
/** Controls that are not settings: hidden form fields, buttons, file pickers. */
const NOT_SETTINGS_TYPES = new Set(["hidden", "submit", "button", "file"]);

function files(path: string): string[] {
  const full = join(SRC, path);
  try {
    if (!statSync(full).isDirectory()) return [full];
  } catch {
    return [];
  }
  return readdirSync(full, { recursive: true, encoding: "utf8" })
    .map((f) => join(full, f))
    .filter((f) => f.endsWith(".tsx") && statSync(f).isFile());
}

const tagName = (n: ts.JsxOpeningLikeElement) => n.tagName.getText();
const attr = (n: ts.JsxOpeningLikeElement, name: string) =>
  n.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
const opening = (n: ts.Node): ts.JsxOpeningLikeElement | null =>
  ts.isJsxSelfClosingElement(n) ? n : ts.isJsxElement(n) ? n.openingElement : null;

const isHelp = (n: ts.Node): boolean => {
  const o = opening(n);
  return !!o && (tagName(o).startsWith("Help") || HELP_BEARERS.has(tagName(o)));
};

const isRawControl = (n: ts.Node): boolean => {
  const o = opening(n);
  if (!o || !CONTROLS.has(tagName(o)) || attr(o, "help")) return false;
  const type = attr(o, "type")?.initializer;
  return !(type && ts.isStringLiteral(type) && NOT_SETTINGS_TYPES.has(type.text));
};

/** Count the (i)s and the bare controls anywhere inside `root`. */
function tally(root: ts.Node): { helps: number; controls: number } {
  let helps = 0;
  let controls = 0;
  const walk = (n: ts.Node) => {
    if (isHelp(n)) helps++;
    if (isRawControl(n)) controls++;
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(root, walk);
  return { helps, controls };
}

/** The controls that have no (i) of their own, in TSX source text. `name` is only for messages. */
export function problemsIn(text: string, name: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const where = (n: ts.Node) => `${name}:${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node) => {
    const o = opening(n);
    if (o) {
      const tag = tagName(o);
      if (FIELD_COMPONENTS.has(tag) && !attr(o, "help")) out.push(`${where(n)}: <${tag}> has no help`);
      // A custom field component (anything capitalised given a label) carries its own help, or has a control rule below.
      if (/(Field|Box|Input|Select|Picker|Widget)$/.test(tag) && attr(o, "label") && !FIELD_COMPONENTS.has(tag) && !CONTROLS.has(tag) && !attr(o, "help")) {
        out.push(`${where(n)}: <${tag}> has a label but no help`);
      }
      if (isRawControl(n)) {
        // A control at the very root of a component is that component's own internals: its callers are checked.
        let ok = !hasJsxAncestor(n);
        // Its own (i): within two JSX levels (its label, then its row or form), a container that holds at least as many (i)s as bare controls, so one
        // (i) elsewhere in the same form can't stand in for a missing one.
        let p: ts.Node | undefined = n.parent;
        // A switch needs its (i) beside it (its own row cell), not merely somewhere in the row.
        const reach = tag === "Switch" && STRICT_SWITCH_FILES.some((f) => name.endsWith(f)) ? 1 : 2;
        for (let levels = 0; p && levels < reach && !ok; p = p.parent) {
          if (!ts.isJsxElement(p) && !ts.isJsxFragment(p)) continue;
          levels++;
          const po = ts.isJsxElement(p) ? p.openingElement : null;
          if (po && FIELD_COMPONENTS.has(tagName(po)) && attr(po, "help")) ok = true;
          else {
            const t = tally(p);
            if (t.helps >= 1 && t.helps >= t.controls) ok = true;
          }
        }
        if (!ok) out.push(`${where(n)}: <${tag}> has no (i)`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return out;
}

function hasJsxAncestor(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) if (ts.isJsxElement(p) || ts.isJsxFragment(p)) return true;
  return false;
}

const problems = (file: string) => problemsIn(readFileSync(file, "utf8"), relative(SRC, file));

describe("every setting has an (i)", () => {
  const all = SETTINGS_SOURCES.flatMap(files);

  it("reads the settings screens", () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it("finds no field or control on a settings screen without help", () => {
    expect(all.flatMap(problems)).toEqual([]);
  });
});

describe("the checker catches a missing (i)", () => {
  const people = readFileSync(join(SRC, "app/w/[slug]/settings/people-settings.tsx"), "utf8");

  it("passes the real source", () => {
    expect(problemsIn(people, "people-settings.tsx")).toEqual([]);
  });

  it("fails when the Last day (i) is deleted, even though its neighbours still have theirs", () => {
    const line = people.split("\n").find((l) => l.includes('<HelpLabel label="Last day"'))!;
    expect(line).toBeTruthy();
    const broken = people.replace(line, '            <span className="text-xs text-fg-2">Last day</span>');
    const found = problemsIn(broken, "people-settings.tsx");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/<Input> has no \(i\)/);
  });

  it("fails on a field component with no help, and on a labelled custom component with none", () => {
    const bad = `export const X = () => (<div><NumberField label="A" value={1} save={f} /><Widget label="B" /></div>);`;
    expect(problemsIn(bad, "x.tsx")).toEqual(["x.tsx:1: <NumberField> has no help", "x.tsx:1: <Widget> has a label but no help"]);
  });
});

describe("each churn driver switch has its own (i)", () => {
  const churn = readFileSync(join(SRC, "app/w/[slug]/settings/churn-drivers-settings.tsx"), "utf8");

  it("passes the real source", () => {
    expect(problemsIn(churn, "churn-drivers-settings.tsx")).toEqual([]);
  });

  it("fails when a switch's (i) is deleted, though the row's other (i)s remain", () => {
    const line = churn.split("\n").find((l) => l.includes("CONTROL_HELP.switch"))!;
    expect(line).toBeTruthy();
    const found = problemsIn(churn.replace(line, ""), "churn-drivers-settings.tsx");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/<Switch> has no \(i\)/);
  });
});
