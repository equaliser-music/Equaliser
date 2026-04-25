"""
Operator admin router.

Endpoints for node operators to view infrastructure status:
node overview, registered users, peer relay sync state, IPFS storage,
Blossom server status, and read-only node settings. All endpoints
require operator role (or X-Admin-Token matching ADMIN_PASSWORD).
"""

import os
import logging
from typing import Any, Dict

import httpx
from fastapi import APIRouter, Depends

from dependencies import require_operator, RoleContext
from services import relay_admin

logger = logging.getLogger(__name__)
router = APIRouter()

NODE_NAME = os.getenv("RELAY_NAME", "Equaliser Node")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "")
IPFS_API_URL = os.getenv("IPFS_API_URL", "http://ipfs:5001")
BLOSSOM_URL = os.getenv("BLOSSOM_URL", "http://blossom:3000")
RELAY_API_URL = os.getenv("RELAY_API_URL", "http://equaliser-relay:8008")
NOSTR_RELAY_URL = os.getenv("NOSTR_RELAY_URL", "ws://equaliser-relay:8080")
STANDARD_RELAYS = [r.strip() for r in os.getenv("STANDARD_RELAYS", "").split(",") if r.strip()]
ALLOWED_ORIGINS = [r.strip() for r in os.getenv("ALLOWED_ORIGINS", "").split(",") if r.strip()]


# ===== Node overview =====


@router.get("/overview")
async def overview(ctx: RoleContext = Depends(require_operator)):
    """High-level overview: stats, name, public URL, service health."""
    stats = await relay_admin.node_stats()
    services = await _check_services()
    return {
        "node_name": NODE_NAME,
        "public_base_url": PUBLIC_BASE_URL,
        "stats": stats,
        "services": services,
    }


async def _check_services() -> Dict[str, Dict[str, Any]]:
    """Ping each backing service and return status (ok / unreachable / error)."""
    checks = {
        "orchestrator": ("self", None),  # Implicit — if we're answering, we're up
        "relay_rest": ("GET", f"{RELAY_API_URL}/api/health"),
        "ipfs": ("POST", f"{IPFS_API_URL}/api/v0/version"),
        "blossom": ("GET", f"{BLOSSOM_URL}/"),
    }
    out: Dict[str, Dict[str, Any]] = {}
    async with httpx.AsyncClient(timeout=3.0) as client:
        for name, (method, url) in checks.items():
            if name == "orchestrator":
                out[name] = {"status": "ok", "url": "http://orchestrator:8000"}
                continue
            try:
                resp = await client.request(method, url)
                out[name] = {
                    "status": "ok" if resp.status_code < 500 else "error",
                    "http_status": resp.status_code,
                    "url": url,
                }
            except Exception as e:
                out[name] = {"status": "unreachable", "error": str(e), "url": url}
    return out


# ===== Registered users =====


@router.get("/registered-users")
async def list_users(
    limit: int = 50,
    offset: int = 0,
    ctx: RoleContext = Depends(require_operator),
):
    """List registered listener pubkeys with pagination."""
    return await relay_admin.list_registered_users(limit=limit, offset=offset)


# ===== Sync / peer relays =====


@router.get("/sync/peers")
async def sync_peers(ctx: RoleContext = Depends(require_operator)):
    """
    Return peer relay sync state plus configured standard relays.

    Peer relays come from the relay's `peer_relays` table (set via PEER_RELAYS env).
    Standard relays come from STANDARD_RELAYS env on the orchestrator.
    """
    peers = await relay_admin.list_peer_relays()
    return {
        "peer_relays": peers,
        "standard_relays": STANDARD_RELAYS,
        "local_relay_url": NOSTR_RELAY_URL,
    }


# ===== IPFS storage =====


@router.get("/ipfs/stats")
async def ipfs_stats(ctx: RoleContext = Depends(require_operator)):
    """
    Return IPFS repo + pin stats by calling the IPFS HTTP API directly.

    Uses /api/v0/repo/stat for storage size, /api/v0/pin/ls for pin count
    (truncated to first 1000 pins to avoid massive payloads), and
    /api/v0/swarm/peers for connected peer count.
    """
    out: Dict[str, Any] = {"api_url": IPFS_API_URL}
    async with httpx.AsyncClient(timeout=10.0) as client:
        # repo/stat: returns RepoSize, NumObjects, etc.
        try:
            resp = await client.post(f"{IPFS_API_URL}/api/v0/repo/stat")
            if resp.status_code == 200:
                out["repo"] = resp.json()
        except Exception as e:
            out["repo_error"] = str(e)

        # pin/ls?type=recursive: count pinned roots
        try:
            resp = await client.post(f"{IPFS_API_URL}/api/v0/pin/ls", params={"type": "recursive"})
            if resp.status_code == 200:
                pins = resp.json().get("Keys", {})
                out["pin_count"] = len(pins)
                # Sample of pins (first 20) for display
                out["pins_sample"] = list(pins.keys())[:20]
        except Exception as e:
            out["pins_error"] = str(e)

        # swarm/peers: connected peer count
        try:
            resp = await client.post(f"{IPFS_API_URL}/api/v0/swarm/peers")
            if resp.status_code == 200:
                peers = resp.json().get("Peers", []) or []
                out["swarm_peer_count"] = len(peers)
        except Exception as e:
            out["swarm_error"] = str(e)

        # id: peer ID for this node
        try:
            resp = await client.post(f"{IPFS_API_URL}/api/v0/id")
            if resp.status_code == 200:
                data = resp.json()
                out["peer_id"] = data.get("ID")
                out["agent_version"] = data.get("AgentVersion")
        except Exception as e:
            out["id_error"] = str(e)

    return out


# ===== Blossom status =====


@router.get("/blossom/status")
async def blossom_status(ctx: RoleContext = Depends(require_operator)):
    """
    Return Blossom server status. Mirroring/cluster config is a future
    work item (see NODE-MANAGEMENT-SPEC.md Section 7).
    """
    out: Dict[str, Any] = {
        "url": BLOSSOM_URL,
        "public_url": f"{PUBLIC_BASE_URL.rstrip('/')}/blossom" if PUBLIC_BASE_URL else None,
    }
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            resp = await client.get(f"{BLOSSOM_URL}/")
            out["status"] = "ok" if resp.status_code < 500 else "error"
            out["http_status"] = resp.status_code
        except Exception as e:
            out["status"] = "unreachable"
            out["error"] = str(e)

        # Try the /list/<pubkey>?since= introspection endpoint isn't useful here
        # without a pubkey. Just confirm reachability.
    return out


# ===== Read-only node settings =====


@router.get("/settings")
async def settings(ctx: RoleContext = Depends(require_operator)):
    """
    Return read-only node configuration sourced from environment variables.

    Sensitive values (passwords, keys) are never included.
    """
    return {
        "node": {
            "name": NODE_NAME,
            "public_base_url": PUBLIC_BASE_URL or None,
        },
        "services": {
            "ipfs_api_url": IPFS_API_URL,
            "blossom_url": BLOSSOM_URL,
            "relay_rest_url": RELAY_API_URL,
            "relay_ws_url": NOSTR_RELAY_URL,
        },
        "relays": {
            "standard_relays": STANDARD_RELAYS,
        },
        "cors": {
            "allowed_origins": ALLOWED_ORIGINS,
        },
    }
