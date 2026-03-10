# Hetzner CX23 VPS Setup

Server: `46.225.52.198`

## Architecture

```
Internet (80)
    |
    v
Host nginx (reverse proxy)
    |
    +-- * --> Docker content node (localhost:8080)
                |-- nginx (routing)
                |-- orchestrator (FastAPI)
                |-- IPFS (kubo)
                +-- NOSTR relay
```

No domain configured yet. The node is accessible at `http://46.225.52.198`.

When a domain is added, update the nginx config and run `setup-ssl.sh`.

### How the port override works

The content node's `docker-compose.yml` uses port `80:80` for local dev. On the VPS, a `docker-compose.override.yml` is placed alongside it which remaps to `8080:80`, freeing ports 80/443 for the host nginx. Docker Compose auto-merges the override when present.

## Setup Steps

### 1. Set up GitHub deploy key on VPS

The repo is private, so the VPS needs a read-only deploy key to clone it.

**On the VPS:**
```bash
ssh -i ~/.ssh/Hetzner_CPX22 root@46.225.52.198

# Generate deploy key
ssh-keygen -t ed25519 -C "equaliser-cx23-deploy" -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub
```

Copy the public key output.

**On GitHub:**
- Go to repo > **Settings** > **Deploy keys** > **Add deploy key**
- Title: `Hetzner CX23`
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

### 2. First-time deploy to VPS

From your local machine:
```bash
./vps/Hetzner/CX23/deploy.sh --init
```

This clones the repo (via SSH) to `/root/Equaliser-1` on the VPS and copies all configs (nginx site, docker-compose override).

### 3. SSH into VPS and run setup

```bash
ssh -i ~/.ssh/Hetzner_CPX22 root@46.225.52.198
cd /root/vps-config
sudo bash setup.sh
```

This installs:
- Docker and Docker Compose
- nginx (host-level reverse proxy)
- certbot (Let's Encrypt SSL — ready for when a domain is added)
- ufw firewall (ports 22, 80, 443, 4001)
- jq, python3, python3-venv
- Python venv at `/root/Equaliser-1/.venv` with `coincurve` and `websocket-client`

### 4. Start the content node

```bash
cd /root/Equaliser-1/content_node
docker compose up -d --build
```

The override file is already in place, so Docker will use port 8080 automatically.

### 5. (Later) Add a domain and SSL

When you have a domain:

1. Add DNS A records pointing to `46.225.52.198`
2. Run SSL setup:
   ```bash
   sudo bash setup-ssl.sh --domain example.com --email you@example.com
   ```
   This automatically updates the nginx config and obtains a Let's Encrypt certificate.

## VPS Directory Layout

```
/root/
|-- Equaliser-1/                    <- Git clone of the repo
|   +-- content_node/
|       |-- docker-compose.yml          <- Original (port 80)
|       +-- docker-compose.override.yml <- VPS override (port 8080)
+-- vps-config/                     <- Setup scripts + nginx configs
    |-- setup.sh
    |-- setup-ssl.sh
    +-- nginx/sites-available/
        +-- equaliser
```

## Local File Structure

```
vps/Hetzner/CX23/
|-- README.md                       <- This file
|-- login.txt                       <- SSH connection command
|-- setup.sh                        <- Install nginx, certbot, firewall
|-- setup-ssl.sh                    <- Obtain Let's Encrypt certificate (parameterised)
|-- deploy.sh                       <- Push code + configs to VPS
|-- docker-compose.override.yml     <- Port remap for VPS (80->8080)
+-- nginx/
    +-- sites-available/
        +-- equaliser               <- Reverse proxy to Docker
```

## Updating

```bash
# Push latest code + configs from local to VPS:
./vps/Hetzner/CX23/deploy.sh

# Then on the VPS, restart the content node if needed:
ssh -i ~/.ssh/Hetzner_CPX22 root@46.225.52.198
cd /root/Equaliser-1/content_node && docker compose up -d --build

# To reload nginx configs only (no restart needed):
ssh -i ~/.ssh/Hetzner_CPX22 root@46.225.52.198 "nginx -t && systemctl reload nginx"
```

## Troubleshooting

```bash
# Check nginx status
systemctl status nginx

# Check nginx error log
tail -f /var/log/nginx/error.log

# Test nginx config
nginx -t

# Check if Docker content node is running
docker ps

# Check firewall rules
ufw status
```
