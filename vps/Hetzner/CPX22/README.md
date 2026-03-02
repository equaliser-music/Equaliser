# Hetzner CPX22 VPS Setup

Server: `77.42.68.194`

## Domains

| Domain | Purpose | SSL |
|--------|---------|-----|
| equaliser.app | Equaliser content node | Let's Encrypt |
| shibuyacrossings.com | Band website (static) | Let's Encrypt |

## Architecture

```
Internet (443/80)
    │
    ▼
Host nginx (SSL termination)
    ├── equaliser.app ──────→ Docker content node (localhost:8080)
    │                           ├── nginx (routing)
    │                           ├── orchestrator (FastAPI)
    │                           ├── IPFS (kubo)
    │                           └── NOSTR relay
    │
    └── shibuyacrossings.com → /var/www/shibuyacrossings.com/html/
```

### How the port override works

The content node's `docker-compose.yml` uses port `80:80` for local dev. On the VPS, a `docker-compose.override.yml` is placed alongside it which remaps to `8080:80`, freeing ports 80/443 for the host nginx. Docker Compose auto-merges the override when present.

Your local setup is unaffected — the override file only exists on the VPS.

## Setup Steps

### 1. Configure DNS at Porkbun

Log into [Porkbun](https://porkbun.com/) and add A records for both domains:

**equaliser.app:**
| Type | Host | Answer |
|------|------|--------|
| A | (blank / @) | 77.42.68.194 |
| A | www | 77.42.68.194 |

**shibuyacrossings.com:**
| Type | Host | Answer |
|------|------|--------|
| A | (blank / @) | 77.42.68.194 |
| A | www | 77.42.68.194 |

Verify propagation (can take up to 48h but usually minutes):
```bash
dig equaliser.app
dig shibuyacrossings.com
```

### 2. Set up GitHub deploy key on VPS

The repo is private, so the VPS needs a read-only deploy key to clone it.

**On the VPS:**
```bash
ssh -i ~/.ssh/Hetzner_CPX22 root@77.42.68.194

# Generate deploy key
ssh-keygen -t ed25519 -C "equaliser-vps-deploy" -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub
```

Copy the public key output.

**On GitHub:**
- Go to repo → **Settings** → **Deploy keys** → **Add deploy key**
- Title: `Hetzner VPS`
- Paste the public key
- Leave "Allow write access" unchecked

**Back on the VPS**, configure SSH to use the key:
```bash
cat >> ~/.ssh/config << 'EOF'
Host github.com
    IdentityFile ~/.ssh/github_deploy
    StrictHostKeyChecking accept-new
EOF
```

Verify it works:
```bash
ssh -T git@github.com
```

### 3. First-time deploy to VPS

From your local machine:
```bash
./vps/Hetzner/CPX22/deploy.sh --init
```

This clones the repo (via SSH) to `/root/Equaliser-1` on the VPS and copies all configs (nginx sites, docker-compose override, band site).

### 4. SSH into VPS and run setup

```bash
ssh -i ~/.ssh/Hetzner_CPX22 root@77.42.68.194
cd /root/vps-config
sudo bash setup.sh
```

This installs:
- Docker and Docker Compose
- nginx (host-level reverse proxy)
- certbot (Let's Encrypt SSL)
- ufw firewall (ports 22, 80, 443, 4001)
- jq, python3, python3-venv
- Python venv at `/root/Equaliser-1/.venv` with `coincurve` and `websocket-client` (needed by import/export tools)

### 5. Set up SSL certificates

Only run after DNS has propagated:
```bash
sudo bash setup-ssl.sh --email equaliser-music@proton.me
```

### 6. Start the content node

```bash
cd /root/Equaliser-1/content_node
docker compose up -d --build
```

The override file is already in place (deployed in step 2), so Docker will use port 8080 automatically.

## Using Tools on the VPS

The `tools/` directory is part of the repo clone, so all tools are available on the VPS. The import/export tools require Python dependencies which `setup.sh` installs automatically.

### Importing artist packages

Artist packages are directories (e.g. `shibuya-crossings.artist-package/`). Copy them from your local machine:

```bash
# From local machine — create packages dir and copy
ssh -i ~/.ssh/Hetzner_CPX22 root@77.42.68.194 "mkdir -p /root/Equaliser-1/packages"
scp -r -i ~/.ssh/Hetzner_CPX22 ./packages/shibuya-crossings.artist-package root@77.42.68.194:/root/Equaliser-1/packages/
```

Then on the VPS:

```bash
cd /root/Equaliser-1

# Fresh import (generates new NOSTR identity)
./tools/import-artist.sh ./packages/shibuya-crossings.artist-package --base-url http://localhost:8080

# Restore import (uses existing identity from backup.json)
./tools/import-artist.sh ./packages/shibuya-crossings.artist-package --restore --base-url http://localhost:8080

# Dry run (preview only)
./tools/import-artist.sh ./packages/shibuya-crossings.artist-package --dry-run --base-url http://localhost:8080
```

**Important:** Use `--base-url http://localhost:8080` on the VPS because the content node listens on port 8080 (host nginx is on 80). The default `http://localhost` would hit host nginx instead.

**Restore mode** requires an `identity/backup.json` file in the package. This is created during a fresh import. To use the same identity on the VPS as your local machine, copy the backup from your local packages:

```bash
# From local machine
scp -i ~/.ssh/Hetzner_CPX22 \
    ./packages/shibuya-crossings.artist-package/identity/backup.json \
    root@77.42.68.194:/root/Equaliser-1/packages/shibuya-crossings.artist-package/identity/
```

### Other tools

All tools work on the VPS with the same syntax as local. Note `--base-url` where applicable:

```bash
# Browse NOSTR events
./tools/nostr-browse.sh

# Browse IPFS content
./tools/ipfs-browse.sh

# Check drafts
./tools/check-drafts.sh

# Export artist
./tools/export-artist.sh --npub npub1...

# Reset node (wipes all data)
./tools/reset-node.sh --force
```

## VPS Directory Layout

```
/root/
├── Equaliser-1/                    ← Git clone of the repo
│   └── content_node/
│       ├── docker-compose.yml          ← Original (port 80)
│       └── docker-compose.override.yml ← VPS override (port 8080)
└── vps-config/                     ← Setup scripts + nginx configs
    ├── setup.sh
    ├── setup-ssl.sh
    └── nginx/sites-available/
        ├── equaliser.app
        └── shibuyacrossings.com
```

## Local File Structure

```
vps/Hetzner/CPX22/
├── README.md                       ← This file
├── login.txt                       ← SSH connection command
├── setup.sh                        ← Install nginx, certbot, firewall
├── setup-ssl.sh                    ← Obtain Let's Encrypt certificates
├── deploy.sh                       ← Push code + configs to VPS
├── docker-compose.override.yml     ← Port remap for VPS (80→8080)
├── nginx/
│   └── sites-available/
│       ├── equaliser.app           ← Reverse proxy to Docker
│       └── shibuyacrossings.com    ← Static site config
└── sites/
    └── shibuyacrossings.com/
        └── index.html              ← Placeholder band site
```

## Updating

```bash
# Push latest code + configs from local to VPS:
./vps/Hetzner/CPX22/deploy.sh

# Then on the VPS, restart the content node if needed:
ssh -i ~/.ssh/Hetzner_CPX22 root@77.42.68.194
cd /root/Equaliser-1/content_node && docker compose up -d --build

# To reload nginx configs only (no restart needed):
ssh -i ~/.ssh/Hetzner_CPX22 root@77.42.68.194 "nginx -t && systemctl reload nginx"
```

## Troubleshooting

```bash
# Check nginx status
systemctl status nginx

# Check nginx error log
tail -f /var/log/nginx/error.log

# Test nginx config
nginx -t

# Check certbot certificates
certbot certificates

# Check if Docker content node is running
docker ps

# Check firewall rules
ufw status
```
