import Link from "next/link";
import { Help } from "@/components/help";
import { RatingPill } from "@/components/overview/rating-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AgencyWorkspaceRow } from "@/lib/data";

// The agency's workspace list (issue #30, B1 part 3): one row per company with the headline numbers its Overview last recorded.
// The numbers come from `workspace_headlines`, written when an owner or editor opens the Overview, so a workspace nobody has
// opened yet shows a prompt instead of a number.

const COLUMN_HELP = {
  flow: {
    label: "Flow efficiency",
    description:
      "How much of the time work spends in the company's processes is hands-on work, rather than waiting for a person or for someone else.",
    example:
      "At 18%, a task that takes 10 days from start to finish is worked on for under 2 of them.",
  },
  attention: {
    label: "Processes needing attention",
    description:
      "How many of the company's processes are rated Operational risk or Bad by their open issues, out of all its processes.",
    example:
      "2 of 6 means two of six processes have an open issue that serious.",
  },
  risk: {
    label: "Open Operational risk issues",
    description:
      "Issues rated Operational risk, the most serious rating, that are still open or being worked on.",
    example:
      "3 means three issues of that kind are waiting for someone to deal with them.",
  },
  clients: {
    label: "Client groups at risk",
    description:
      "How many groups of similar clients are, on average, at risk of leaving by the end of the forecast, out of all the groups.",
    example:
      "1 of 3 means one of three client groups has an average health below 50.",
  },
  activity: {
    label: "Last activity",
    description:
      "The latest change anyone made to the company's process versions, issues, findings, sources or solutions.",
    example:
      "6 Oct 2026 means nothing has changed in the workspace since that day.",
  },
} as const;

const day = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const when = (iso: string) => day.format(new Date(iso));

function Heading({
  help,
  children,
}: {
  help: (typeof COLUMN_HELP)[keyof typeof COLUMN_HELP];
  children: string;
}) {
  return (
    <TableHead>
      <span className="inline-flex items-center whitespace-nowrap">
        {children}
        <Help {...help} />
      </span>
    </TableHead>
  );
}

function OfTotal({ n, total }: { n: number; total: number }) {
  return (
    <span className="tabular-nums">
      <b className="font-semibold">{n}</b>{" "}
      <span className="text-muted-foreground">of {total}</span>
    </span>
  );
}

export function AgencyWorkspaceTable({ rows }: { rows: AgencyWorkspaceRow[] }) {
  return (
    <Table data-agency-workspaces>
      <TableHeader>
        <TableRow>
          <TableHead>Workspace</TableHead>
          <Heading help={COLUMN_HELP.flow}>Flow efficiency</Heading>
          <Heading help={COLUMN_HELP.attention}>
            Processes needing attention
          </Heading>
          <Heading help={COLUMN_HELP.risk}>
            Open Operational risk issues
          </Heading>
          <Heading help={COLUMN_HELP.clients}>Client groups at risk</Heading>
          <Heading help={COLUMN_HELP.activity}>Last activity</Heading>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((ws) => {
          const n = ws.headline?.numbers;
          return (
            <TableRow key={ws.id} data-workspace={ws.slug}>
              <TableCell className="font-medium">
                <Link
                  href={`/w/${ws.slug}`}
                  className="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {ws.name}
                </Link>
                {ws.headline && (
                  <div className="text-xs font-normal text-muted-foreground">
                    Numbers as of {when(ws.headline.computedAt)}
                  </div>
                )}
              </TableCell>
              {n ? (
                <>
                  <TableCell className="tabular-nums">
                    {n.flow_efficiency === null
                      ? "—"
                      : `${Math.round(n.flow_efficiency * 100)}%`}
                  </TableCell>
                  <TableCell>
                    <OfTotal
                      n={n.processes_attention}
                      total={n.processes_total}
                    />
                  </TableCell>
                </>
              ) : (
                <TableCell colSpan={2} className="text-muted-foreground">
                  Open the Overview once to see these
                </TableCell>
              )}
              <TableCell>
                <span className="inline-flex items-center gap-2 tabular-nums">
                  <b className="font-semibold">{ws.openRiskIssues}</b>
                  {ws.openRiskIssues > 0 && <RatingPill rating="risk" />}
                </span>
              </TableCell>
              {n ? (
                <TableCell>
                  <OfTotal
                    n={n.client_groups_at_risk}
                    total={n.client_groups_total}
                  />
                </TableCell>
              ) : (
                <TableCell className="text-muted-foreground">
                  Open the Overview once to see these
                </TableCell>
              )}
              <TableCell className="whitespace-nowrap">
                {ws.lastActivity ? (
                  when(ws.lastActivity)
                ) : (
                  <span className="text-muted-foreground">No activity yet</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
