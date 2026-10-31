#!/usr/bin/env bash
# Loads the made-up example agency into an EMPTY workspace on the Neon PREVIEW database (project purple-wind-75278769,
# branch main). Never production, never the client's deployment.
#   packages/db/scripts/neon-preview-example.sh --list               # workspaces on the preview: slug, name
#   packages/db/scripts/neon-preview-example.sh --workspace <slug>   # load the example (refuses a non-empty workspace)
# The connection URI comes from the Neon API (the agent proxy injects the key), is held only in this process's
# environment, and is never printed or written to disk.
set -euo pipefail
case "${1:-}" in
  --list) mode=list ;;
  --workspace) [[ "${2:-}" =~ ^[a-z0-9-]+$ ]] || { echo "Usage: $0 --list | --workspace <slug>" >&2; exit 2; }; mode=load ;;
  *) echo "Usage: $0 --list | --workspace <slug>" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."
uri=$(curl -sSf "https://console.neon.tech/api/v2/projects/purple-wind-75278769/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=false" \
  -H "Authorization: Bearer proxy-injected" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).uri))')
[ -n "$uri" ] || { echo "No connection URI from the Neon API" >&2; exit 1; }
if [ "$mode" = list ]; then
  DATABASE_URL="$uri" exec node --experimental-strip-types -e '
    import("./scripts/copy-from-supabase/connect.ts").then(async ({ connectTarget }) => {
      const { client, close } = await connectTarget(process.env.DATABASE_URL, "neon-ws");
      try {
        const r = await client.query("select slug, name from public.workspaces order by created_at");
        for (const w of r.rows) console.log(`${w.slug}\t${w.name}`);
      } finally { await close(); }
    });'
fi
DATABASE_URL="$uri" exec node --experimental-strip-types scripts/capacity-example.ts --workspace "$2" --driver neon-ws
