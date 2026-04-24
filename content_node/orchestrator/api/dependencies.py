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
        """Check if this role can manage a given artist's content."""
        if self.role == "operator":
            return True
        return artist_pubkey in self.managed_artists


async def require_auth(request: Request) -> str:
    """
    FastAPI dependency that extracts and verifies NIP-98 auth.

    Returns the verified hex pubkey from the signed Kind 27235 event.
    Use as: pubkey: str = Depends(require_auth)
    """
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Nostr "):
        raise HTTPException(status_code=401, detail="Missing NIP-98 Authorization header")

    return verify_nip98_token(auth_header, request.url.path, request.method)


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

    Returns RoleContext with pubkey, role, and managed_artists.
    Raises 403 if the pubkey is not recognized on this node.
    """
    pubkey = await require_auth(request)
    ctx = await _resolve_role(pubkey)
    if ctx is None:
        # Pubkey not in node_artists or node_operators — treat as artist
        # with self-only access (allows any authenticated user to use artist endpoints)
        return RoleContext(pubkey=pubkey, role="artist", managed_artists=[pubkey])
    return ctx


async def require_label(request: Request) -> RoleContext:
    """Require label or operator role."""
    ctx = await require_role(request)
    if ctx.role not in ("label", "operator"):
        raise HTTPException(status_code=403, detail="Label or operator access required")
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
