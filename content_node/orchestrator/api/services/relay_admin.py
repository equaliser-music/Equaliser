"""
HTTP client for the Equaliser Relay's internal admin API.

The orchestrator uses these calls to manage artists, access requests,
invite codes, and node stats. Role checks happen on the orchestrator
side via dependencies.py before these are called.
"""

import os
import logging
from typing import Optional, List, Dict, Any

import httpx
from fastapi import HTTPException

logger = logging.getLogger(__name__)

RELAY_API_URL = os.getenv("RELAY_API_URL", "http://equaliser-relay:8008")


async def _request(method: str, path: str, **kwargs) -> Any:
    """Wrapper around httpx with consistent error handling."""
    url = f"{RELAY_API_URL}{path}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.request(method, url, **kwargs)
            if resp.status_code == 404:
                return None
            if resp.status_code >= 400:
                detail = "internal error"
                try:
                    detail = resp.json().get("error", detail)
                except Exception:
                    pass
                raise HTTPException(status_code=resp.status_code, detail=detail)
            return resp.json()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Relay admin call failed ({method} {path}): {e}")
        raise HTTPException(status_code=502, detail="Relay admin unavailable")


# ===== Artist management =====

async def list_artists(managed_by: Optional[str] = None, role: Optional[str] = None) -> List[Dict]:
    params = {}
    if managed_by:
        params["managed_by"] = managed_by
    if role:
        params["role"] = role
    data = await _request("GET", "/api/internal/artists", params=params)
    return data.get("artists", []) if data else []


async def get_artist(pubkey: str) -> Optional[Dict]:
    return await _request("GET", f"/api/internal/artists/{pubkey}")


async def update_artist(
    pubkey: str,
    status: Optional[str] = None,
    fee_model: Optional[str] = None,
    fee_value: Optional[float] = None,
) -> Dict:
    body: Dict[str, Any] = {}
    if status is not None:
        body["status"] = status
    if fee_model is not None:
        body["fee_model"] = fee_model
    if fee_value is not None:
        body["fee_value"] = fee_value
    return await _request("PATCH", f"/api/internal/artists/{pubkey}", json=body)


# ===== Access requests =====

async def list_access_requests(status: Optional[str] = None) -> List[Dict]:
    params = {"status": status} if status else {}
    data = await _request("GET", "/api/internal/access-requests", params=params)
    return data.get("requests", []) if data else []


async def get_access_request(request_id: int) -> Optional[Dict]:
    return await _request("GET", f"/api/internal/access-requests/{request_id}")


async def create_access_request(
    artist_name: str,
    email: str = "",
    npub: str = "",
    description: str = "",
    links: str = "",
    requested_role: str = "artist",
) -> Dict:
    return await _request("POST", "/api/internal/access-requests", json={
        "requested_role": requested_role,
        "artist_name": artist_name,
        "email": email,
        "npub": npub,
        "description": description,
        "links": links,
    })


async def approve_access_request(
    request_id: int,
    admin_notes: str = "",
    target_role: str = "artist",
    target_managed_by: Optional[str] = None,
    issued_by: str = "",
) -> Dict:
    body: Dict[str, Any] = {
        "admin_notes": admin_notes,
        "target_role": target_role,
        "issued_by": issued_by,
    }
    if target_managed_by is not None:
        body["target_managed_by"] = target_managed_by
    return await _request("POST", f"/api/internal/access-requests/{request_id}/approve",
                          json=body)


async def decline_access_request(request_id: int, admin_notes: str = "") -> Dict:
    return await _request("POST", f"/api/internal/access-requests/{request_id}/decline",
                          json={"admin_notes": admin_notes})


# ===== Invite codes =====

async def list_invite_codes() -> List[Dict]:
    data = await _request("GET", "/api/internal/invite-codes")
    return data.get("codes", []) if data else []


async def create_invite_code(
    target_role: str = "artist",
    target_managed_by: Optional[str] = None,
    issued_by: str = "",
) -> Dict:
    body: Dict[str, Any] = {
        "target_role": target_role,
        "issued_by": issued_by,
    }
    if target_managed_by is not None:
        body["target_managed_by"] = target_managed_by
    return await _request("POST", "/api/internal/invite-codes", json=body)


# ===== Phase A: Invite redemption + setup-token =====


async def get_invite_code(code: str) -> Optional[Dict]:
    """Return invite-code metadata or None if not redeemable."""
    return await _request("GET", f"/api/internal/invite-codes/{code}")


async def redeem_invite_code(code: str, pubkey: str, display_name: str) -> Dict:
    """Redeem an invite code for a pubkey. Returns RedeemResult shape."""
    return await _request("POST", "/api/internal/invite-codes/redeem", json={
        "code": code,
        "pubkey": pubkey,
        "display_name": display_name,
    })


async def setup_status() -> Dict:
    """Returns {needs_setup: bool}."""
    return await _request("GET", "/api/internal/setup-status")


async def claim_first_operator(token: str, pubkey: str, name: str) -> Dict:
    """Claim the first operator slot using the setup token."""
    return await _request("POST", "/api/internal/operators/claim", json={
        "token": token,
        "pubkey": pubkey,
        "name": name,
    })


# ===== Node stats / users =====

async def list_registered_users(limit: int = 50, offset: int = 0) -> Dict:
    return await _request("GET", "/api/internal/registered-users",
                          params={"limit": limit, "offset": offset})


async def node_stats() -> Dict:
    return await _request("GET", "/api/internal/stats")


async def list_peer_relays() -> List[Dict]:
    data = await _request("GET", "/api/internal/peer-relays")
    return data.get("peers", []) if data else []
