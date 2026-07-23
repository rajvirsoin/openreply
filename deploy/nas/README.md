# Self-hosting OpenReply on your own box (NAS / Proxmox LXC / VPS)

This folder deploys the entire stack — Postgres, Redis, web app, DM worker,
cron, nightly backups, and an optional Cloudflare Tunnel — on one always-on
Linux box with Docker. No Vercel, no Railway.

## Requirements

- A Debian/Ubuntu box that is always on (a Proxmox LXC with 2 GB RAM is plenty).
- A domain on Cloudflare (for the free tunnel + HTTPS), or any other way to
  expose HTTPS publicly. Meta webhooks require a public HTTPS URL.
- A free [Resend](https://resend.com) account with a verified sender domain
  (login is email magic links).
- A Meta developer app — follow [docs/setup.md](../../docs/setup.md), skipping
  the Vercel/Railway sections (this stack replaces them).

## Install

As root on the box:

```sh
curl -fsSL https://raw.githubusercontent.com/rajvirsoin/openreply/main/deploy/nas/install.sh | sh
```

The installer asks for your public URL and keys (Enter skips any of them),
generates all random secrets into `/opt/openreply/.env`, builds the image, and
starts everything. Re-running it later pulls the latest code and restarts the
stack without touching your `.env`.

## Cloudflare Tunnel (public HTTPS)

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel
   (Cloudflared connector).
2. Copy the token from the install command it shows.
3. Public hostname: `reply.yourdomain.com` → Service `HTTP` → `app:3000`.
4. Put the token in `/opt/openreply/.env` as `CLOUDFLARE_TUNNEL_TOKEN=…`,
   add the line `COMPOSE_PROFILES=tunnel`, then:
   `cd /opt/openreply && docker compose up -d`.
5. Set `NEXTAUTH_URL=https://reply.yourdomain.com` in `.env` and
   `docker compose up -d` again.

Your Meta OAuth redirect is then `https://reply.yourdomain.com/api/instagram/callback`
and the webhook callback is `https://reply.yourdomain.com/api/webhook`.

## Day-2 operations

```sh
cd /opt/openreply
docker compose ps                  # status
docker compose logs -f app worker  # live logs
docker compose up -d               # apply .env edits
git -C src pull && docker compose up -d --build   # update to latest code
```

- Health: `curl http://localhost:3000/api/health` — database, Redis, queue,
  and worker heartbeat in one JSON.
- Backups: nightly gzip dumps in `/opt/openreply/backups`, pruned after 14 days.
  Restore with:
  `gunzip -c backups/openreply-….sql.gz | docker compose exec -T postgres psql -U openreply openreply`
- Crons: the `cron` container replaces `vercel.json` — token refresh daily at
  05:00, next-reel binding every 10 minutes.

## Notes

- `ENCRYPTION_KEY` encrypts Instagram tokens at rest. If you lose it, every
  account must be reconnected. Back up `.env` somewhere safe.
- The app listens on LAN port 3000 for debugging (e.g. over Tailscale); the
  public URL should always be the tunnel hostname.
