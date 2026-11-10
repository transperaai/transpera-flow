import { KeyRound } from "lucide-react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AppHeader } from "@/components/app-header";
import { EmptyState, MetaLine, PageHeader } from "@/components/page-kit";
import { ListTable, ListTableHeader } from "@/components/processes/list-table";
import { pageBodyClass } from "@/components/shell/page";
import { TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { authEnv } from "@/lib/auth/env";
import { getDb } from "@/lib/auth/session";
import { CreateTokenButton, RevokeTokenButton } from "./create-token-form";
import { PhoneReadOnly } from "@/components/shell/phone-read-only";

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");

export default async function ApiTokensPage() {
  await connection();
  if (!authEnv()) notFound();
  const db = await getDb();
  const tokens = await db
    .selectFrom("api_tokens")
    .select(["id", "label", "created_at", "last_used_at", "revoked_at"])
    .orderBy("created_at", "desc")
    .execute();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const endpoint = `${proto}://${host}/api/mcp`;

  return (
    <main className="flex w-full flex-col">
      <div className="px-4 sm:px-6 lg:px-8">
        <AppHeader signedIn />
      </div>
      <div className={pageBodyClass("fluid")}>
        <PageHeader
          label="API tokens"
          title="API tokens"
          meta={
            <MetaLine className="max-w-prose">
              <span>
                Personal tokens let Claude Code or Claude desktop read Transpera Flow as you, through the MCP server at <code className="font-mono text-xs break-all">{endpoint}</code>. A token
                sees exactly what you can see and is read only: Claude can read your workspaces but can&apos;t change anything. Revoke any token you no longer use.
              </span>
            </MetaLine>
          }
          actions={
            <PhoneReadOnly notice={false}>
              <CreateTokenButton endpoint={endpoint} />
            </PhoneReadOnly>
          }
        />
        {tokens.length === 0 ? (
          <EmptyState icon={KeyRound} data-no-tokens>
            No tokens yet. Create one to connect Claude Code or Claude desktop.
          </EmptyState>
        ) : (
          <PhoneReadOnly>
            <ListTable aria-label="Your tokens" data-tokens>
              <ListTableHeader stickyTop="page">
                <TableRow>
                  <TableHead className="px-3">Name</TableHead>
                  <TableHead className="px-3">Created</TableHead>
                  <TableHead className="px-3">Last used</TableHead>
                  <TableHead className="px-3">Status</TableHead>
                  <TableHead className="px-3" aria-label="Revoke the token" />
                </TableRow>
              </ListTableHeader>
              <TableBody>
                {tokens.map((t) => (
                  <TableRow key={t.id} data-token={t.id}>
                    <TableCell className="px-3 py-2.5 font-medium">{t.label}</TableCell>
                    <TableCell className="px-3 tabular-nums">{date(t.created_at)}</TableCell>
                    <TableCell className="px-3 tabular-nums">{date(t.last_used_at)}</TableCell>
                    <TableCell className="px-3">{t.revoked_at ? <span className="text-muted-foreground">Revoked {date(t.revoked_at)}</span> : "Active"}</TableCell>
                    <TableCell className="px-3 py-2 text-right">{!t.revoked_at && <RevokeTokenButton id={t.id} label={t.label} />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ListTable>
          </PhoneReadOnly>
        )}
      </div>
    </main>
  );
}
