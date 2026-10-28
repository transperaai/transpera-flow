import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Every control in the first-principles flow has an (i) with plain English and an example (issue #119, A54). The
// settings check (settings-help.test.ts) catches a raw control with no (i) nearby; this one reads the flow's
// components as TypeScript and holds each (i) to a description and an example in plain words.

const DIR = join(__dirname, "..", "src", "components", "first-principles");
const FILES = [...readdirSync(DIR).filter((f) => f.endsWith(".tsx"))];

/** The components that draw a control and carry its (i) in a `help` prop. */
const WITH_HELP = new Set(["TextAnswer", "PickAnswer", "NumberAnswer", "Choice", "AddButton", "Field"]);
/** Words a consultant wouldn't use. The (i) is for the person filling the form in. */
const JARGON = /\b(kpi|sla|wip|cv|lognormal|triangular|replications?|p90|p50|percentile|utilisation|heuristic|engine|detector|jsonb|revision id|api)\b/i;

interface Found {
  where: string;
  tag: string;
  label: string | null;
  description: string | null;
  example: string | null;
}

const text = (n: ts.Node | undefined): string | null => {
  if (!n) return null;
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isJsxExpression(n) && n.expression) return text(n.expression);
  if (ts.isTemplateExpression(n)) return n.getText();
  if (ts.isConditionalExpression(n) || ts.isBinaryExpression(n) || ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isCallExpression(n)) return n.getText();
  return null;
};

function read(file: string): Found[] {
  const source = ts.createSourceFile(file, readFileSync(join(DIR, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Found[] = [];
  const where = (n: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const attr = (o: ts.JsxOpeningLikeElement, name: string) => o.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
  const visit = (n: ts.Node) => {
    const o = ts.isJsxSelfClosingElement(n) ? n : ts.isJsxElement(n) ? n.openingElement : null;
    if (o) {
      const tag = o.tagName.getText();
      if (tag === "Help" || tag === "HelpLabel") {
        // `{...help}` passes on text that its caller was given (and is checked there).
        const spread = o.attributes.properties.some((p) => ts.isJsxSpreadAttribute(p));
        out.push({
          where: where(n),
          tag,
          label: text(attr(o, "label")?.initializer),
          description: spread ? "(forwarded from its caller, checked there)" : text(attr(o, "description")?.initializer),
          example: spread ? "(forwarded from its caller, checked there)" : text(attr(o, "example")?.initializer),
        });
      } else if (WITH_HELP.has(tag)) {
        const help = attr(o, "help")?.initializer;
        const object = help && ts.isJsxExpression(help) && help.expression && ts.isObjectLiteralExpression(help.expression) ? help.expression : null;
        const prop = (name: string) => object?.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === name)?.initializer;
        const forwarded = help && ts.isJsxExpression(help) && help.expression && ts.isIdentifier(help.expression);
        out.push({
          where: where(n),
          tag,
          label: text(attr(o, "label")?.initializer),
          // A `help={help}` passed on from a component that was itself given help is checked at its caller.
          description: forwarded ? "(forwarded from its caller, checked there)" : text(prop("description")),
          example: forwarded ? "(forwarded from its caller, checked there)" : text(prop("example")),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return out;
}

const all = FILES.flatMap(read);

describe("the first-principles flow's (i)s", () => {
  it("reads the flow's components", () => {
    expect(FILES).toEqual(expect.arrayContaining(["fields.tsx", "step-bodies.tsx", "first-principles-flow.tsx", "first-principles-card.tsx"]));
    // Every question of the seven steps has controls; there are dozens.
    expect(all.length).toBeGreaterThan(40);
  });

  it("gives every control and every (i) a description and an example", () => {
    const missing = all.filter((f) => !f.description || !f.example || f.description.length < 15 || f.example.length < 8).map((f) => `${f.where} <${f.tag}> ${f.label ?? ""}`);
    expect(missing).toEqual([]);
  });

  it("gives every control a label", () => {
    expect(all.filter((f) => !f.label).map((f) => `${f.where} <${f.tag}>`)).toEqual([]);
  });

  it("explains in plain words", () => {
    const jargon = all.filter((f) => JARGON.test(`${f.description} ${f.example}`)).map((f) => `${f.where} ${f.label}`);
    expect(jargon).toEqual([]);
  });

  it("covers each of the seven steps' fields", () => {
    const labels = new Set(all.map((f) => f.label));
    for (const label of [
      "Who it serves",
      "The progress they want",
      "What done looks like",
      "Truth or assumption",
      "Owner (a person, not a team)",
      "Verdict",
      "Step to delete",
      "Added back?",
      "Step it changes",
      "Root cause",
      "Simulation number",
      "Target",
      "Met today",
      "Checks",
    ]) {
      expect(labels.has(label), label).toBe(true);
    }
  });
});
