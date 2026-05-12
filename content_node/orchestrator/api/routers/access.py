"""
Access control router (Phase A).

Public + auth endpoints for the gated onboarding flow:
- /join visitors POST applications here (no auth)
- /admin/setup.html visitors check setup status + claim first operator
- /admin/redeem.html and /admin/onboarding.html validate + redeem invite codes

Permission-gated endpoints elsewhere:
- /api/label/access-requests/* (Phase D admin queue)
- /api/label/invite-codes (Phase D code generation)
- /api/label/add-existing-artist (this phase, in label.py)
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from dependencies import require_auth
from services import relay_admin

logger = logging.getLogger(__name__)
router = APIRouter()


# ===== Public application form (/join) =====


class CreateRequest(BaseModel):
    artist_name: str
    email: str = ""
    npub: str = ""
    description: str = ""
    links: str = ""
    requested_role: str = "artist"  # 'artist' | 'label'
    # Phase G — artists can preview the relationship_type they're requesting.
    # The approver may override on /api/label/access-requests/{id}/approve.
    target_relationship_type: str = "managed"  # 'self' | 'managed' | 'signed'


@router.post("/request")
async def create_request(req: CreateRequest):
    """
    Create a public access request. No auth — anyone can apply.
    Operator role cannot be self-applied.
    """
    if req.requested_role not in ("artist", "label"):
        raise HTTPException(status_code=400, detail="requested_role must be 'artist' or 'label'")
    if req.target_relationship_type not in ("self", "managed", "signed"):
        raise HTTPException(status_code=400, detail="target_relationship_type must be 'self', 'managed', or 'signed'")
    if not req.artist_name.strip():
        raise HTTPException(status_code=400, detail="artist_name is required")
    if not req.email.strip():
        raise HTTPException(status_code=400, detail="email is required")

    # Labels don't have a label relationship — coerce to 'self'
    rel_type = req.target_relationship_type
    if req.requested_role == "label":
        rel_type = "self"

    result = await relay_admin.create_access_request(
        artist_name=req.artist_name.strip(),
        email=req.email.strip(),
        npub=req.npub.strip(),
        description=req.description,
        links=req.links,
        requested_role=req.requested_role,
        target_relationship_type=rel_type,
    )
    return result


# ===== Invite code preview + redemption =====


@router.get("/check-invite")
async def check_invite(code: str):
    """
    Public — return invite code metadata so the redeemer can preview what they'll get.
    Returns 404 if the code doesn't exist or has been used.
    """
    if not code or len(code) != 12:
        raise HTTPException(status_code=400, detail="invalid code format")
    info = await relay_admin.get_invite_code(code)
    if info is None:
        raise HTTPException(status_code=404, detail="code not found or already used")
    # Only expose the fields the public needs to see
    return {
        "valid": True,
        "target_role": info.get("target_role", "artist"),
        "target_managed_by": info.get("target_managed_by"),
        "target_relationship_type": info.get("target_relationship_type", "managed"),
        "issuer_name": info.get("artist_name"),  # request name (or "(direct invite)" for orphan codes)
        "request_id": info.get("id"),
    }


class RedeemRequest(BaseModel):
    code: str
    display_name: str = ""


@router.post("/redeem")
async def redeem(req: RedeemRequest, pubkey: str = Depends(require_auth)):
    """
    Redeem an invite code. NIP-98 auth required so we know who's claiming.
    Returns RedeemResult: { role, node_artist? | node_operator? }.
    """
    if not req.code or len(req.code) != 12:
        raise HTTPException(status_code=400, detail="invalid code format")
    name = req.display_name.strip() or "(unnamed)"

    try:
        return await relay_admin.redeem_invite_code(req.code, pubkey, name)
    except HTTPException as e:
        # Surface the relay's structured error code for client-side branching
        raise e


# ===== First-run operator claim =====


@router.get("/setup-status")
async def setup_status():
    """Public — returns {needs_setup: bool}. Used by login/dashboard to detect fresh deploy."""
    return await relay_admin.setup_status()


class ClaimOperatorRequest(BaseModel):
    token: str
    name: str = ""


@router.post("/claim-operator")
async def claim_operator(req: ClaimOperatorRequest, pubkey: str = Depends(require_auth)):
    """
    Claim the first operator slot. NIP-98 auth required.
    Token comes from the relay's startup banner / /data/setup-token.txt.
    """
    if not req.token:
        raise HTTPException(status_code=400, detail="token required")
    name = req.name.strip() or "Node Operator"
    return await relay_admin.claim_first_operator(req.token, pubkey, name)
