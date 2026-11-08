import { KeyRound } from "lucide-react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AppHeader } from "@/components/app-header";
import { EmptyState, MetaLine, PageHeader, SectionCard } from "@/components/page-kit";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { authEnv } from "@/lib/auth/env";
import { getDb } from "@/lib/auth/session";
import { revokeToken } from "./actions";
import { CreateTokenForm } from "./create-token-form";
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
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-12 sm:px-6">
      <AppHeader signedIn />
      <PageHeader
        label="API tokens"
        title="API tokens"
        meta={
          <MetaLine>
            <span>
              Personal tokens let Claude Code or Claude desktop use Transpera Flow as you, through the MCP server at{" "}
              <code className="font-mono text-xs break-all">{endpoint}</code>. A token sees exactly what you can see. Revoke any token you no longer use.
            </span>
          </MetaLine>
        }
      />
      <PhoneReadOnly>
        <SectionCard id="new-token" title="Create a token" description="Give it a name that says where it is used. It is shown once.">
          <CreateTokenForm endpoint={endpoint} />
        </SectionCard>
        <SectionCard id="tokens" title="Your tokens">
          {tokens.length === 0 ? (
            <EmptyState icon={KeyRound}>No tokens yet. Create one above to connect Claude Code or Claude desktop.</EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>{t.label}</TableCell>
                    <TableCell className="tabular-nums">{date(t.created_at)}</TableCell>
                    <TableCell className="tabular-nums">{date(t.last_used_at)}</TableCell>
                    <TableCell>{t.revoked_at ? `Revoked ${date(t.revoked_at)}` : "Active"}</TableCell>
                    <TableCell className="text-right">
                      {!t.revoked_at && (
                        <form action={revokeToken}>
                          <input type="hidden" name="id" value={t.id} />
                          <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                            Revoke
                          </Button>
                        </form>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      </PhoneReadOnly>
    </main>
  );
}
