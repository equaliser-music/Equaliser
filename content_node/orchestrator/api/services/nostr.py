"""
NOSTR service for event creation and publishing.

Handles:
- Creating Kind 30050 track metadata events
- Signing events with artist private key
- Publishing to NOSTR relays via WebSocket
"""

import os
import json
import time
import hashlib
from typing import Optional

import secp256k1
import websockets

# Default relay URL (internal Docker network)
NOSTR_RELAY_URL = os.getenv("NOSTR_RELAY_URL", "ws://nostr-relay:8080")

# Equaliser track event kind (parameterized replaceable)
TRACK_EVENT_KIND = 30050


def create_track_event(
    title: str,
    artist: str,
    duration: int,
    manifest_cid: str,
    preview_cid: str,
    pubkey: str,
    album: Optional[str] = None,
    genre: Optional[str] = None,
    price_sats: int = 100,
    release_date: Optional[str] = None,
    cover_art_cid: Optional[str] = None,
) -> dict:
    """
    Create a NOSTR Kind 30050 track metadata event.

    This is an unsigned event - must be signed before publishing.

    Args:
        title: Track title
        artist: Artist name
        duration: Track duration in seconds
        manifest_cid: IPFS CID of the HLS manifest (full track)
        preview_cid: IPFS CID of the preview HLS manifest
        pubkey: Artist's NOSTR public key (hex)
        album: Optional album name
        genre: Optional genre
        price_sats: Price per stream in satoshis
        release_date: Optional release date (ISO format)
        cover_art_cid: Optional IPFS CID of cover art

    Returns:
        Unsigned NOSTR event dict
    """
    # Generate unique track identifier
    track_id = hashlib.sha256(
        f"{pubkey}:{title}:{manifest_cid}".encode()
    ).hexdigest()[:16]

    created_at = int(time.time())

    tags = [
        ["d", track_id],  # Unique identifier for replaceable event
        ["app", "Equaliser"],
        ["title", title],
        ["artist", artist],
        ["duration", str(duration)],
        ["ipfs_manifest_cid", manifest_cid],
        ["ipfs_preview_cid", preview_cid],
        ["price_sats", str(price_sats)],
    ]

    if album:
        tags.append(["album", album])
    if genre:
        tags.append(["genre", genre])
    if release_date:
        tags.append(["release_date", release_date])
    if cover_art_cid:
        tags.append(["cover_art_cid", cover_art_cid])

    event = {
        "kind": TRACK_EVENT_KIND,
        "pubkey": pubkey,
        "created_at": created_at,
        "tags": tags,
        "content": "",  # Content is in tags for track events
    }

    return event


def sign_event(event: dict, privkey_hex: str) -> dict:
    """
    Sign a NOSTR event with a private key.

    Args:
        event: Unsigned event dict
        privkey_hex: Private key in hex format

    Returns:
        Signed event with 'id' and 'sig' fields
    """
    # Create event ID (SHA256 of serialized event)
    serialized = json.dumps([
        0,
        event["pubkey"],
        event["created_at"],
        event["kind"],
        event["tags"],
        event["content"]
    ], separators=(",", ":"), ensure_ascii=False)

    event_id = hashlib.sha256(serialized.encode()).hexdigest()

    # Sign with secp256k1
    privkey = secp256k1.PrivateKey(bytes.fromhex(privkey_hex))
    sig = privkey.schnorr_sign(
        bytes.fromhex(event_id),
        bip340tag=None,
        raw=True
    )

    signed_event = {
        **event,
        "id": event_id,
        "sig": sig.hex()
    }

    return signed_event


async def publish_event(event: dict, privkey_hex: str, relay_url: Optional[str] = None) -> str:
    """
    Sign and publish an event to a NOSTR relay.

    Args:
        event: Unsigned event dict
        privkey_hex: Private key for signing (hex)
        relay_url: Optional relay URL (defaults to local relay)

    Returns:
        Event ID if published successfully
    """
    relay = relay_url or NOSTR_RELAY_URL

    # Sign the event
    signed_event = sign_event(event, privkey_hex)

    # Publish via WebSocket
    async with websockets.connect(relay) as ws:
        # Send EVENT message
        message = json.dumps(["EVENT", signed_event])
        await ws.send(message)

        # Wait for OK response
        response = await ws.recv()
        result = json.loads(response)

        if result[0] == "OK" and result[2] is True:
            return signed_event["id"]
        elif result[0] == "OK" and result[2] is False:
            raise RuntimeError(f"Relay rejected event: {result[3]}")
        else:
            # Check if it's a NOTICE
            if result[0] == "NOTICE":
                raise RuntimeError(f"Relay notice: {result[1]}")
            raise RuntimeError(f"Unexpected response: {result}")


async def fetch_track_events(
    pubkey: Optional[str] = None,
    relay_url: Optional[str] = None,
    limit: int = 50
) -> list[dict]:
    """
    Fetch track events from a NOSTR relay.

    Args:
        pubkey: Optional filter by artist pubkey
        relay_url: Optional relay URL (defaults to local relay)
        limit: Maximum number of events to fetch

    Returns:
        List of track events
    """
    relay = relay_url or NOSTR_RELAY_URL

    filters = {
        "kinds": [TRACK_EVENT_KIND],
        "limit": limit
    }

    if pubkey:
        filters["authors"] = [pubkey]

    async with websockets.connect(relay) as ws:
        # Send REQ
        sub_id = "tracks"
        message = json.dumps(["REQ", sub_id, filters])
        await ws.send(message)

        events = []

        # Collect events until EOSE
        while True:
            response = await ws.recv()
            result = json.loads(response)

            if result[0] == "EVENT":
                events.append(result[2])
            elif result[0] == "EOSE":
                break
            elif result[0] == "NOTICE":
                raise RuntimeError(f"Relay notice: {result[1]}")

        # Close subscription
        await ws.send(json.dumps(["CLOSE", sub_id]))

        return events
