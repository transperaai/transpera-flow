#!/usr/bin/env bash
#
# new-client.sh: walks Austin through standing up one client deployment (docs/new-client.md).
# Generated from the /wizard skill template. It never asks for a secret and never writes an env file.
#
# Everything above the "STAGES" marker is the wizard library: do not hand-edit
# it. Author the per-step stages below the marker.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library: delightful, consistent UX, identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs written to ENV_FILE this run
WRITTEN_SECRET=() # secret NAMEs set this run
SKIPPED=()        # things we couldn't do (e.g. gh missing)

# _clear wipes the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" shows the opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later, since it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" clears the screen, then announces a stage and shows progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." prints a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." is a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL opens it in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser; visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

# pause "msg" waits for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" is a y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY: current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" reads a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" is like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE upserts KEY=VALUE into ENV_FILE (creates it; replaces
# any existing line). Idempotent.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE sets a GitHub Actions repo secret via gh. Falls back
# to a warning (and records it) if gh is unavailable or unauthenticated.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name: gh not ready; set it later"
}

# set_var NAME VALUE sets a GitHub Actions repo variable (non-secret).
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name, gh not ready; set it later"
}

# finish clears, then shows a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES: one per manual step. Checklist with the reasons: docs/new-client.md.
# No secret ever passes through this terminal: ask_secret and write_env are not used,
# and ENV_FILE points at /dev/null so a stray .env is never read as a default.
# ──────────────────────────────────────────────────────────────────────────

ENV_FILE=/dev/null
TOTAL_STAGES=8

banner "New client deployment (Vercel + Neon + Google sign-in)"

