#!/bin/sh
# OpenReply — one-paste installer for a fresh Debian/Ubuntu LXC or VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/rajvirsoin/openreply/main/deploy/nas/install.sh | sh
#
# Idempotent: re-running updates the code and restarts the stack, but never
# overwrites an existing .env (your secrets survive).
#
# Override the source repo with:  REPO_URL=https://github.com/you/openreply.git sh install.sh

set -eu

REPO_URL="${REPO_URL:-https://github.com/rajvirsoin/openreply.git}"
BASE_DIR="/opt/openreply"
ENV_FILE="$BASE_DIR/.env"

say() { printf '\n\033[1m[openreply]\033[0m %s\n' "$1"; }

if [ "$(id -u)" != "0" ]; then
  echo "Run as root (this is meant for a dedicated LXC/VM)." >&2
  exit 1
fi

# ── Dependencies ────────────────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  say "Installing git…"
  apt-get update -qq && apt-get install -y -qq git >/dev/null
fi

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker…"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi

if ! docker compose version >/dev/null 2>&1; then
  say "Docker Compose v2 plugin missing — installing…"
  apt-get update -qq && apt-get install -y -qq docker-compose-plugin >/dev/null
fi

# ── Code ────────────────────────────────────────────────────────────────────
mkdir -p "$BASE_DIR/backups"
if [ -d "$BASE_DIR/src/.git" ]; then
  say "Updating existing checkout…"
  git -C "$BASE_DIR/src" pull --ff-only
else
  say "Cloning $REPO_URL…"
  git clone --depth 1 "$REPO_URL" "$BASE_DIR/src"
fi
cp "$BASE_DIR/src/deploy/nas/docker-compose.yml" "$BASE_DIR/docker-compose.yml"

# ── Environment ─────────────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  say "Keeping existing .env (edit it and re-run 'docker compose up -d' to change values)."
else
  say "Generating $ENV_FILE…"

  printf 'Public URL (e.g. https://reply.niosmedia.com) [http://localhost:3000]: '
  read -r PUBLIC_URL || PUBLIC_URL=""
  PUBLIC_URL="${PUBLIC_URL:-http://localhost:3000}"

  printf 'Resend API key (Enter to skip for now): '
  read -r RESEND_KEY || RESEND_KEY=""
  RESEND_KEY="${RESEND_KEY:-re_pending_fill_me_in}"

  printf 'Login sender, must be on your verified Resend domain [OpenReply <login@niosmedia.com>]: '
  read -r EMAIL_FROM_IN || EMAIL_FROM_IN=""
  EMAIL_FROM_IN="${EMAIL_FROM_IN:-OpenReply <login@niosmedia.com>}"

  printf 'Instagram App ID (Enter to skip for now): '
  read -r IG_APP_ID || IG_APP_ID=""
  IG_APP_ID="${IG_APP_ID:-pending-meta-app}"

  printf 'Instagram App Secret (Enter to skip for now): '
  read -r IG_APP_SECRET || IG_APP_SECRET=""
  IG_APP_SECRET="${IG_APP_SECRET:-pending-meta-app}"

  printf 'Facebook App Secret (Enter to skip for now): '
  read -r FB_APP_SECRET || FB_APP_SECRET=""
  FB_APP_SECRET="${FB_APP_SECRET:-pending-meta-app}"

  printf 'Cloudflare Tunnel token (Enter to skip — you can add it later): '
  read -r CF_TOKEN || CF_TOKEN=""

  PROFILES_LINE=""
  if [ -n "$CF_TOKEN" ]; then
    PROFILES_LINE="COMPOSE_PROFILES=tunnel"
  fi

  umask 077
  cat > "$ENV_FILE" <<EOF
# OpenReply production environment — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
# After editing, apply with: cd $BASE_DIR && docker compose up -d

NEXTAUTH_URL=$PUBLIC_URL
NEXTAUTH_SECRET=$(openssl rand -base64 32 | tr -d '\n')
CRON_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)

POSTGRES_PASSWORD=$(openssl rand -hex 24)

RESEND_API_KEY=$RESEND_KEY
EMAIL_FROM=$EMAIL_FROM_IN

META_GRAPH_API_VERSION=v25.0
INSTAGRAM_APP_ID=$IG_APP_ID
INSTAGRAM_APP_SECRET=$IG_APP_SECRET
FACEBOOK_APP_SECRET=$FB_APP_SECRET
WEBHOOK_VERIFY_TOKEN=$(openssl rand -hex 24)

CLOUDFLARE_TUNNEL_TOKEN=$CF_TOKEN
$PROFILES_LINE
EOF
  say "Secrets generated. NEVER commit this file anywhere."
fi

# ── Launch ──────────────────────────────────────────────────────────────────
say "Building and starting the stack (first build takes a few minutes)…"
cd "$BASE_DIR"
docker compose up -d --build

say "Waiting for the app to come up…"
i=0
until curl -fsS http://localhost:3000/api/health >/dev/null 2>&1; do
  i=$((i+1))
  [ "$i" -gt 60 ] && { echo "App did not come up in 5 min — check: docker compose logs app" >&2; exit 1; }
  sleep 5
done

echo
curl -fsS http://localhost:3000/api/health || true
echo
say "Done. Dashboard: http://<this-box>:3000 (and your tunnel URL once configured)."
say "Next steps: verify a Resend sender, create the Meta app, then log in and Connect Instagram."
say "Runbook: $BASE_DIR/src/deploy/nas/README.md"
