"""
Delegation lifecycle router (Phase F: NIP-26 label delegation).

The flow:
  1. Label calls POST /request with target artist + kinds + duration → server creates
     a `delegation_requests` row.
  2. Artist calls GET /incoming → sees pending requests aimed at them.
  3. Artist calls POST /{id}/grant with a NIP-26-signed condition string + signature →
     server inserts/updates `artist_delegations`.
  4. Label calls GET /active → fetches their granted delegations to use when publishing.
  5. Either side can revoke via POST /{artist_pubkey}/revoke.

All endpoints require NIP-98 auth. The orchestrator enforces that
  - labels can only request delegations for artists they manage (`ctx.can_manage`)
  - only the artist on a request can grant or decline it (granter_pubkey == ctx.pubkey)
  - only the artist can revoke their own delegations
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from dependencies import require_auth, require_label_strict, require_role, RoleContext
from services import relay_admin

logger = logging.getLogger(__name__)
router = APIRouter()


# ===== Label initiates =====


class RequestDelegationBody(BaseModel):
    artist_pubkey: str
    requested_kinds: Optional[str] = "30050,5"
    duration_days: Optional[int] = 365
    note: Optional[str] = ""


@router.post("/request")
async def create_request(
    body: RequestDelegationBody,
    ctx: RoleContext = Depends(require_label_strict),
):
    """Label asks an artist for permission to publish on their behalf."""
    if not ctx.can_manage(body.artist_pubkey):
        raise HTTPException(status_code=403, detail="Cannot request delegation from an artist you don't manage")
    if body.artist_pubkey == ctx.pubkey:
        raise HTTPException(status_code=400, detail="Cannot delegate to yourself")
    return await relay_admin.request_delegation(
        label_pubkey=ctx.pubkey,
        artist_pubkey=body.artist_pubkey,
        requested_kinds=body.requested_kinds or "30050,5",
        duration_days=body.duration_days or 365,
        note=body.note or "",
    )


# ===== Artist views + responds =====


@router.get("/incoming")
async def list_incoming(
    status: Optional[str] = "pending",
    pubkey: str = Depends(require_auth),
):
    """List delegation requests where the caller is the recipient (artist)."""
    requests = await relay_admin.list_delegation_requests_for_artist(
        artist_pubkey=pubkey, status=status,
    )
    return {"requests": requests, "count": len(requests)}


@router.get("/outgoing")
async def list_outgoing(
    status: Optional[str] = None,
    ctx: RoleContext = Depends(require_label_strict),
):
    """List delegation requests the caller (label) has issued."""
    requests = await relay_admin.list_delegation_requests_for_label(
        label_pubkey=ctx.pubkey, status=status,
    )
    return {"requests": requests, "count": len(requests)}


class GrantBody(BaseModel):
    conditions: str
    signature: str


@router.post("/{request_id}/grant")
async def grant(
    request_id: int,
    body: GrantBody,
    pubkey: str = Depends(require_auth),
):
    """
    Artist grants a delegation request. The conditions string + signature are the
    NIP-26 delegation token signed by the artist's nsec client-side.
    """
    if not body.conditions or not body.signature:
        raise HTTPException(status_code=400, detail="conditions and signature required")
    return await relay_admin.grant_delegation(
        request_id=request_id,
        conditions=body.conditions,
        signature=body.signature,
        granter_pubkey=pubkey,
    )


@router.post("/{request_id}/decline")
async def decline(
    request_id: int,
    pubkey: str = Depends(require_auth),
):
    return await relay_admin.decline_delegation_request(
        request_id=request_id, granter_pubkey=pubkey,
    )


# ===== Active delegations + revocation =====


@router.get("/active")
async def list_active(ctx: RoleContext = Depends(require_label_strict)):
    """List the caller (label) 's active delegations — used when constructing publishable events."""
    delegations = await relay_admin.list_active_delegations_for_label(ctx.pubkey)
    return {"delegations": delegations, "count": len(delegations)}


@router.get("/active/{artist_pubkey}")
async def get_for_artist(
    artist_pubkey: str,
    ctx: RoleContext = Depends(require_label_strict),
):
    """Get the caller's active delegation for a specific artist (or 404)."""
    if not ctx.can_manage(artist_pubkey):
        raise HTTPException(status_code=403, detail="Cannot manage this artist")
    d = await relay_admin.get_active_delegation(artist_pubkey, ctx.pubkey)
    if d is None:
        raise HTTPException(status_code=404, detail="No active delegation")
    return d


@router.post("/{artist_pubkey}/revoke")
async def revoke(
    artist_pubkey: str,
    label_pubkey: str,
    pubkey: str = Depends(require_auth),
):
    """Artist revokes a delegation they previously granted."""
    if pubkey != artist_pubkey:
        raise HTTPException(status_code=403, detail="Only the artist can revoke")
    return await relay_admin.revoke_delegation(artist_pubkey, label_pubkey)
