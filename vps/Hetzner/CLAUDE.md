# Hetzner VPS Deployment

Each VPS has its own folder containing a `deploy.sh` script and node-specific configs (nginx, docker-compose override, SSL setup).

| Folder | VPS | Deploy |
|--------|-----|--------|
| `CPX22/` | CPX22 (equaliser.app) | `./vps/Hetzner/CPX22/deploy.sh` |
| `CX23/` | CX23 (46.225.52.198) | `./vps/Hetzner/CX23/deploy.sh` |

Both scripts share the same SSH key (`~/.ssh/Hetzner_CPX22`). Run from the repo root.

Usage:
- `./vps/Hetzner/<node>/deploy.sh` — git pull + sync configs
- `./vps/Hetzner/<node>/deploy.sh --init` — first-time clone + setup
- After deploy, SSH in and rebuild containers: `cd /root/Equaliser-1/content_node && docker compose up -d --build`
