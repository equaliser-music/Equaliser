#!/bin/bash
# ==============================================================================
# SSL Setup Script - Let's Encrypt via Certbot
#
# Run AFTER:
#   1. setup.sh has been run
#   2. DNS A records are propagated (verify with: dig equaliser.app)
#   3. nginx is running and serving both domains on port 80
#
# Usage:
#   sudo bash setup-ssl.sh
#   sudo bash setup-ssl.sh --email you@example.com
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[SSL]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

if [ "$EUID" -ne 0 ]; then
    err "Please run as root: sudo bash setup-ssl.sh"
fi

# --- Parse args ---------------------------------------------------------------

EMAIL=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --email) EMAIL="$2"; shift 2 ;;
        *) err "Unknown option: $1" ;;
    esac
done

if [ -z "$EMAIL" ]; then
    read -rp "Enter email for Let's Encrypt notifications: " EMAIL
fi

if [ -z "$EMAIL" ]; then
    err "Email is required for Let's Encrypt"
fi

# --- DNS checks ---------------------------------------------------------------

log "Checking DNS resolution..."

SERVER_IP=$(curl -s ifconfig.me)
log "Server IP: $SERVER_IP"

for domain in equaliser.app shibuyacrossings.com; do
    RESOLVED=$(dig +short "$domain" | head -1)
    if [ "$RESOLVED" != "$SERVER_IP" ]; then
        warn "$domain resolves to '$RESOLVED' (expected $SERVER_IP)"
        warn "DNS may not have propagated yet. Certbot may fail for this domain."
        read -rp "Continue anyway? [y/N] " confirm
        if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
            err "Aborted. Wait for DNS propagation and try again."
        fi
    else
        log "$domain → $RESOLVED ✓"
    fi
done

# --- Obtain certificates ------------------------------------------------------

log "Requesting SSL certificate for equaliser.app..."
certbot --nginx \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d equaliser.app \
    -d www.equaliser.app

log "Requesting SSL certificate for shibuyacrossings.com..."
certbot --nginx \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d shibuyacrossings.com \
    -d www.shibuyacrossings.com

# --- Verify auto-renewal ------------------------------------------------------

log "Testing certificate auto-renewal..."
certbot renew --dry-run

# --- Done ---------------------------------------------------------------------

echo ""
echo "=============================================="
echo -e "${GREEN}SSL setup complete!${NC}"
echo "=============================================="
echo ""
echo "Certificates installed:"
echo "  https://equaliser.app"
echo "  https://shibuyacrossings.com"
echo ""
echo "Auto-renewal is configured via certbot systemd timer."
echo "Test renewal anytime with: sudo certbot renew --dry-run"
echo "=============================================="
