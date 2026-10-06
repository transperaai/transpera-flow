import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const meta: Meta = { title: "UI/Tabs" };
export default meta;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex max-w-md flex-col gap-6">
      {(["default", "line"] as const).map((variant) => (
        <Tabs key={variant} defaultValue="one">
          <TabsList variant={variant}>
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two">Two</TabsTrigger>
            <TabsTrigger value="three" disabled>
              Disabled
            </TabsTrigger>
          </TabsList>
          <TabsContent value="one">Content of the first tab ({variant}).</TabsContent>
          <TabsContent value="two">Content of the second tab.</TabsContent>
        </Tabs>
      ))}
    </div>
  ),
};
