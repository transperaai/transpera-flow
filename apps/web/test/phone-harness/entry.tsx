// The phone pieces (issue #44) on a bare page, for ../phone-browser.test.ts. Bundled by esbuild and driven through
// `window.mountPhone`; nothing here ships.

import { createRoot, type Root } from "react-dom/client";
import { EditorPhoneGate } from "@/components/editor/editor-phone-gate";
import { PhoneNotice, PhoneReadOnly } from "@/components/shell/phone-read-only";

declare global {
  interface Window {
    mountPhone: (what: "form" | "form-no-notice" | "gate" | "notice") => void;
  }
}

let root: Root | null = null;
window.mountPhone = (what) => {
  root?.unmount();
  root = createRoot(document.getElementById("root")!);
  const form = (notice: boolean) => (
    <PhoneReadOnly notice={notice}>
      <label>
        Name <input name="name" defaultValue="Northbeam" />
      </label>
      <button type="button">Save</button>
      <a href="#after">A link after the form</a>
    </PhoneReadOnly>
  );
  root.render(
    what === "gate" ? (
      <EditorPhoneGate backHref="/demo/p/1">
        <div data-editor-child>The Editor</div>
      </EditorPhoneGate>
    ) : what === "notice" ? (
      <PhoneNotice />
    ) : (
      form(what === "form")
    ),
  );
};
