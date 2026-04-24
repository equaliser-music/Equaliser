"""
Operator admin router.

Endpoints for node operators to view infrastructure status:
node overview, registered users, sync state. All endpoints require
operator role (or X-Admin-Token matching ADMIN_PASSWORD).
"""

import os
from fastapi import APIRouter, Depends

from dependencies import require_operator, RoleContext
from services import relay_admin

router = APIRouter()

NODE_NAME = os.getenv("RELAY_NAME", "Equaliser Node")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "")


@router.get("/overview")
async def overview(ctx: RoleContext = Depends(require_operator)):
    """
    Return a high-level overview of the node: stats, name, public URL.

    Used by the operator dashboard home page.
    """
    stats = await relay_admin.node_stats()
    return {
        "node_name": NODE_NAME,
        "public_base_url": PUBLIC_BASE_URL,
        "stats": stats,
    }


@router.get("/registered-users")
async def list_users(
    limit: int = 50,
    offset: int = 0,
    ctx: RoleContext = Depends(require_operator),
):
    """List registered listener pubkeys with pagination."""
    return await relay_admin.list_registered_users(limit=limit, offset=offset)


@router.get("/sync/status")
async def sync_status(ctx: RoleContext = Depends(require_operator)):
    """
    Return peer relay sync status.

    Currently a stub — full sync status will read from peer_relays table
    in a future iteration.
    """
    return {
        "status": "ok",
        "note": "Sync status detail not yet implemented — see peer_relays table",
    }
