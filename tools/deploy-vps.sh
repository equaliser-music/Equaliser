#!/bin/bash
# ==============================================================================
# Deploy to VPS
#
# Pushes committed code to the VPS and rebuilds the content node.
# Requires all changes to be committed and pushed to origin first.
#
# Usage:
#   ./tools/deploy-vps.sh              # Deploy: git pull + rebuild containers
#   ./tools/deploy-vps.sh --restart    # Just restart containers (no git pull)
#   ./tools/deploy-vps.sh --status     # Check VPS container status
#   ./tools/deploy-vps.sh -h           # Show help
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VPS_DEPLOY="$PROJECT_ROOT/vps/Hetzner/CPX22/deploy.sh"

SSH_KEY="$HOME/.ssh/Hetzner_CPX22"
VPS_HOST="root@77.42.68.194"
VPS_REPO="/root/Equaliser-1"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[VPS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

show_help() {
    echo "Usage: deploy-vps.sh [OPTION]"
    echo ""
    echo "Deploy local changes to the VPS content node."
    echo "Changes must be committed and pushed before deploying."
    echo ""
    echo "Options:"
    echo "  (none)       Full deploy: git pull on VPS + sync configs + rebuild containers"
    echo "  --restart    Restart containers on VPS without pulling code"
    echo "  --status     Show container status on VPS"
    echo "  -h, --help   Show this help"
}

# --- Pre-flight checks -------------------------------------------------------

preflight() {
    # Check SSH key exists
    if [ ! -f "$SSH_KEY" ]; then
        err "SSH key not found: $SSH_KEY"
    fi

    # Check we're in the repo
    if [ ! -d "$PROJECT_ROOT/.git" ]; then
        err "Not in a git repository"
    fi

    # Check for uncommitted changes
    cd "$PROJECT_ROOT"
    if [ -n "$(git status --porcelain)" ]; then
        echo ""
        warn "You have uncommitted changes:"
        git status --short
        echo ""
        err "Commit and push your changes before deploying to VPS."
    fi

    # Check local branch is pushed to origin
    LOCAL_SHA=$(git rev-parse HEAD)
    BRANCH=$(git branch --show-current)
    REMOTE_SHA=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "")

    if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
        warn "Local commits have not been pushed to origin/$BRANCH"
        err "Push your changes first: git push origin $BRANCH"
    fi

    log "Pre-flight checks passed"
    info "Branch: $BRANCH"
    info "Commit: $(git log --oneline -1)"
}

# --- Commands -----------------------------------------------------------------

do_deploy() {
    preflight

    echo ""
    log "Deploying to VPS..."

    # Step 1: Run the existing deploy script (git pull + configs)
    log "Pulling latest code on VPS..."
    bash "$VPS_DEPLOY"

    # Step 2: Rebuild and restart containers
    log "Rebuilding and restarting containers on VPS..."
    ssh -i "$SSH_KEY" "$VPS_HOST" "cd $VPS_REPO/content_node && docker compose up -d --build"

    echo ""
    log "Deploy complete!"
    info "Waiting for containers to start..."
    sleep 5

    # Show status
    do_status
}

do_restart() {
    if [ ! -f "$SSH_KEY" ]; then
        err "SSH key not found: $SSH_KEY"
    fi

    log "Restarting containers on VPS..."
    ssh -i "$SSH_KEY" "$VPS_HOST" "cd $VPS_REPO/content_node && docker compose up -d --build"

    echo ""
    log "Restart complete!"
    sleep 5
    do_status
}

do_status() {
    if [ ! -f "$SSH_KEY" ]; then
        err "SSH key not found: $SSH_KEY"
    fi

    log "VPS container status:"
    echo ""
    ssh -i "$SSH_KEY" "$VPS_HOST" "cd $VPS_REPO/content_node && docker compose ps"
}

# --- Main ---------------------------------------------------------------------

case "${1:-}" in
    --restart)
        do_restart
        ;;
    --status)
        do_status
        ;;
    -h|--help)
        show_help
        ;;
    "")
        do_deploy
        ;;
    *)
        err "Unknown option: $1. Use --help for usage."
        ;;
esac
