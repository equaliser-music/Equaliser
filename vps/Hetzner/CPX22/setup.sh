#!/bin/bash
# ==============================================================================
# Equaliser VPS Setup Script
# Hetzner CPX22 - Ubuntu/Debian
#
# Installs and configures:
#   - nginx (host-level reverse proxy)
#   - certbot (Let's Encrypt SSL)
#   - ufw firewall
#   - site directories
#
# Prerequisites:
#   - Fresh Ubuntu 22.04/24.04 or Debian 12 server
#   - Docker and Docker Compose already installed
#   - DNS A records pointing to this server:
#       equaliser.app       → 77.42.68.194
#       www.equaliser.app   → 77.42.68.194
#       shibuyacrossings.com     → 77.42.68.194
#       www.shibuyacrossings.com → 77.42.68.194
#
# Usage:
#   scp this file to VPS then: sudo bash setup.sh
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[SETUP]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# --- Preflight checks --------------------------------------------------------

if [ "$EUID" -ne 0 ]; then
    err "Please run as root: sudo bash setup.sh"
fi

log "Starting VPS setup..."

# --- System updates -----------------------------------------------------------

log "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

# --- Install nginx ------------------------------------------------------------

log "Installing nginx..."
apt-get install -y -qq nginx

# Remove default site
rm -f /etc/nginx/sites-enabled/default

# --- Install certbot ----------------------------------------------------------

log "Installing certbot..."
apt-get install -y -qq certbot python3-certbot-nginx

# --- Firewall -----------------------------------------------------------------

log "Configuring firewall..."
apt-get install -y -qq ufw

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    comment 'SSH'
ufw allow 80/tcp    comment 'HTTP'
ufw allow 443/tcp   comment 'HTTPS'
ufw allow 4001/tcp  comment 'IPFS swarm'
ufw --force enable

log "Firewall rules:"
ufw status verbose

# --- Site directories ---------------------------------------------------------

log "Creating site directories..."

# Static band site
mkdir -p /var/www/shibuyacrossings.com/html
chown -R www-data:www-data /var/www/shibuyacrossings.com

# --- Install nginx site configs -----------------------------------------------

log "Installing nginx site configurations..."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Copy site configs
cp "$SCRIPT_DIR/nginx/sites-available/equaliser.app" /etc/nginx/sites-available/
cp "$SCRIPT_DIR/nginx/sites-available/shibuyacrossings.com" /etc/nginx/sites-available/

# Enable sites
ln -sf /etc/nginx/sites-available/equaliser.app /etc/nginx/sites-enabled/
ln -sf /etc/nginx/sites-available/shibuyacrossings.com /etc/nginx/sites-enabled/

# Test config
nginx -t || err "nginx config test failed"

# Reload
systemctl reload nginx
log "nginx configured and reloaded"

# --- Summary ------------------------------------------------------------------

echo ""
echo "=============================================="
echo -e "${GREEN}VPS setup complete!${NC}"
echo "=============================================="
echo ""
echo "Next steps:"
echo ""
echo "  1. Verify DNS records are propagated:"
echo "     dig equaliser.app"
echo "     dig shibuyacrossings.com"
echo ""
echo "  2. Run SSL setup (after DNS is propagated):"
echo "     sudo bash $(dirname "$0")/setup-ssl.sh"
echo ""
echo "  3. Start the Equaliser content node:"
echo "     cd /root/Equaliser-1/content_node"
echo "     docker compose up -d --build"
echo ""
echo "     (docker-compose.override.yml should already be in place"
echo "      from deploy.sh, remapping port 80 → 8080)"
echo ""
echo "=============================================="
