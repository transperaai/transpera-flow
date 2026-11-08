import type { IssueStatus } from "@transpera-flow/db";
import { StatusPill, StatusPillMenu, type PillOption } from "@/components/page-kit/status-pill";
import { statusLabel } from "@/lib/issues/pages";

/** The theme token each status is drawn in: its own colour, so a list reads at a glance. */
export const STATUS_TONE: Record<IssueStatus, string> = {
  open: "auto",
  testing: "warn",
  resolved: "good",
  wont_fix: "fg-3",
  dismissed: "line-2",
};

/** An issue's status as a pill (the page kit's `StatusPill` in the status's colour). */
export function IssueStatusPill({ status, className }: { status: IssueStatus; className?: string }) {
  return <StatusPill value={status} label={statusLabel(status)} tone={STATUS_TONE[status]} className={className} />;
}

/** The statuses a person can set on an issue, in the order the dropdown lists them. */
export const ISSUE_STATUS_OPTIONS: readonly PillOption<IssueStatus>[] = (["open", "testing", "resolved", "wont_fix"] as const).map((s) => ({
  value: s,
  label: statusLabel(s),
  tone: STATUS_TONE[s],
}));

/** An issue's status as a dropdown pill: choosing one calls `onChange` at once. */
export function IssueStatusMenu({ status, onChange, disabled }: { status: IssueStatus; onChange: (s: IssueStatus) => void; disabled?: boolean }) {
  return <StatusPillMenu name="Status" value={status} options={ISSUE_STATUS_OPTIONS} onChange={onChange} disabled={disabled} />;
}
