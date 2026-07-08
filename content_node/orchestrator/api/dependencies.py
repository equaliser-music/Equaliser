"""
FastAPI dependencies for the Equaliser Orchestrator API.

Provides authentication (NIP-98) and role-based authorization.
Role data is resolved from the Equaliser relay's PostgreSQL database
via its internal REST API.
"""

import os
import logging
from dataclasses import dataclass, field
from typing import List, Optional

import httpx
from fastapi import Request, HTTPException

from services.nip98 import verify_nip98_token

logger = logging.getLogger(__name__)

RELAY_API_URL = os.getenv("RELAY_API_URL", "http://equaliser-relay:8008")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")


@dataclass
class RoleContext:
    """Resolved role for an authenticated user."""
    pubkey: str
    role: str  # "artist", "label", "operator"
    managed_artists: List[str] = field(default_factory=list)

    def can_manage(self, artist_pubkey: str) -> bool:
        """Check if this role can act on a given artist's content (drafts,
        uploads, publishing, packages, delegations).

        Hard role separation: operators are infrastructure-only and never act
        as an artist, so there is no operator bypass here. Use can_administer
        for roster administration.
        """
        return artist_pubkey == self.pubkey or artist_pubkey in self.managed_artists

    def can_administer(self, artist_pubkey: str) -> bool:
        """Check if this role can administer an artist's node_artists row
        (status, fees, relationship type, managed_by transfers) — distinct
        from acting on their content.
        """
        if self.role == "operator":
            return True
        return artist_pubkey in self.managed_artists


async def require_auth(request: Request) -> str:
    """
    FastAPI dependency that extracts and verifies NIP-98 auth.

    Returns the verified hex pubkey from the signed Kind 27235 event.
    Use as: pubkey: str = Depends(require_auth)

    For POST/PUT/PATCH requests, also passes the body bytes to the verifier
    so an optional `payload` tag (SHA256 of body) can be checked. Backwards
    compatible: the tag is verified only when the client included it.
    """
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Nostr "):
        raise HTTPException(status_code=401, detail="Missing NIP-98 Authorization header")

    body_bytes: bytes | None = None
    if request.method.upper() in ("POST", "PUT", "PATCH"):
        # Read once and cache so downstream Pydantic parsing still works.
        # Starlette caches the body internally after the first await.
        try:
            body_bytes = await request.body()
        except Exception:
            body_bytes = None

    return verify_nip98_token(auth_header, request.url.path, request.method, body_bytes)


async def _resolve_role(pubkey: str) -> Optional[RoleContext]:
    """Query the relay's internal API to resolve a pubkey's role."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{RELAY_API_URL}/api/internal/auth/role",
                params={"pubkey": pubkey},
            )
            if resp.status_code == 404:
                return None
            if resp.status_code != 200:
                logger.warning(f"Role resolution failed for {pubkey[:16]}...: HTTP {resp.status_code}")
                return None
            data = resp.json()
            return RoleContext(
                pubkey=data["pubkey"],
                role=data["role"],
                managed_artists=data.get("managed_artists", []),
            )
    except Exception as e:
        logger.warning(f"Role resolution error for {pubkey[:16]}...: {e}")
        return None


async def require_role(request: Request) -> RoleContext:
    """
    Authenticate via NIP-98 and resolve the user's role on this node.

    STRICT MODE (Phase A): if the pubkey is in neither `node_operators` nor
    `node_artists`, raises 403 with structured detail so the UI can redirect to
    /admin/redeem.html. The legacy "artist with self-only" fallback was removed
    when the gated-onboarding flow shipped — every admin-eligible pubkey must
    redeem an invite code to gain a node_artists/node_operators row.

    Returns RoleContext with pubkey, role, and managed_artists.
    """
    pubkey = await require_auth(request)
    ctx = await _resolve_role(pubkey)
    if ctx is None:
        raise HTTPException(
            status_code=403,
            detail={
                "reason": "no_role_on_node",
                "message": "This pubkey has no role on this node. Redeem an invite code to onboard.",
                "redirect": "/admin/redeem.html",
            },
        )
    return ctx


async def require_label(request: Request) -> RoleContext:
    """Require label or operator role.

    Used for endpoints whose action makes sense for both — typically because they
    branch per-role internally (e.g. artist CRUD: operator sees all artists, label
    sees only their roster; invite-codes generation: operator may issue
    label/operator codes, label only artist codes). The per-role logic in the
    body keeps the semantics clean.
    """
    ctx = await require_role(request)
    if ctx.role not in ("label", "operator"):
        raise HTTPException(status_code=403, detail="Label or operator access required")
    return ctx


async def require_label_strict(request: Request) -> RoleContext:
    """Require label role specifically — operators are rejected.

    Used for endpoints that only make sense when the caller IS a label acting on
    its own behalf (asking for a NIP-26 delegation from one of their artists,
    adding an existing artist to their own roster). Operators administering
    these actions on behalf of a label are not a use case today; if they ever
    need to be, parallel operator-tier endpoints can be added rather than
    overloading the label routes.
    """
    ctx = await require_role(request)
    if ctx.role != "label":
        raise HTTPException(
            status_code=403,
            detail="Label-only endpoint (operators have no analogue for this action)",
        )
    return ctx


async def require_operator(request: Request) -> RoleContext:
    """
    Require operator role.

    Supports two auth paths:
    1. NIP-98 with pubkey in node_operators table
    2. X-Admin-Token header matching ADMIN_PASSWORD env var
    """
    # Try NIP-98 first
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Nostr "):
        try:
            ctx = await require_role(request)
            if ctx.role == "operator":
                return ctx
        except HTTPException:
            pass

    # Fallback to ADMIN_PASSWORD
    admin_token = request.headers.get("X-Admin-Token")
    if ADMIN_PASSWORD and admin_token and admin_token == ADMIN_PASSWORD:
        return RoleContext(pubkey="admin", role="operator", managed_artists=[])

    raise HTTPException(status_code=403, detail="Operator access required")
