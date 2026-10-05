import { describe, expect, it } from "vitest";
import { checkProcessFileText, NO_BLOCK_MESSAGE, PROCESS_FILE_EXAMPLE, processTextFrom } from "../src/process-file";

// Finding the transpera-process/1 object in an HTML page (issue #166, B13 slice 2): only the embedded block counts.

const json = JSON.stringify(PROCESS_FILE_EXAMPLE);
const page = (script: string) => `<!doctype html><html><head><title>Flow</title><script>var x = 1;</script></head><body><svg></svg>${script}</body></html>`;

describe("finding the process in an HTML page", () => {
  it("reads the block, whatever the quoting and case of its type", () => {
    for (const attr of [`type="application/vnd.transpera-process+json"`, `type='application/vnd.transpera-process+json'`, `id="p" TYPE=application/vnd.transpera-process+json`, `type="Application/VND.Transpera-Process+JSON"`]) {
      expect(processTextFrom(page(`<script ${attr}>\n${json}\n</script>`)).text, attr).toBe(json);
    }
  });

  it("takes a JSON file as it is, with or without a byte-order mark", () => {
    expect(processTextFrom(`﻿  ${json}\n`).text).toBe(json);
  });

  it("ignores other scripts, and says plainly when there is no block", () => {
    const none = processTextFrom(page(`<script type="application/ld+json">${json}</script>`));
    expect(none.text).toBeUndefined();
    expect(none.error).toBe(NO_BLOCK_MESSAGE);
    expect(NO_BLOCK_MESSAGE).toContain("Copy prompt for Claude");
    expect(processTextFrom("plain text").error).toBe(NO_BLOCK_MESSAGE);
  });

  it("says an empty block is empty, and uses the first block when there are two", () => {
    expect(processTextFrom(page(`<script type="application/vnd.transpera-process+json">  </script>`)).error).toMatch(/block in this page is empty/);
    const two = page(`<script type="application/vnd.transpera-process+json">{"a":1}</script><script type="application/vnd.transpera-process+json">{"b":2}</script>`);
    expect(processTextFrom(two).text).toBe('{"a":1}');
  });

  it("the block's text checks like a file", () => {
    const text = processTextFrom(page(`<script type="application/vnd.transpera-process+json">${json}</script>`)).text!;
    expect(checkProcessFileText(text).errors).toEqual([]);
  });
});
