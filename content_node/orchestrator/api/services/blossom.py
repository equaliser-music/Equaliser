"""
Blossom client service for binary file storage.

Handles uploading and retrieving files from the local Blossom server.
Files are addressed by their SHA-256 hash.

Authentication uses BUD-03: NOSTR event-based authorization.
The node identity key signs upload authorization events (Kind 24242).
"""

import os
import hashlib
import time
import logging
from pathlib import Path
from typing import Optional

import httpx

from services.node_identity import get_node_pubkey, sign_node_event

logger = logging.getLogger(__name__)

# Blossom server URL (internal Docker network)
BLOSSOM_URL = os.getenv("BLOSSOM_URL", "http://blossom:3000")

# Public base URL for this node (e.g. "https://equaliser.app")
# When set, Blossom URLs in NOSTR events use absolute paths so they
# resolve correctly on peer nodes that sync our events.
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")


def _compute_sha256(file_path: Path) -> str:
    """Compute SHA-256 hash of a file."""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def _create_upload_auth(file_path: Path, sha256_hash: str) -> str:
    """
    Create a BUD-03 upload authorization header.

    Returns a base64-encoded signed NOSTR event (Kind 24242) that
    authorizes the upload of a specific file.
    """
    import base64
    import json

    pubkey = get_node_pubkey()

    # BUD-03: Kind 24242 authorization event
    auth_event = {
        "kind": 24242,
        "pubkey": pubkey,
        "created_at": int(time.time()),
        "tags": [
            ["t", "upload"],
            ["x", sha256_hash],
            ["expiration", str(int(time.time()) + 600)],  # 10 min expiry
        ],
        "content": f"Upload {file_path.name}",
    }

    # Sign with node key
    signed_event = sign_node_event(auth_event)

    # Encode as base64 for the Authorization header
    event_json = json.dumps(signed_event, separators=(",", ":"))
    event_b64 = base64.b64encode(event_json.encode()).decode()

    return f"Nostr {event_b64}"


async def upload_to_blossom(file_path: Path) -> str:
    """
    Upload a file to Blossom with BUD-03 authentication.

    Args:
        file_path: Path to the file to upload

    Returns:
        SHA-256 hash of the uploaded file

    Raises:
        RuntimeError: If upload fails
    """
    sha256_hash = _compute_sha256(file_path)

    # Check if blob already exists
    if await check_blob_exists(sha256_hash):
        logger.info(f"Blob already exists on Blossom: {sha256_hash[:16]}...")
        return sha256_hash

    # Create auth header
    auth_header = _create_upload_auth(file_path, sha256_hash)

    # Determine content type from extension
    ext = file_path.suffix.lower()
    content_types = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".flac": "audio/flac",
        ".aac": "audio/aac",
        ".ogg": "audio/ogg",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }
    content_type = content_types.get(ext, "application/octet-stream")

    # Upload via PUT (BUD-02)
    async with httpx.AsyncClient(timeout=300.0) as client:
        with open(file_path, "rb") as f:
            response = await client.put(
                f"{BLOSSOM_URL}/upload",
                content=f.read(),
                headers={
                    "Authorization": auth_header,
                    "Content-Type": content_type,
                    "X-SHA-256": sha256_hash,
                },
            )

        if response.status_code not in (200, 201):
            reason = response.headers.get("x-reason", "no reason header")
            logger.error(f"Blossom upload failed: status={response.status_code} reason='{reason}'")
            logger.error(f"Blossom response headers: {dict(response.headers)}")
            logger.error(f"Blossom response body: {response.text[:500]}")
            raise RuntimeError(
                f"Blossom upload failed ({response.status_code}): {reason}"
            )

        result = response.json()
        returned_hash = result.get("sha256", sha256_hash)
        logger.info(f"Uploaded to Blossom: {returned_hash[:16]}... ({file_path.name})")
        return returned_hash


async def check_blob_exists(sha256_hash: str) -> bool:
    """
    Check if a blob exists on Blossom.

    Args:
        sha256_hash: SHA-256 hash of the blob

    Returns:
        True if the blob exists
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            response = await client.head(f"{BLOSSOM_URL}/{sha256_hash}")
            return response.status_code == 200
        except httpx.RequestError:
            return False


async def download_from_blossom(sha256_hash: str, output_path: Path) -> bool:
    """
    Download a blob from Blossom to a local path.

    Args:
        sha256_hash: SHA-256 hash of the blob
        output_path: Path to write the downloaded file

    Returns:
        True if downloaded successfully
    """
    async with httpx.AsyncClient(timeout=300.0) as client:
        response = await client.get(f"{BLOSSOM_URL}/{sha256_hash}")

        if response.status_code != 200:
            logger.error(f"Blossom download failed ({response.status_code}): {sha256_hash[:16]}...")
            return False

        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "wb") as f:
            f.write(response.content)

        logger.info(f"Downloaded from Blossom: {sha256_hash[:16]}... -> {output_path}")
        return True


def _create_delete_auth(sha256_hash: str) -> str:
    """
    Create a BUD-03 delete authorization header.

    Returns a base64-encoded signed NOSTR event (Kind 24242) that
    authorizes the deletion of a specific blob.
    """
    import base64
    import json

    pubkey = get_node_pubkey()

    auth_event = {
        "kind": 24242,
        "pubkey": pubkey,
        "created_at": int(time.time()),
        "tags": [
            ["t", "delete"],
            ["x", sha256_hash],
            ["expiration", str(int(time.time()) + 600)],
        ],
        "content": f"Delete {sha256_hash[:16]}",
    }

    signed_event = sign_node_event(auth_event)

    event_json = json.dumps(signed_event, separators=(",", ":"))
    event_b64 = base64.b64encode(event_json.encode()).decode()

    return f"Nostr {event_b64}"


async def delete_from_blossom(sha256_hash: str) -> bool:
    """
    Delete a blob from Blossom with BUD-03 authentication.

    Args:
        sha256_hash: SHA-256 hash of the blob to delete

    Returns:
        True if deleted successfully
    """
    # Check if blob exists first
    if not await check_blob_exists(sha256_hash):
        logger.info(f"Blob not found on Blossom, nothing to delete: {sha256_hash[:16]}...")
        return True

    auth_header = _create_delete_auth(sha256_hash)

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.delete(
                f"{BLOSSOM_URL}/{sha256_hash}",
                headers={"Authorization": auth_header},
            )

            if response.status_code in (200, 204):
                logger.info(f"Deleted from Blossom: {sha256_hash[:16]}...")
                return True
            else:
                reason = response.headers.get("x-reason", response.text[:200])
                logger.warning(f"Blossom delete failed ({response.status_code}): {reason}")
                return False
        except httpx.RequestError as e:
            logger.warning(f"Blossom delete error for {sha256_hash[:16]}: {e}")
            return False


def get_blob_url(sha256_hash: str, extension: str = "") -> str:
    """
    Construct the public URL for a blob.

    When PUBLIC_BASE_URL is set, returns an absolute URL (e.g.
    https://equaliser.app/blossom/{hash}) so that NOSTR events
    work on peer nodes. Otherwise returns a relative path.

    Args:
        sha256_hash: SHA-256 hash of the blob
        extension: Optional file extension (e.g. ".mp3", ".jpg")

    Returns:
        Absolute or relative URL to the blob
    """
    path = f"/blossom/{sha256_hash}{extension}"
    if PUBLIC_BASE_URL:
        return f"{PUBLIC_BASE_URL}{path}"
    return path
