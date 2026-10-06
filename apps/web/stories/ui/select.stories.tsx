import type { Meta, StoryObj } from "@storybook/react-vite";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";

const meta: Meta = { title: "UI/Select" };
export default meta;

const items = (
  <>
    <SelectItem value="a">First option</SelectItem>
    <SelectItem value="b">Second option</SelectItem>
  </>
);

export const Variants: StoryObj = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Select>
        <SelectTrigger className="w-44">
          <SelectValue placeholder="Placeholder" />
        </SelectTrigger>
        <SelectContent>{items}</SelectContent>
      </Select>
      <Select defaultValue="a">
        <SelectTrigger className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{items}</SelectContent>
      </Select>
      <Select defaultValue="a">
        <SelectTrigger size="sm" className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{items}</SelectContent>
      </Select>
      <Select disabled defaultValue="a">
        <SelectTrigger className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{items}</SelectContent>
      </Select>
      <Select defaultValue="a">
        <SelectTrigger className="w-44" aria-invalid>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{items}</SelectContent>
      </Select>
    </div>
  ),
};

export const Open: StoryObj = {
  tags: ["visual-page"],
  render: () => (
    <Select open defaultValue="b">
      <SelectTrigger className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Group</SelectLabel>
          {items}
        </SelectGroup>
        <SelectSeparator />
        <SelectItem value="c">Third option</SelectItem>
      </SelectContent>
    </Select>
  ),
};
