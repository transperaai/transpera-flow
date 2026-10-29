import type { Meta, StoryObj } from "@storybook/react-vite";
import { DEFAULT_PURPOSES } from "@transpera-flow/db";
import { PurposesSettings } from "@/components/purposes/purposes-settings";
import { TimeByPurpose } from "@/components/sandbox/time-by-purpose";
import { larkspurTime } from "../fixtures";

const meta: Meta = { title: "Shared/Purposes" };
export default meta;

const roles = [
  { id: "design", name: "Designer" },
  { id: "am", name: "Account manager" },
];

export const WhereTheTimeGoes: StoryObj = {
  tags: ["visual-phone"],
  render: () => {
    const { monthly, months } = larkspurTime();
    const people = Object.keys(monthly.time.people).map((id) => ({ id, name: id }));
    return (
      <div className="w-full max-w-5xl">
        <TimeByPurpose monthly={monthly} months={months} categories={DEFAULT_PURPOSES} roles={roles} people={people} viewer={{ seesEveryone: true, ownPersonId: null }} span="6 months" purposesHref="/w/larkspur/settings/purposes" />
      </div>
    );
  },
};

export const SettingsList: StoryObj = {
  render: () => (
    <PurposesSettings
      mode="live"
      workspaceId="a0000000-0000-4000-8000-000000000001"
      stored={null}
      initial={DEFAULT_PURPOSES.map((c) => ({ ...c }))}
      use={{ winning: 7, required: 2 }}
      save={async () => ({ status: "error", message: "Not available in Storybook" })}
    />
  ),
};

export const SettingsReadOnly: StoryObj = {
  render: () => <PurposesSettings mode="readonly" workspaceId="a0000000-0000-4000-8000-000000000001" stored={null} initial={DEFAULT_PURPOSES.map((c) => ({ ...c }))} use={{}} save={async () => ({ status: "not_found" })} />,
};
