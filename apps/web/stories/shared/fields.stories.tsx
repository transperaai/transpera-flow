import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChecklistField, ConflictPrompt, DateField, NumberField, SelectField, TextField, ToggleField } from "@/components/fields";
import type { Saver } from "@/lib/fields/field-controller";

const meta: Meta = { title: "Shared/Fields" };
export default meta;

/** A save that always succeeds with what was typed. */
const ok =
  <T extends string | number | boolean | null | readonly string[]>(): Saver<T> =>
  async (_base, next) => ({ status: "saved", value: next });

const help = { description: "What this field does, in a sentence.", example: "An example of a value you might put here." };

export const Variants: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <div className="flex max-w-md flex-col gap-4">
      <TextField label="Name" value="Northbeam Agency" save={ok()} help={help} />
      <TextField label="Notes" value="A longer note over two lines of text." save={ok()} multiline optional hint="Optional." />
      <TextField label="Disabled" value="Read only" save={ok()} disabled />
      <DateField label="Start date" value="2026-10-05" save={ok()} help={help} />
      <NumberField label="Hours a week" value={37.5} save={ok()} unit="h" min={0} max={80} help={help} />
      <NumberField label="Share" value={0.25} save={ok()} scale={100} unit="%" />
      <SelectField
        label="Role"
        value="b"
        save={ok()}
        options={[
          { value: "a", label: "Account manager" },
          { value: "b", label: "PPC specialist" },
        ]}
        noneLabel="No role"
        help={help}
      />
      <ToggleField label="Active" value onLabel="Active" offLabel="Left the company" save={ok()} help={help} />
      <ChecklistField
        label="Roles covered"
        value={["a"]}
        save={ok()}
        options={[
          { id: "a", label: "Account manager" },
          { id: "b", label: "PPC specialist", sublabel: "part time" },
          { id: "c", label: "Designer" },
        ]}
        help={help}
      />
    </div>
  ),
};

export const Conflict: StoryObj = {
  tags: ["visual-phone"],
  render: () => <ConflictPrompt subject="the name" by="Tom" theirs="Northbeam Ltd" mine="Northbeam Agency" onKeepMine={() => undefined} onKeepTheirs={() => undefined} />,
};
