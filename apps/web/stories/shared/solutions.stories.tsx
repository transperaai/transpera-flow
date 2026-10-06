import type { Meta, StoryObj } from "@storybook/react-vite";
import { SolutionCards, VerdictWord } from "@/components/solutions/solution-cards";
import { northbeamRun, solutionsFixture } from "../fixtures";

const meta: Meta = { title: "Shared/Solutions" };
export default meta;

export const Verdicts: StoryObj = {
  name: "VerdictWord",
  render: () => (
    <div className="flex items-center gap-4">
      <VerdictWord verdict="pass" />
      <VerdictWord verdict="fail" />
      <VerdictWord verdict={null} />
    </div>
  ),
};

export const Cards: StoryObj = {
  name: "SolutionCards",
  tags: ["visual-phone"],
  render: () => {
    const { data, issues } = solutionsFixture();
    const process = northbeamRun().bundle.process;
    return (
      <SolutionCards
        data={data}
        issues={issues}
        processes={[{ id: process.id, name: process.name }]}
        base="/demo"
        demo
        canEdit
        from="/demo/solutions"
      />
    );
  },
};
