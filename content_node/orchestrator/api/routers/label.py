"""
Label admin router.

Endpoints for label-tier roles to manage their artists, review access
requests, and generate invite codes. All endpoints require label or
operator role.
"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from dependencies import require_label, RoleContext
from services import relay_admin

router = APIRouter()


# ===== Artist management =====


class UpdateArtistRequest(BaseModel):
    status: Optional[str] = None       # 'active' | 'suspended'
    fee_model: Optional[str] = None    # 'free' | 'percentage' | 'flat_rate'
    fee_value: Optional[float] = None


@router.get("/artists")
async def list_managed_artists(ctx: RoleContext = Depends(require_label)):
    """
    List artists this label/operator can manage.

    Operators see all artists. Labels see artists where managed_by = their pubkey.
    """
    if ctx.role == "operator":
        artists = await relay_admin.list_artists()
    else:
        # Label sees managed artists. Optionally also show themselves.
        artists = await relay_admin.list_artists(managed_by=ctx.pubkey)
    return {"artists": artists, "count": len(artists)}


@router.get("/artists/{pubkey}")
async def get_managed_artist(pubkey: str, ctx: RoleContext = Depends(require_label)):
    """Get a single managed artist's details."""
    if not ctx.can_manage(pubkey):
        raise HTTPException(status_code=403, detail="Cannot manage this artist")

    artist = await relay_admin.get_artist(pubkey)
    if not artist:
        raise HTTPException(status_code=404, detail="Artist not found")
    return artist


@router.patch("/artists/{pubkey}")
async def update_managed_artist(
    pubkey: str,
    req: UpdateArtistRequest,
    ctx: RoleContext = Depends(require_label),
):
    """Update an artist's status, fee model, or fee value."""
    if not ctx.can_manage(pubkey):
        raise HTTPException(status_code=403, detail="Cannot manage this artist")

    return await relay_admin.update_artist(
        pubkey,
        status=req.status,
        fee_model=req.fee_model,
        fee_value=req.fee_value,
    )


# ===== Access requests =====


class DeclineRequest(BaseModel):
    admin_notes: Optional[str] = ""


class ApproveRequest(BaseModel):
    admin_notes: Optional[str] = ""


@router.get("/access-requests")
async def list_requests(
    status: Optional[str] = None,
    ctx: RoleContext = Depends(require_label),
):
    """List access requests. Optionally filter by status (pending/approved/declined)."""
    requests = await relay_admin.list_access_requests(status=status)
    return {"requests": requests, "count": len(requests)}


@router.get("/access-requests/{request_id}")
async def get_request(request_id: int, ctx: RoleContext = Depends(require_label)):
    """Get a single access request."""
    req = await relay_admin.get_access_request(request_id)
    if not req:
        raise HTTPException(status_code=404, detail="Access request not found")
    return req


@router.post("/access-requests/{request_id}/approve")
async def approve_request(
    request_id: int,
    body: ApproveRequest = ApproveRequest(),
    ctx: RoleContext = Depends(require_label),
):
    """Approve an access request and generate an invite code."""
    return await relay_admin.approve_access_request(
        request_id,
        admin_notes=body.admin_notes or "",
    )


@router.post("/access-requests/{request_id}/decline")
async def decline_request(
    request_id: int,
    body: DeclineRequest = DeclineRequest(),
    ctx: RoleContext = Depends(require_label),
):
    """Decline an access request."""
    return await relay_admin.decline_access_request(
        request_id,
        admin_notes=body.admin_notes or "",
    )


# ===== Invite codes =====


@router.get("/invite-codes")
async def list_invite_codes(ctx: RoleContext = Depends(require_label)):
    """List unused invite codes."""
    codes = await relay_admin.list_invite_codes()
    return {"codes": codes, "count": len(codes)}


@router.post("/invite-codes")
async def create_invite_code(ctx: RoleContext = Depends(require_label)):
    """Generate a standalone invite code (not tied to an access request)."""
    return await relay_admin.create_invite_code()
