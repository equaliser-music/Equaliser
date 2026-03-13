#!/bin/bash
# ==============================================================================
# Reset VPS Content Nodes
#
# Wipes all data (volumes) and rebuilds containers on VPS nodes.
# Handles peer sync correctly: stops ALL nodes first, wipes, then starts.
# This prevents peer relays from re-syncing stale data during the wipe.
#
# Usage:
#   ./tools/reset-vps.sh              # Reset both VPS nodes (interactive)
#   ./tools/reset-vps.sh --force      # Skip confirmation
#   ./tools/reset-vps.sh cpx22        # Reset CPX22 only
#   ./tools/reset-vps.sh cx23         # Reset CX23 only
#   ./tools/reset-vps.sh --all        # Reset localhost + both VPS nodes
#   ./tools/reset-vps.sh --status     # Check status of all nodes
#   ./tools/reset-vps.sh -h           # Show help
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONTENT_NODE_DIR="$PROJECT_ROOT/content_node"

SSH_KEY="$HOME/.ssh/Hetzner_CPX22"
CPX22_HOST="root@77.42.68.194"
CX23_HOST="root@46.225.52.198"
VPS_REPO="/root/Equaliser-1"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[RESET]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

show_help() {
    echo "Usage: reset-vps.sh [OPTIONS] [TARGETS]"
    echo ""
    echo "Reset VPS content nodes to a fresh state."
    echo "Stops all targeted nodes first, then wipes volumes, then rebuilds."
    echo "This prevents peer relay sync from restoring stale data."
    echo ""
    echo "WARNING: This permanently deletes all data on targeted nodes!"
    echo ""
    echo "Targets:"
    echo "  (none)     Reset both VPS nodes (CPX22 + CX23)"
    echo "  cpx22      Reset CPX22 only (equaliser.app)"
    echo "  cx23       Reset CX23 only (46.225.52.198)"
    echo "  --all      Reset localhost + both VPS nodes"
    echo ""
    echo "Options:"
    echo "  --force    Skip confirmation prompt"
    echo "  --status   Show container status on all nodes"
    echo "  -h, --help Show this help"
}

# --- Check SSH key -----------------------------------------------------------

check_ssh() {
    if [ ! -f "$SSH_KEY" ]; then
        err "SSH key not found: $SSH_KEY"
    fi
}

# --- Remote helpers ----------------------------------------------------------

ssh_cmd() {
    local host="$1"
    shift
    ssh -i "$SSH_KEY" "$host" "$@"
}

stop_and_wipe() {
    local name="$1"
    local host="$2"
    local dir="$3"

    log "Stopping and wiping $name..."
    if [ "$host" = "local" ]; then
        (cd "$dir" && docker compose down -v)
    else
        ssh_cmd "$host" "cd $dir && docker compose down -v"
    fi
    log "$name stopped and wiped"
}

rebuild_and_start() {
    local name="$1"
    local host="$2"
    local dir="$3"

    log "Rebuilding and starting $name..."
    if [ "$host" = "local" ]; then
        (cd "$dir" && docker compose up -d --build)
    else
        ssh_cmd "$host" "cd $dir && docker compose up -d --build"
    fi
    log "$name started"
}

check_health() {
    local name="$1"
    local host="$2"
    local dir="$3"

    info "Checking $name..."
    if [ "$host" = "local" ]; then
        (cd "$dir" && docker compose ps --format 'table {{.Name}}\t{{.Status}}')
    else
        ssh_cmd "$host" "cd $dir && docker compose ps --format 'table {{.Name}}\t{{.Status}}'"
    fi
    echo ""
}

# --- Show status -------------------------------------------------------------

do_status() {
    check_ssh
    echo ""
    info "=== Localhost ==="
    (cd "$CONTENT_NODE_DIR" && docker compose ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null) || warn "Localhost: not running"
    echo ""
    info "=== CPX22 (equaliser.app) ==="
    ssh_cmd "$CPX22_HOST" "cd $VPS_REPO/content_node && docker compose ps --format 'table {{.Name}}\t{{.Status}}'" 2>/dev/null || warn "CPX22: not reachable"
    echo ""
    info "=== CX23 (46.225.52.198) ==="
    ssh_cmd "$CX23_HOST" "cd $VPS_REPO/content_node && docker compose ps --format 'table {{.Name}}\t{{.Status}}'" 2>/dev/null || warn "CX23: not reachable"
}

