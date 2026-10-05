import { describe, expect, it } from "vitest";
import { NO_BLOCK_MESSAGE, processTextFrom } from "../src/process-file";

// The process block finder against hostile pages (issue #166, B13 slice 2 review): linear time, and no way to hide the real
// block or put a fake one in front of it.

const T = "application/vnd.transpera-process+json";

describe("hostile pages", () => {
  it("scans 2 MB of adversarial markup in well under 200 ms", () => {
    const inputs = [
      "<script ".repeat(260_000),
      "<script>".repeat(260_000),
      "<script x='".repeat(190_000),
      "<!--".repeat(500_000),
      '<script type="'.repeat(150_000),
      "<script ><!--".repeat(150_000),
      `<script ${'a="'.repeat(1000)}`.repeat(600),
    ];
    for (const input of inputs) {
      expect(input.length).toBeLessThanOrEqual(2_100_000);
      const started = performance.now();
      const r = processTextFrom(input);
      expect(performance.now() - started, input.slice(0, 20)).toBeLessThan(200);
      expect(r.error).toBeDefined();
    }
  });

  it("ignores a block inside an HTML comment, and finds the real one after it", () => {
    const real = `<script type="${T}">{"real":true}</script>`;
    expect(processTextFrom(`<!-- <script type="${T}">{"fake":true}</script> -->${real}`).text).toBe('{"real":true}');
    expect(processTextFrom(`<!-- <script type="${T}">{"fake":true}</script> -->`).error).toBe(NO_BLOCK_MESSAGE);
    expect(processTextFrom(`<!-- never closed <script type="${T}">{"fake":true}</script>`).error).toBe(NO_BLOCK_MESSAGE);
  });

  it("needs the attribute to be called type, not data-type or x-type", () => {
    expect(processTextFrom(`<script data-type="${T}">{"fake":true}</script>`).error).toBe(NO_BLOCK_MESSAGE);
    expect(processTextFrom(`<script x-type='${T}'>{"fake":true}</script>`).error).toBe(NO_BLOCK_MESSAGE);
    expect(processTextFrom(`<script data-type="x" type="${T}">{"ok":1}</script>`).text).toBe('{"ok":1}');
  });

  it("isn't fooled by a > inside a quoted attribute value", () => {
    expect(processTextFrom(`<script data-note="a>b" type="${T}">{"ok":1}</script>`).text).toBe('{"ok":1}');
    expect(processTextFrom(`<script title='x > y' type=${T}>{"ok":2}</script>`).text).toBe('{"ok":2}');
    expect(processTextFrom(`<script data-x="<script type='${T}'>">{"fake":1}</script>`).error).toBe(NO_BLOCK_MESSAGE);
  });

  it("skips tags that only start like a script tag, and decoys before the real block", () => {
    expect(processTextFrom(`<scripts type="${T}">{"fake":1}</scripts><script type="${T}">{"ok":3}</script>`).text).toBe('{"ok":3}');
  });
});

describe("a page that starts with {", () => {
  const page = `{ this is a page, not JSON <script type="${T}">{"ok":4}</script>`;

  it("is searched for its block unless it really is JSON", () => {
    expect(processTextFrom(page).text).toBe('{"ok":4}');
    expect(processTextFrom('{"a":1}').text).toBe('{"a":1}');
  });

  it("is taken as it is for a .json file, so its JSON errors are reported as JSON errors", () => {
    expect(processTextFrom(page, { json: true }).text).toBe(page);
    expect(processTextFrom("not json at all", { json: true }).text).toBe("not json at all");
  });
});
