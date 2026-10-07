import type { Meta, StoryObj } from "@storybook/react-vite";
import { EditorPhoneGate } from "@/components/editor/editor-phone-gate";
import { NumberField, TextField, ToggleField } from "@/components/fields";
import { PhoneNotice, PhoneReadOnly } from "@/components/shell/phone-read-only";
import type { Saver } from "@/lib/fields/field-controller";

// Phones (under 640px) are read only (issue #44): a notice, settings forms disabled, and the Editor replaced by a notice.
// The `visual-phone` stories show the phone state at 400px and the tablet or desktop state at 1280px.

const meta: Meta = { title: "Shared/Phone", parameters: { layout: "padded" } };
export default meta;

const ok =
  <T extends string | number | boolean | null | readonly string[]>(): Saver<T> =>
  async (_base, next) => ({ status: "saved", value: next });

/** The one line a phone sees where it can't make changes. It renders nothing on a wider screen, so this story is empty there. */
export const Notice: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <div className="max-w-md">
      <PhoneNotice />
    </div>
  ),
};

/** A form body: disabled with the notice at 400px, live at 1280px. */
export const ReadOnlyForm: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <div className="flex max-w-md flex-col gap-4">
      <PhoneReadOnly>
        <TextField label="Name" value="Northbeam Agency" save={ok()} />
        <NumberField label="Hours a week" value={37.5} save={ok()} unit="h" min={0} max={80} />
        <ToggleField label="Show on the map" value={true} save={ok()} onLabel="Shown" offLabel="Hidden" />
      </PhoneReadOnly>
    </div>
  ),
};

/** The Editor's gate: the notice at 400px, the Editor (a stand-in here) at 1280px. */
export const EditorGate: StoryObj = {
  tags: ["visual-phone"],
  parameters: { layout: "fullscreen" },
  render: () => (
    <EditorPhoneGate backHref="/demo/p/1">
      <div className="p-6 text-sm">The Editor would be here.</div>
    </EditorPhoneGate>
  ),
};
