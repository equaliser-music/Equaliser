#!/bin/bash
# ==============================================================================
# Deploy to VPS
#
# Pushes code and configs to the Hetzner CX23 VPS.
# Run this from your local machine (from the repo root).
#
# First run:  ./vps/Hetzner/CX23/deploy.sh --init
# Updates:    ./vps/Hetzner/CX23/deploy.sh
#
# Usage:
#   ./vps/Hetzner/CX23/deploy.sh --init     # First-time: clone repo + deploy configs
#   ./vps/Hetzner/CX23/deploy.sh            # Update: git pull + redeploy configs
#   ./vps/Hetzner/CX23/deploy.sh --setup    # Deploy and run setup.sh
#   ./vps/Hetzner/CX23/deploy.sh --ssl      # Deploy and run setup-ssl.sh
# ==============================================================================

set -euo pipefail

SSH_KEY="$HOME/.ssh/Hetzner_CPX22"
VPS_HOST="root@46.225.52.198"
VPS_CONFIG="/root/vps-config"
VPS_REPO="/root/Equaliser-1"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Check SSH key
if [ ! -f "$SSH_KEY" ]; then
    err "SSH key not found: $SSH_KEY"
fi

# --- Helper: deploy VPS configs -----------------------------------------------

deploy_configs() {
    log "Creating config directory on VPS..."
    ssh -i "$SSH_KEY" "$VPS_HOST" "mkdir -p $VPS_CONFIG/nginx/sites-available"

    log "Copying setup scripts..."
    scp -i "$SSH_KEY" \
        "$SCRIPT_DIR/setup.sh" \
        "$SCRIPT_DIR/setup-ssl.sh" \
        "$VPS_HOST:$VPS_CONFIG/"

    log "Copying nginx configs..."
    scp -i "$SSH_KEY" \
        "$SCRIPT_DIR/nginx/sites-available/equaliser" \
        "$VPS_HOST:$VPS_CONFIG/nginx/sites-available/"

    log "Copying docker-compose override into content_node..."
    scp -i "$SSH_KEY" \
        "$SCRIPT_DIR/docker-compose.override.yml" \
        "$VPS_HOST:$VPS_REPO/content_node/"
}

# --- Commands -----------------------------------------------------------------

case "${1:-}" in
    --init)
        # First-time setup: clone repo onto VPS
        log "First-time setup: cloning repo on VPS..."

        # Convert HTTPS URL to SSH for deploy key auth on VPS
        REMOTE_URL=$(cd "$REPO_ROOT" && git remote get-url origin 2>/dev/null || echo "")
        if [ -z "$REMOTE_URL" ]; then
            err "Could not determine git remote URL. Run from inside the repo."
        fi
        # https://github.com/User/Repo.git -> git@github.com:User/Repo.git
        REMOTE_URL=$(echo "$REMOTE_URL" | sed 's|https://github.com/|git@github.com:|')

        log "Remote: $REMOTE_URL"
        BRANCH=$(cd "$REPO_ROOT" && git branch --show-current)
        log "Branch: $BRANCH"

        ssh -i "$SSH_KEY" "$VPS_HOST" bash -s <<INIT
            set -e
            if [ -d "$VPS_REPO" ]; then
                echo "Repo already exists at $VPS_REPO, pulling latest..."
                cd "$VPS_REPO" && git pull
            else
                git clone -b "$BRANCH" "$REMOTE_URL" "$VPS_REPO"
            fi
INIT

        deploy_configs
        log "Init complete!"
        echo ""
        echo "Next steps on the VPS:"
        echo "  ssh -i $SSH_KEY $VPS_HOST"
        echo "  cd $VPS_CONFIG && sudo bash setup.sh"
        ;;

    --setup)
        deploy_configs
        log "Running setup.sh on VPS..."
        ssh -i "$SSH_KEY" "$VPS_HOST" "cd $VPS_CONFIG && bash setup.sh"
        ;;

    --ssl)
        deploy_configs
        log "Running setup-ssl.sh on VPS..."
        ssh -i "$SSH_KEY" "$VPS_HOST" "cd $VPS_CONFIG && bash setup-ssl.sh"
        ;;

    "")
        # Default: pull latest code + redeploy configs
        log "Updating repo on VPS..."
        ssh -i "$SSH_KEY" "$VPS_HOST" "cd $VPS_REPO && git pull"

        deploy_configs
        log "Update complete!"
        echo ""
        echo "To restart the content node:"
        echo "  ssh -i $SSH_KEY $VPS_HOST"
        echo "  cd $VPS_REPO/content_node && docker compose up -d --build"
        ;;

    -h|--help)
        echo "Usage: deploy.sh [OPTION]"
        echo ""
        echo "Options:"
        echo "  --init     First-time setup: clone repo + deploy configs"
        echo "  (none)     Update: git pull + redeploy configs"
        echo "  --setup    Deploy configs and run setup.sh (nginx, certbot, firewall)"
        echo "  --ssl      Deploy configs and run setup-ssl.sh (requires --domain)"
        echo "  -h,--help  Show this help"
        ;;

    *)
        err "Unknown option: $1. Use --help for usage."
        ;;
esac