# --- Main --------------------------------------------------------------------

FORCE=false
TARGETS=()

for arg in "$@"; do
    case $arg in
        --force|-f)  FORCE=true ;;
        --status)    do_status; exit 0 ;;
        --all)       TARGETS=("local" "cpx22" "cx23") ;;
        cpx22)       TARGETS+=("cpx22") ;;
        cx23)        TARGETS+=("cx23") ;;
        -h|--help)   show_help; exit 0 ;;
        *)           err "Unknown option: $arg. Use --help for usage." ;;
    esac
done

# Default: both VPS nodes
if [ ${#TARGETS[@]} -eq 0 ]; then
    TARGETS=("cpx22" "cx23")
fi

check_ssh

# Build description of what we're resetting
target_desc=""
for t in "${TARGETS[@]}"; do
    case $t in
        local) target_desc+="  - Localhost ($CONTENT_NODE_DIR)\n" ;;
        cpx22) target_desc+="  - CPX22 (equaliser.app — $CPX22_HOST)\n" ;;
        cx23)  target_desc+="  - CX23 (46.225.52.198 — $CX23_HOST)\n" ;;
    esac
done

echo ""
echo -e "${RED}=========================================="
echo "  Equaliser Node Reset"
echo -e "==========================================${NC}"
echo ""
echo "This will permanently delete ALL data on:"
echo -e "$target_desc"
echo "Including: IPFS content, Blossom blobs, NOSTR events, drafts"
echo ""

if [ "$FORCE" = false ]; then
    read -p "Are you sure? [y/N] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 1
    fi
fi

echo ""

# Phase 1: Stop ALL targeted nodes first (prevents peer sync restoring data)
log "Phase 1: Stopping all targeted nodes..."
for t in "${TARGETS[@]}"; do
    case $t in
        local) stop_and_wipe "Localhost" "local" "$CONTENT_NODE_DIR" ;;
        cpx22) stop_and_wipe "CPX22" "$CPX22_HOST" "$VPS_REPO/content_node" ;;
        cx23)  stop_and_wipe "CX23" "$CX23_HOST" "$VPS_REPO/content_node" ;;
    esac
done

echo ""

# Phase 2: Pull latest code on VPS nodes
for t in "${TARGETS[@]}"; do
    case $t in
        cpx22)
            log "Pulling latest code on CPX22..."
            ssh_cmd "$CPX22_HOST" "cd $VPS_REPO && git pull"
            ;;
        cx23)
            log "Pulling latest code on CX23..."
            ssh_cmd "$CX23_HOST" "cd $VPS_REPO && git pull"
            ;;
    esac
done

echo ""

# Phase 3: Rebuild and start all nodes
log "Phase 2: Rebuilding and starting all nodes..."
for t in "${TARGETS[@]}"; do
    case $t in
        local) rebuild_and_start "Localhost" "local" "$CONTENT_NODE_DIR" ;;
        cpx22) rebuild_and_start "CPX22" "$CPX22_HOST" "$VPS_REPO/content_node" ;;
        cx23)  rebuild_and_start "CX23" "$CX23_HOST" "$VPS_REPO/content_node" ;;
    esac
done

echo ""

# Phase 4: Wait and verify
log "Waiting for services to start..."
sleep 10

log "Verifying health..."
echo ""
for t in "${TARGETS[@]}"; do
    case $t in
        local) check_health "Localhost" "local" "$CONTENT_NODE_DIR" ;;
        cpx22) check_health "CPX22" "$CPX22_HOST" "$VPS_REPO/content_node" ;;
        cx23)  check_health "CX23" "$CX23_HOST" "$VPS_REPO/content_node" ;;
    esac
done

echo -e "${GREEN}=========================================="
echo "  Reset Complete!"
echo -e "==========================================${NC}"
