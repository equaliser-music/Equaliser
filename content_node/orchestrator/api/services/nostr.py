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

# Equaliser event kinds (parameterized replaceable)
TRACK_EVENT_KIND = 30050
RELEASE_EVENT_KIND = 30051


def create_track_event(
    title: str,
    artist: str,
    duration: int,
    manifest_cid: str,
    preview_cid: str,
    pubkey: str,
    album: Optional[str] = None,
    genre: Optional[str] = None,
    price_amount: float = 0.05,
    price_currency: str = "USD",
    release_date: Optional[str] = None,
    cover_art_cid: Optional[str] = None,
    release_type: Optional[str] = None,
    release_id: Optional[str] = None,
    track_number: Optional[int] = None,
    blossom_audio_hash: Optional[str] = None,
    blossom_cover_hash: Optional[str] = None,
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
        price_amount: Price per stream in the specified currency
        price_currency: ISO 4217 currency code (USD, GBP, EUR, JPY) or SAT
        release_date: Optional release date (ISO format)
        cover_art_cid: Optional IPFS CID of cover art
        release_type: Release type (single, album, ep)
        release_id: Optional release event d-tag to link this track to
        track_number: Optional track number within the release

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
        ["price", str(price_amount)],
        ["price_currency", price_currency],
    ]

    if album:
        tags.append(["album", album])
    if genre:
        tags.append(["genre", genre])
    if release_date:
        tags.append(["release_date", release_date])
    if cover_art_cid:
        tags.append(["cover_art_cid", cover_art_cid])
    if release_type:
        tags.append(["release_type", release_type])
    if release_id:
        # Link to parent release using 'a' tag (addressable reference)
        tags.append(["a", f"{RELEASE_EVENT_KIND}:{pubkey}:{release_id}"])
        tags.append(["release_id", release_id])
    if track_number is not None:
        tags.append(["track_number", str(track_number)])
    if blossom_audio_hash:
        tags.append(["blossom_audio_hash", blossom_audio_hash])
    if blossom_cover_hash:
        tags.append(["blossom_cover_hash", blossom_cover_hash])

    event = {
        "kind": TRACK_EVENT_KIND,
        "pubkey": pubkey,
        "created_at": created_at,
        "tags": tags,
        "content": "",  # Content is in tags for track events
    }

    return event


def create_release_event(
    title: str,
    artist: str,
    release_type: str,
    pubkey: str,
    description: Optional[str] = None,
    genre: Optional[str] = None,
    release_date: Optional[str] = None,
    cover_art_cid: Optional[str] = None,
    price_amount: float = 0,
    price_currency: str = "USD",
    track_count: int = 0,
    total_duration: int = 0,
) -> dict:
    """
    Create a NOSTR Kind 30051 release metadata event.

    A release groups tracks together (album, EP, or single).

    Args:
        title: Release title (album name, EP name, or single track name)
        artist: Artist name
        release_type: Type of release (album, ep, single)
        pubkey: Artist's NOSTR public key (hex)
        description: Optional release description
        genre: Optional genre
        release_date: Release date (ISO format)
        cover_art_cid: IPFS CID of cover art
        price_amount: Total price for the release in the specified currency
        price_currency: ISO 4217 currency code (USD, GBP, EUR, JPY) or SAT
        track_count: Number of tracks in the release
        total_duration: Total duration in seconds

    Returns:
        Unsigned NOSTR event dict
    """
    # Generate unique release identifier
    release_id = hashlib.sha256(
        f"{pubkey}:{title}:{release_type}".encode()
    ).hexdigest()[:16]

    created_at = int(time.time())

    tags = [
        ["d", release_id],  # Unique identifier for replaceable event
        ["app", "Equaliser"],
        ["title", title],
        ["artist", artist],
        ["release_type", release_type],
    ]

    if description:
        tags.append(["description", description])
    if genre:
        tags.append(["genre", genre])
    if release_date:
        tags.append(["release_date", release_date])
    if cover_art_cid:
        tags.append(["cover_art_cid", cover_art_cid])
    if price_amount > 0:
        tags.append(["price", str(price_amount)])
        tags.append(["price_currency", price_currency])
    if track_count > 0:
        tags.append(["track_count", str(track_count)])
    if total_duration > 0:
        tags.append(["total_duration", str(total_duration)])

    event = {
        "kind": RELEASE_EVENT_KIND,
        "pubkey": pubkey,
        "created_at": created_at,
        "tags": tags,
        "content": "",
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


async def publish_signed_event(signed_event: dict, relay_url: Optional[str] = None) -> str:
    """
    Publish an already-signed event to a NOSTR relay.

    Args:
        signed_event: Event dict with 'id' and 'sig' fields
        relay_url: Optional relay URL (defaults to local relay)

    Returns:
        Event ID if published successfully
    """
    relay = relay_url or NOSTR_RELAY_URL

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


async def fetch_release_events(
    pubkey: Optional[str] = None,
    relay_url: Optional[str] = None,
    limit: int = 50
) -> list[dict]:
    """
    Fetch release events from a NOSTR relay.

    Args:
        pubkey: Optional filter by artist pubkey
        relay_url: Optional relay URL (defaults to local relay)
        limit: Maximum number of events to fetch

    Returns:
        List of release events
    """
    relay = relay_url or NOSTR_RELAY_URL

    filters = {
        "kinds": [RELEASE_EVENT_KIND],
        "limit": limit
    }

    if pubkey:
        filters["authors"] = [pubkey]

    async with websockets.connect(relay) as ws:
        # Send REQ
        sub_id = "releases"
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


async def fetch_tracks_for_release(
    release_id: str,
    pubkey: str,
    relay_url: Optional[str] = None,
) -> list[dict]:
    """
    Fetch all tracks belonging to a specific release.

    Args:
        release_id: The d-tag of the release event
        pubkey: Artist pubkey
        relay_url: Optional relay URL (defaults to local relay)

    Returns:
        List of track events for the release
    """
    relay = relay_url or NOSTR_RELAY_URL

    # Query tracks that reference this release
    filters = {
        "kinds": [TRACK_EVENT_KIND],
        "authors": [pubkey],
        "#release_id": [release_id]
    }

    async with websockets.connect(relay) as ws:
        sub_id = "release_tracks"
        message = json.dumps(["REQ", sub_id, filters])
        await ws.send(message)

        events = []

        while True:
            response = await ws.recv()
            result = json.loads(response)

            if result[0] == "EVENT":
                events.append(result[2])
            elif result[0] == "EOSE":
                break
            elif result[0] == "NOTICE":
                raise RuntimeError(f"Relay notice: {result[1]}")

        await ws.send(json.dumps(["CLOSE", sub_id]))

        # Sort by track number
        def get_track_number(event):
            for tag in event.get("tags", []):
                if tag[0] == "track_number":
                    return int(tag[1])
            return 999

        events.sort(key=get_track_number)
        return events
