import type { Meta, StoryObj } from "@storybook/react-vite";
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";

const meta: Meta = { title: "UI/Avatar" };
export default meta;

const sizes = ["sm", "default", "lg"] as const;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        {sizes.map((s) => (
          <Avatar key={s} size={s}>
            <AvatarFallback>AS</AvatarFallback>
          </Avatar>
        ))}
      </div>
      <div className="flex items-center gap-3">
        {sizes.map((s) => (
          <Avatar key={s} size={s}>
            <AvatarFallback>JD</AvatarFallback>
            <AvatarBadge />
          </Avatar>
        ))}
      </div>
      <AvatarGroup>
        <Avatar>
          <AvatarFallback>AS</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>MK</AvatarFallback>
        </Avatar>
        <AvatarGroupCount>+3</AvatarGroupCount>
      </AvatarGroup>
    </div>
  ),
};
