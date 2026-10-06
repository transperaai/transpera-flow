import type { Meta, StoryObj } from "@storybook/react-vite";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const meta: Meta = { title: "UI/Table" };
export default meta;

export const Variants: StoryObj = {
  render: () => (
    <Table className="max-w-xl">
      <TableHeader>
        <TableRow>
          <TableHead>Step</TableHead>
          <TableHead>Owner</TableHead>
          <TableHead className="text-right">Minutes</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Review application</TableCell>
          <TableCell>Underwriting</TableCell>
          <TableCell className="text-right">45</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Request documents</TableCell>
          <TableCell>Operations</TableCell>
          <TableCell className="text-right">15</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Issue policy</TableCell>
          <TableCell>Operations</TableCell>
          <TableCell className="text-right">10</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};