# ── 1. Names and URLs (public values only; used to print exact clicks) ────
stage "Names and URLs"
say "Pick a short lowercase name for the client, e.g. acme. It names the Vercel project and the database."
ask CLIENT_SLUG "Client name (letters, digits, dashes):"
[[ "$CLIENT_SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { warn "Use lowercase letters, digits and dashes only."; exit 1; }
say "The production URL is the client's domain, or https://<project>.vercel.app until they have one."
ask PROD_URL "Production URL (https://...):"
PROD_URL="${PROD_URL%/}"
[[ "$PROD_URL" =~ ^https://[a-z0-9.-]+$ ]] || { warn "Must look like https://host with no path."; exit 1; }
say "Preview deployments sign in through one stable alias, because Google only knows one origin per project."
ask PREVIEW_URL "Preview alias (https://${CLIENT_SLUG}-next.vercel.app, or Enter to skip):"
PREVIEW_URL="${PREVIEW_URL%/}"
[[ -z "$PREVIEW_URL" || "$PREVIEW_URL" =~ ^https://[a-z0-9.-]+$ ]] || { warn "Must look like https://host with no path."; exit 1; }
note "Nothing secret is asked in this wizard. Secrets go straight into the Vercel and Google dashboards."

# ── 2. Vercel project ─────────────────────────────────────────────────────
stage "Vercel project"
open_url "https://vercel.com/new"
step "Team selector (top left): choose your team. Click Import next to transpera-flow (GitHub). If it is missing, Adjust GitHub App Permissions and allow it."
step "Project Name: ${CLIENT_SLUG}-flow (or any name; it fixes the .vercel.app address)."
step "Root Directory: click Edit, choose apps/web, Continue. Framework stays Next.js."
step "Do NOT add environment variables here. Click Deploy; the first deploy may fail on missing settings, which is fine."
note "The region (syd1) comes from apps/web/vercel.json, so there is nothing to set."
open_url "https://vercel.com/dashboard"
step "Project → Settings → Git: confirm Production Branch is main (or the branch Claude names)."
step "Project → Settings → Domains: add ${PROD_URL#https://} if it is a custom domain, then follow Vercel's DNS instructions."
pause "Press Enter when the project exists..."

# ── 3. Neon through Vercel Storage ────────────────────────────────────────
stage "Neon database"
step "Project → Storage tab → Create Database → Neon (Serverless Postgres) → Continue."
step "Region: Sydney (aws-ap-southeast-2). Plan: Free. Name: ${CLIENT_SLUG}-flow-db. Turn Neon Auth OFF and Realtime OFF."
step "On 'Connect project' tick Production AND Preview (and Development if offered)."
step "Custom Prefix: DATABASE (so the variable is DATABASE_URL)."
step "If it offers a database branch for each preview deployment, leave that OFF. → Connect."
step "Settings → Environment Variables: check DATABASE_URL exists for Production and Preview."
pause "Press Enter when Neon is connected..."

# ── 4. Migrations ─────────────────────────────────────────────────────────
stage "Apply migrations"
say "Migrations run as the database owner (DATABASE_URL). Nobody copies that string by hand."
if [[ -n "${DATABASE_URL:-}" ]]; then
  say "DATABASE_URL is set in this shell."
  if [[ "$DATABASE_URL" == *localhost* || "$DATABASE_URL" == *127.0.0.1* ]]; then
    warn "It points at a local database, not the client's Neon database."
  fi
  if confirm "Apply migrations to the database DATABASE_URL points at?"; then
    pnpm --filter @transpera-flow/db migrate
  else
    SKIPPED+=("Migrations (pnpm --filter @transpera-flow/db migrate)")
  fi
else
  say "DATABASE_URL is not set in this shell, so this wizard will not run them."
  step "Tell Claude 'Neon is created for ${CLIENT_SLUG}'. Claude finds the database through the Neon API and applies the migrations."
  note "From a cloud container port 5432 is blocked; Claude uses Neon's WebSocket route (docs/supabase-notes.md, 'Checked on Neon')."
  SKIPPED+=("Migrations: ask Claude to apply them")
  pause "Press Enter once Claude says migrations are applied (or to carry on)..."
fi

# ── 5. App login ──────────────────────────────────────────────────────────
stage "App login (authenticator)"
say "The app's queries must not run as the owner, which bypasses row-level security."
step "Tell Claude 'Create the app login for ${CLIENT_SLUG}'."
say "Claude runs packages/db/scripts/create-app-login.sql with a generated password and sets APP_DATABASE_URL in Vercel"
say "(Production and Preview, Sensitive) through the API. The password is never printed."
pause "Press Enter when Claude confirms APP_DATABASE_URL is set..."

# ── 6. Google OAuth ───────────────────────────────────────────────────────
stage "Google OAuth: add this deployment's addresses"
say "Use the shared 'Transpera Flow' OAuth client; it already has its ID and secret in the other deployments."
open_url "https://console.cloud.google.com/apis/credentials"
step "Pick the Google Cloud project that holds 'Transpera Flow' → click that OAuth 2.0 client."
step "Authorised JavaScript origins → Add URI: ${PROD_URL}"
step "Authorised redirect URIs → Add URI: ${PROD_URL}/api/auth/callback/google"
if [[ -n "$PREVIEW_URL" ]]; then
  step "Also add origin ${PREVIEW_URL} and redirect URI ${PREVIEW_URL}/api/auth/callback/google"
fi
step "Save (changes can take a few minutes to apply)."
warn "Give the client its OWN OAuth client instead if they want their own consent-screen name or their Workspace blocks outside apps."
pause "Press Enter when saved..."

# ── 7. Environment variables ──────────────────────────────────────────────
stage "Environment variables"
open_url "https://vercel.com/dashboard"
step "Project → Settings → Environment Variables. Add these yourself (tick Sensitive on the secret):"
step "GOOGLE_CLIENT_ID (Production, Preview), copied from the shared Google client."
step "GOOGLE_CLIENT_SECRET (Production, Preview, Sensitive), copied from the shared Google client."
say "Paste them from Google straight into Vercel, never into this terminal or into chat."
step "Tell Claude 'Google is set for ${CLIENT_SLUG}'. Claude sets, without printing any secret:"
say "BETTER_AUTH_SECRET, OAUTH_PROXY_SECRET (generated), BETTER_AUTH_URL (${PROD_URL} for Production,"
say "${PREVIEW_URL:-the preview alias} for Preview), AUTH_PROVIDERS=google, ACCESS_ADMIN_EMAILS (the first admin)."
step "Then Deployments → the latest one → ⋯ → Redeploy, so the new variables apply."
pause "Press Enter when the redeploy is Ready..."

# ── 8. First sign-in ──────────────────────────────────────────────────────
stage "First sign-in and smoke test"
open_url "$PROD_URL"
step "Sign in with Google using the ACCESS_ADMIN_EMAILS address. You should land in the app, not an access-denied page."
step "Settings → Access → Who can sign in: add the client's domain (e.g. client.com) with a default role, and named emails."
step "Open or create a process and run a simulation; reload and confirm it persisted."
step "Sign out and in again; check a second address that is NOT on the list is refused."
pause "Press Enter to finish..."

_clear
printf '\n%s%s  ✓ %s is set up%s\n' "$BOLD" "$GREEN" "$CLIENT_SLUG" "$RESET"
if (( ${#SKIPPED[@]} )); then
  warn "still to do:"
  for s in "${SKIPPED[@]}"; do note "  - $s"; done
fi
note "Costs, Microsoft sign-in and tearing down: docs/new-client.md"
printf '\n'
