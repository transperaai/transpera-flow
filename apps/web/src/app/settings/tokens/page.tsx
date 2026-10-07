import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AppHeader } from "@/components/app-header";
import { PageHeader } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";
import { supabaseEnv } from "@/lib/supabase/env";
import { revokeToken } from "./actions";
import { CreateTokenForm } from "./create-token-form";
import { PhoneReadOnly } from "@/components/shell/phone-read-only";

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");

export default async function ApiTokensPage() {
  await connection();
  if (!supabaseEnv()) redirect("/demo");
  const supabase = await createClient();
  const { data: tokens, error } = await supabase
    .from("api_tokens")
    .select("id, label, created_at, last_used_at, revoked_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const endpoint = `${proto}://${host}/api/mcp`;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-12 sm:px-6">
      <AppHeader signedIn />
      <PageHeader
        title="API tokens"
        description={
          <>
            Personal tokens let Claude Code or Claude desktop use Transpera Flow as you, through the MCP server at{" "}
            <code className="font-mono text-xs break-all">{endpoint}</code>. A token sees exactly what you can see. Revoke any token you no longer use.
          </>
        }
      />
      <PhoneReadOnly>
      <CreateTokenForm endpoint={endpoint} />
      <Card className="py-2">
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
            {tokens.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No tokens yet.
                </TableCell>
              </TableRow>
            )}
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
      </Card>
      </PhoneReadOnly>
    </main>
  );
}
