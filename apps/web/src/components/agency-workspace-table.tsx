import Link from "next/link";
import { Help } from "@/components/help";
import { RatingPill } from "@/components/overview/rating-pill";
import { ListTable, ListTableHeader } from "@/components/processes/list-table";
import { TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import type { AgencyWorkspaceRow } from "@/lib/data";
import { cn } from "@/lib/utils";

// The agency's workspace list (issue #30, B1 part 3): one row per company with the headline numbers its Overview last recorded.
// The numbers come from `workspace_headlines`, written when an Agency admin opens the Overview, so a workspace nobody has
// opened yet shows a prompt instead of a number.

const COLUMN_HELP = {
  flow: {
    label: "Flow efficiency",
    description: "How much of the time work spends in the company's processes is hands-on work, rather than waiting for a person or for someone else.",
    example: "At 18%, a task that takes 10 days from start to finish is worked on for under 2 of them.",
  },
  attention: {
    label: "Processes needing attention",
    description: "How many of the company's processes are rated Operational risk or Bad by their open issues, out of all its processes.",
    example: "2 of 6 means two of six processes have an open issue that serious.",
  },
  risk: {
    label: "Open Operational risk issues",
    description: "Issues rated Operational risk, the most serious rating, that are still open or being worked on.",
    example: "3 means three issues of that kind are waiting for someone to deal with them.",
  },
  clients: {
    label: "Client groups at risk",
    description: "How many groups of similar clients are, on average, at risk of leaving by the end of the forecast, out of all the groups.",
    example: "1 of 3 means one of three client groups has an average health below 50.",
  },
  activity: {
    label: "Last activity",
    description: "The latest change anyone made to the company's process versions, issues, sources or solutions.",
    example: "6 Oct 2026 means nothing has changed in the workspace since that day.",
  },
} as const;

const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const when = (iso: string) => day.format(new Date(iso));

function Heading({ help, right, children }: { help: (typeof COLUMN_HELP)[keyof typeof COLUMN_HELP]; right?: boolean; children: string }) {
  return (
    <TableHead className={cn("px-3", right && "text-right")}>
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
      <b className="font-semibold">{n}</b> <span className="text-muted-foreground">of {total}</span>
    </span>
  );
}

export function AgencyWorkspaceTable({ rows }: { rows: AgencyWorkspaceRow[] }) {
  return (
    <ListTable data-agency-workspaces aria-label="Workspaces">
      <ListTableHeader stickyTop="page">
        <TableRow>
          <TableHead className="px-3">Workspace</TableHead>
          <Heading help={COLUMN_HELP.flow} right>
            Flow efficiency
          </Heading>
          <Heading help={COLUMN_HELP.attention} right>
            Processes needing attention
          </Heading>
          <Heading help={COLUMN_HELP.risk} right>
            Open Operational risk issues
          </Heading>
          <Heading help={COLUMN_HELP.clients} right>
            Client groups at risk
          </Heading>
          <Heading help={COLUMN_HELP.activity}>Last activity</Heading>
        </TableRow>
      </ListTableHeader>
      <TableBody>
        {rows.map((ws) => {
          const n = ws.headline?.numbers;
          return (
            <TableRow key={ws.id} data-workspace={ws.slug}>
              <TableCell className="px-3 py-2.5 font-medium">
                <Link href={`/w/${ws.slug}`} className="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  {ws.name}
                </Link>
                {ws.headline && <div className="text-xs font-normal text-muted-foreground">Numbers as of {when(ws.headline.computedAt)}</div>}
              </TableCell>
              {n ? (
                <>
                  <TableCell className="px-3 text-right tabular-nums">{n.flow_efficiency === null ? "—" : `${Math.round(n.flow_efficiency * 100)}%`}</TableCell>
                  <TableCell className="px-3 text-right">
                    <OfTotal n={n.processes_attention} total={n.processes_total} />
                  </TableCell>
                </>
              ) : (
                <TableCell colSpan={2} className="px-3 text-right text-muted-foreground">
                  Open the Overview once to see these
                </TableCell>
              )}
              <TableCell className="px-3 text-right">
                <span className="inline-flex items-center gap-2 tabular-nums">
                  <b className="font-semibold">{ws.openRiskIssues}</b>
                  {ws.openRiskIssues > 0 && <RatingPill rating="risk" />}
                </span>
              </TableCell>
              {n ? (
                <TableCell className="px-3 text-right">
                  <OfTotal n={n.client_groups_at_risk} total={n.client_groups_total} />
                </TableCell>
              ) : (
                <TableCell className="px-3 text-right text-muted-foreground">Open the Overview once to see these</TableCell>
              )}
              <TableCell className="px-3 whitespace-nowrap tabular-nums">
                {ws.lastActivity ? when(ws.lastActivity) : <span className="text-muted-foreground">No activity yet</span>}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </ListTable>
  );
}
