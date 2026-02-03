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

This installs nginx, certbot, ufw firewall, and configures site vhosts.

### 5. Set up SSL certificates

Only run after DNS has propagated:
```bash
sudo bash setup-ssl.sh --email your@email.com
```

### 6. Start the content node

```bash
cd /root/Equaliser-1/content_node
docker compose up -d --build
```

The override file is already in place (deployed in step 2), so Docker will use port 8080 automatically.

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
