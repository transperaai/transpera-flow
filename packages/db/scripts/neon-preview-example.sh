#!/usr/bin/env bash
# Loads the made-up example agency into an EMPTY workspace on the Neon PREVIEW database (project purple-wind-75278769,
# branch main). Never production, never the client's deployment.
#   packages/db/scripts/neon-preview-example.sh --list               # workspaces on the preview: slug, name
#   packages/db/scripts/neon-preview-example.sh --workspace <slug>   # load the example (refuses a non-empty workspace)
#   packages/db/scripts/neon-preview-example.sh --workspace <slug> --add-issues   # add the example issues, change links, solutions and blocks
#                                                                    # to a workspace the example filled (changes nothing if it has issues)
# The connection URI comes from the Neon API (the agent proxy injects the key), is held only in this process's
# environment, and is never printed or written to disk.
set -euo pipefail
case "${1:-}" in
  --list) mode=list ;;
  --workspace)
    [[ "${2:-}" =~ ^[a-z0-9-]+$ ]] || { echo "Usage: $0 --list | --workspace <slug> [--add-issues]" >&2; exit 2; }
    case "${3:-}" in
      "") mode=load ;;
      --add-issues) mode=issues ;;
      *) echo "Usage: $0 --list | --workspace <slug> [--add-issues]" >&2; exit 2 ;;
    esac ;;
  *) echo "Usage: $0 --list | --workspace <slug> [--add-issues]" >&2; exit 2 ;;
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
# The loader's sources import each other without extensions (as vitest resolves them), so run it through jiti.
jiti=$(ls -d ../../node_modules/.pnpm/jiti@*/node_modules/jiti/lib/jiti-cli.mjs | tail -1)
if [ "$mode" = issues ]; then
  DATABASE_URL="$uri" exec node "$jiti" scripts/capacity-example-issues.ts --workspace "$2" --driver neon-ws
fi
DATABASE_URL="$uri" exec node "$jiti" scripts/capacity-example.ts --workspace "$2" --driver neon-ws
