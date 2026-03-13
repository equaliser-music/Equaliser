"""
NIP-98 HTTP Auth verification.

Verifies Kind 27235 NOSTR events used as HTTP authentication tokens.
The client signs an event containing the request URL and method,
proving ownership of the claimed public key.

See: https://github.com/nostr-protocol/nips/blob/master/98.md
"""

import json
import time
import hashlib
import base64
import logging
from urllib.parse import urlparse

import secp256k1
from fastapi import HTTPException

logger = logging.getLogger(__name__)

# Maximum age of a NIP-98 event (seconds) — prevents replay attacks
MAX_EVENT_AGE = 60


def verify_nip98_token(auth_header: str, request_path: str, request_method: str) -> str:
    """
    Verify a NIP-98 Authorization header and return the authenticated pubkey.

    Args:
        auth_header: The full Authorization header value ("Nostr <base64>")
        request_path: The URL path of the request (e.g. "/api/tracks/upload")
        request_method: The HTTP method (e.g. "POST")

    Returns:
        The verified hex pubkey from the event

    Raises:
        HTTPException: If verification fails (401)
    """
    # Extract base64 token
    if not auth_header.startswith("Nostr "):
        raise HTTPException(status_code=401, detail="Invalid Authorization scheme (expected 'Nostr')")

    token = auth_header[6:]

    # Decode base64
    try:
        event_json = base64.b64decode(token)
        event = json.loads(event_json)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid NIP-98 token encoding")

    # Check required fields
    for field in ("id", "pubkey", "created_at", "kind", "tags", "content", "sig"):
        if field not in event:
            raise HTTPException(status_code=401, detail=f"NIP-98 event missing '{field}'")

    # Check kind
    if event["kind"] != 27235:
        raise HTTPException(status_code=401, detail="NIP-98 event must be Kind 27235")

    # Check timestamp (anti-replay)
    now = int(time.time())
    event_age = abs(now - event["created_at"])
    if event_age > MAX_EVENT_AGE:
        raise HTTPException(status_code=401, detail="NIP-98 event expired (too old or clock skew)")

    # Check URL tag (compare paths only — avoids proxy scheme/host mismatches)
    event_url = _get_tag(event, "u")
    if not event_url:
        raise HTTPException(status_code=401, detail="NIP-98 event missing 'u' tag")

    event_path = urlparse(event_url).path
    if event_path != request_path:
        raise HTTPException(
            status_code=401,
            detail=f"NIP-98 URL mismatch: event path '{event_path}' != request path '{request_path}'"
        )

    # Check method tag
    event_method = _get_tag(event, "method")
    if not event_method:
        raise HTTPException(status_code=401, detail="NIP-98 event missing 'method' tag")

    if event_method.upper() != request_method.upper():
        raise HTTPException(
            status_code=401,
            detail=f"NIP-98 method mismatch: '{event_method}' != '{request_method}'"
        )

    # Verify event ID (SHA-256 of canonical serialisation)
    serialized = json.dumps([
        0,
        event["pubkey"],
        event["created_at"],
        event["kind"],
        event["tags"],
        event["content"]
    ], separators=(",", ":"), ensure_ascii=False)

    expected_id = hashlib.sha256(serialized.encode()).hexdigest()
    if event["id"] != expected_id:
        raise HTTPException(status_code=401, detail="NIP-98 event ID verification failed")

    # Verify Schnorr signature
    if not _verify_schnorr(event["pubkey"], event["id"], event["sig"]):
        raise HTTPException(status_code=401, detail="NIP-98 signature verification failed")

    logger.info(f"NIP-98 auth verified for pubkey {event['pubkey'][:16]}... on {request_method} {request_path}")
    return event["pubkey"]


def _verify_schnorr(pubkey_hex: str, event_id_hex: str, sig_hex: str) -> bool:
    """Verify a BIP-340 Schnorr signature using secp256k1."""
    try:
        # x-only pubkey (32 bytes) needs 0x02 prefix for compressed SEC1 format
        pubkey_bytes = b'\x02' + bytes.fromhex(pubkey_hex)
        pubkey = secp256k1.PublicKey(pubkey_bytes, raw=True)

        msg = bytes.fromhex(event_id_hex)
        sig = bytes.fromhex(sig_hex)

        return pubkey.schnorr_verify(msg, sig, bip340tag=None, raw=True)
    except Exception as e:
        logger.warning(f"Schnorr verification error: {e}")
        return False


def _get_tag(event: dict, tag_name: str) -> str | None:
    """Get the value of a tag from a NOSTR event."""
    for tag in event.get("tags", []):
        if len(tag) >= 2 and tag[0] == tag_name:
            return tag[1]
    return None
