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
    status: Optional[str] = None              # 'active' | 'suspended'
    fee_model: Optional[str] = None           # 'free' | 'percentage' | 'flat_rate'
    fee_value: Optional[float] = None
    # Phase G — recording-rights model
    relationship_type: Optional[str] = None   # 'self' | 'managed' | 'signed'
    # Phase G — operators can transfer an artist between labels by PATCH-ing managed_by.
    # Empty string clears (sets to NULL); None leaves the field alone.
    managed_by: Optional[str] = None


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
    """Update an artist's status, fee model, fee value, relationship type, or managed_by.

    - status / fee_* / relationship_type: label or operator.
    - managed_by transfer (Phase G — Magic→Sony etc.): operator-only. Setting "" clears
      the field (artist becomes self / unmanaged).
    """
    if not ctx.can_manage(pubkey):
        raise HTTPException(status_code=403, detail="Cannot manage this artist")

    if req.relationship_type is not None and req.relationship_type not in ("self", "managed", "signed"):
        raise HTTPException(status_code=400, detail="relationship_type must be 'self', 'managed', or 'signed'")

    if req.managed_by is not None and ctx.role != "operator":
        raise HTTPException(status_code=403, detail="Only operators can transfer artists between labels")

    return await relay_admin.update_artist(
        pubkey,
        status=req.status,
        fee_model=req.fee_model,
        fee_value=req.fee_value,
        relationship_type=req.relationship_type,
        managed_by=req.managed_by,
    )


# ===== Access requests =====


class DeclineRequest(BaseModel):
    admin_notes: Optional[str] = ""


class ApproveRequest(BaseModel):
    admin_notes: Optional[str] = ""
    target_role: Optional[str] = None        # 'artist' | 'label' | 'operator' (default: requested_role)
    target_managed_by: Optional[str] = None  # pubkey of label whose roster the artist joins (None = unmanaged)
    # Phase G — recording-rights model on the resulting node_artists row.
    target_relationship_type: Optional[str] = None  # 'self' | 'managed' | 'signed'


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
    """
    Approve an access request and generate an invite code.

    target_role defaults to the request's requested_role (set on /join). The approver
    can override it (e.g. label applies but operator promotes them to label only if
    operator approves). Non-operator callers can only issue label/operator codes if
    they are themselves operator.
    """
    # Pull request to determine default target_role + validate caller permissions
    existing = await relay_admin.get_access_request(request_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Access request not found")

    target_role = body.target_role or existing.get("requested_role") or "artist"
    if target_role not in ("artist", "label", "operator"):
        raise HTTPException(status_code=400, detail="target_role must be artist, label, or operator")
    if target_role in ("label", "operator") and ctx.role != "operator":
        raise HTTPException(status_code=403, detail="Only operators can issue label or operator invites")

    # Operator codes never carry target_managed_by
    target_managed_by = body.target_managed_by
    if target_role == "operator":
        target_managed_by = None
    # Labels can only point target_managed_by to themselves
    if target_role == "artist" and target_managed_by and ctx.role != "operator":
        if target_managed_by != ctx.pubkey:
            raise HTTPException(status_code=403, detail="Labels can only assign artists to their own roster")

    # Phase G: pick a sensible relationship_type default if the approver didn't specify
    target_rel = body.target_relationship_type or existing.get("target_relationship_type") or "managed"
    if target_rel not in ("self", "managed", "signed"):
        raise HTTPException(status_code=400, detail="target_relationship_type must be 'self', 'managed', or 'signed'")
    # Operator codes have no label relationship; labels with no managed_by are 'self'
    if target_role == "operator":
        target_rel = "self"
    if target_role == "label" and not target_managed_by:
        target_rel = "self"
    # 'signed' / 'managed' only make sense when there's a managed_by
    if target_rel in ("managed", "signed") and not target_managed_by:
        target_rel = "self"

    return await relay_admin.approve_access_request(
        request_id,
        admin_notes=body.admin_notes or "",
        target_role=target_role,
        target_managed_by=target_managed_by,
        target_relationship_type=target_rel,
        issued_by=ctx.pubkey,
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


class CreateInviteCodeRequest(BaseModel):
    target_role: Optional[str] = "artist"        # 'artist' | 'label' | 'operator'
    target_managed_by: Optional[str] = None      # pubkey of label whose roster the artist joins
    # Phase G — recording-rights model the code carries through redemption.
    target_relationship_type: Optional[str] = "managed"  # 'self' | 'managed' | 'signed'


@router.post("/invite-codes")
async def create_invite_code(
    body: CreateInviteCodeRequest = CreateInviteCodeRequest(),
    ctx: RoleContext = Depends(require_label),
):
    """
    Generate a standalone invite code (not tied to an access request).

    target_role gates: only operators can issue label or operator codes.
    Operator codes never carry target_managed_by (server strips it).
    Labels can only set target_managed_by to their own pubkey.
    target_relationship_type seeds Phase G recording-rights model on redemption.
    """
    target_role = body.target_role or "artist"
    if target_role not in ("artist", "label", "operator"):
        raise HTTPException(status_code=400, detail="target_role must be artist, label, or operator")
    if target_role in ("label", "operator") and ctx.role != "operator":
        raise HTTPException(status_code=403, detail="Only operators can issue label or operator invites")

    target_managed_by = body.target_managed_by
    if target_role == "operator":
        target_managed_by = None
    if target_role == "artist" and target_managed_by and ctx.role != "operator":
        if target_managed_by != ctx.pubkey:
            raise HTTPException(status_code=403, detail="Labels can only assign artists to their own roster")

    target_rel = body.target_relationship_type or "managed"
    if target_rel not in ("self", "managed", "signed"):
        raise HTTPException(status_code=400, detail="target_relationship_type must be 'self', 'managed', or 'signed'")
    # Normalise: operator/standalone-label codes have no label relationship
    if target_role == "operator":
        target_rel = "self"
    if target_role == "label" and not target_managed_by:
        target_rel = "self"
    if target_rel in ("managed", "signed") and not target_managed_by:
        target_rel = "self"

    return await relay_admin.create_invite_code(
        target_role=target_role,
        target_managed_by=target_managed_by,
        target_relationship_type=target_rel,
        issued_by=ctx.pubkey,
    )


# ===== Add existing artist to roster =====


class AddExistingArtistRequest(BaseModel):
    artist_name: str
    npub: Optional[str] = ""  # optional, just for record-keeping
    # Phase G — Signed (label-rights) vs Managed (NIP-26 delegation, artist keeps rights).
    relationship_type: Optional[str] = "managed"


@router.post("/add-existing-artist")
async def add_existing_artist(
    body: AddExistingArtistRequest,
    ctx: RoleContext = Depends(require_label),
):
    """
    Generate a roster invite code for an existing-pubkey artist.

    The label fills in the artist's name (and optional npub for record) and chooses
    the relationship type (managed/signed). The artist redeems the code via
    /admin/redeem.html and joins the roster with the chosen relationship_type.
    """
    if not body.artist_name.strip():
        raise HTTPException(status_code=400, detail="artist_name is required")
    rel_type = body.relationship_type or "managed"
    if rel_type not in ("managed", "signed"):
        # 'self' doesn't make sense for a roster invite — the artist has no label
        raise HTTPException(status_code=400, detail="relationship_type must be 'managed' or 'signed' for roster invites")
    return await relay_admin.create_invite_code(
        target_role="artist",
        target_managed_by=ctx.pubkey,
        target_relationship_type=rel_type,
        issued_by=ctx.pubkey,
    )
