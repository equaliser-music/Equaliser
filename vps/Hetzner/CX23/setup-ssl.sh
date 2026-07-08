#!/bin/bash
# ==============================================================================
# SSL Setup Script - Let's Encrypt via Certbot
#
# Run AFTER:
#   1. setup.sh has been run
#   2. A domain has been configured and DNS A records are propagated
#   3. nginx site config has been updated with the domain name
#
# Usage:
#   sudo bash setup-ssl.sh --domain example.com
#   sudo bash setup-ssl.sh --domain example.com --email you@example.com
#   sudo bash setup-ssl.sh --domain relay2.equaliser.app --no-www   # single-host cert
#
# --no-www skips the www.<domain> SAN — required for service subdomains like
# relay2.equaliser.app that have no www DNS record. Without a cert installed
# for its vhost, nginx serves the default (test2) cert and TLS-verifying
# clients (e.g. the relay's standard-relay syncer) refuse to connect.
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

DOMAIN=""
EMAIL=""
WITH_WWW=1
while [[ $# -gt 0 ]]; do
    case $1 in
        --domain) DOMAIN="$2"; shift 2 ;;
        --email) EMAIL="$2"; shift 2 ;;
        --no-www) WITH_WWW=0; shift ;;
        *) err "Unknown option: $1. Usage: setup-ssl.sh --domain example.com [--email you@example.com] [--no-www]" ;;
    esac
done

if [ -z "$DOMAIN" ]; then
    read -rp "Enter domain (e.g. example.com): " DOMAIN
fi

if [ -z "$DOMAIN" ]; then
    err "Domain is required"
fi

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

SUBDOMAINS=("")
[ "$WITH_WWW" -eq 1 ] && SUBDOMAINS+=("www.")

for subdomain in "${SUBDOMAINS[@]}"; do
    fqdn="${subdomain}${DOMAIN}"
    RESOLVED=$(dig +short "$fqdn" | head -1)
    if [ "$RESOLVED" != "$SERVER_IP" ]; then
        warn "$fqdn resolves to '$RESOLVED' (expected $SERVER_IP)"
        warn "DNS may not have propagated yet. Certbot may fail for this domain."
        read -rp "Continue anyway? [y/N] " confirm
        if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
            err "Aborted. Wait for DNS propagation and try again."
        fi
    else
        log "$fqdn -> $RESOLVED OK"
    fi
done

# --- Update nginx config with domain -----------------------------------------

NGINX_CONF="/etc/nginx/sites-available/equaliser"
if [ -f "$NGINX_CONF" ] && grep -q "server_name _;" "$NGINX_CONF"; then
    if [ "$WITH_WWW" -eq 1 ]; then
        log "Updating nginx config with domain: $DOMAIN"
        sed -i "s/server_name _;/server_name ${DOMAIN} www.${DOMAIN};/" "$NGINX_CONF"
    else
        log "Updating nginx config with domain: $DOMAIN (no www)"
        sed -i "s/server_name _;/server_name ${DOMAIN};/" "$NGINX_CONF"
    fi
    nginx -t || err "nginx config test failed after domain update"
    systemctl reload nginx
elif [ ! -f "$NGINX_CONF" ] && [ "$WITH_WWW" -eq 1 ]; then
    err "nginx config not found at $NGINX_CONF. Run setup.sh first."
else
    # Service subdomains (e.g. relay2) ship their own vhost with server_name
    # already set — nothing to substitute here.
    log "Skipping server_name substitution (vhost already configured)"
fi

# --- Obtain certificate -------------------------------------------------------

CERT_DOMAINS=(-d "$DOMAIN")
[ "$WITH_WWW" -eq 1 ] && CERT_DOMAINS+=(-d "www.$DOMAIN")

log "Requesting SSL certificate for $DOMAIN..."
certbot --nginx \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    "${CERT_DOMAINS[@]}"

# --- Verify auto-renewal ------------------------------------------------------

log "Testing certificate auto-renewal..."
certbot renew --dry-run

# --- Done ---------------------------------------------------------------------

echo ""
echo "=============================================="
echo -e "${GREEN}SSL setup complete!${NC}"
echo "=============================================="
echo ""
echo "Certificate installed:"
echo "  https://$DOMAIN"
echo ""
echo "Auto-renewal is configured via certbot systemd timer."
echo "Test renewal anytime with: sudo certbot renew --dry-run"
echo "=============================================="
