"""
FastAPI dependencies for the Equaliser Orchestrator API.
"""

from fastapi import Request, HTTPException

from services.nip98 import verify_nip98_token


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
