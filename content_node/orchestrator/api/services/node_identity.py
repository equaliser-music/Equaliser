"""
Node identity service for content node authentication.

Manages a persistent NOSTR keypair for the content node itself.
Used for server-side operations like Blossom upload authentication (BUD-03).

The keypair is generated once on first startup and stored in the data volume.
"""

import os
import json
import hashlib
import time
import logging
from pathlib import Path
from typing import Optional

import secp256k1

logger = logging.getLogger(__name__)

# Path to store the node identity (same volume as the database)
NODE_IDENTITY_PATH = os.getenv("NODE_IDENTITY_PATH", "/data/node_identity.json")

# Module-level state
_node_privkey: Optional[str] = None
_node_pubkey: Optional[str] = None


async def init_node_identity():
    """
    Initialize or load the node identity.

    On first run, generates a new secp256k1 keypair and saves it.
    On subsequent runs, loads the existing keypair.
    """
    global _node_privkey, _node_pubkey

    identity_path = Path(NODE_IDENTITY_PATH)

    if identity_path.exists():
        # Load existing identity
        with open(identity_path, "r") as f:
            data = json.load(f)
        _node_privkey = data["private_key"]
        _node_pubkey = data["public_key"]
        logger.info(f"Loaded node identity: {_node_pubkey[:16]}...")
    else:
        # Generate new keypair
        privkey = secp256k1.PrivateKey()
        _node_privkey = privkey.private_key.hex()
        _node_pubkey = privkey.pubkey.serialize()[1:].hex()  # x-only pubkey

        # Ensure directory exists
        identity_path.parent.mkdir(parents=True, exist_ok=True)

        # Save to disk
        data = {
            "private_key": _node_privkey,
            "public_key": _node_pubkey,
            "created_at": int(time.time()),
            "description": "Equaliser content node identity - used for Blossom upload auth"
        }
        with open(identity_path, "w") as f:
            json.dump(data, f, indent=2)

        logger.info(f"Generated new node identity: {_node_pubkey[:16]}...")


def get_node_pubkey() -> str:
    """Return the node's hex public key (x-only, 64 chars)."""
    if _node_pubkey is None:
        raise RuntimeError("Node identity not initialized. Call init_node_identity() first.")
    return _node_pubkey


def get_node_privkey() -> str:
    """Return the node's hex private key."""
    if _node_privkey is None:
        raise RuntimeError("Node identity not initialized. Call init_node_identity() first.")
    return _node_privkey


def sign_node_event(event: dict) -> dict:
    """
    Sign a NOSTR event with the node's private key.

    Args:
        event: Unsigned event dict with kind, pubkey, created_at, tags, content

    Returns:
        Signed event with id and sig fields added
    """
    privkey_hex = get_node_privkey()

    # Compute event ID
    serialized = json.dumps([
        0,
        event["pubkey"],
        event["created_at"],
        event["kind"],
        event["tags"],
        event["content"]
    ], separators=(",", ":"), ensure_ascii=False)

    event_id = hashlib.sha256(serialized.encode()).hexdigest()

    # Sign with secp256k1 schnorr
    privkey = secp256k1.PrivateKey(bytes.fromhex(privkey_hex))
    sig = privkey.schnorr_sign(
        bytes.fromhex(event_id),
        bip340tag=None,
        raw=True
    )

    return {
        **event,
        "id": event_id,
        "sig": sig.hex()
    }
