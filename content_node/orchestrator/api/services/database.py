"""
SQLite database service for draft track management.

Provides async database operations for storing track metadata
before NOSTR publication (draft workflow).
"""

import os
import aiosqlite
from datetime import datetime
from typing import Optional
from dataclasses import dataclass, asdict

# Database path from environment or default
DATABASE_PATH = os.environ.get("DATABASE_PATH", "/data/drafts.db")


@dataclass
class DraftTrack:
    """Draft track data model."""
    id: str
    artist_pubkey: str
    title: str
    artist_name: str
    ipfs_manifest_cid: str
    ipfs_preview_cid: str
    duration: int
    album: Optional[str] = None
    genre: Optional[str] = None
    price_amount: float = 0.05
    price_currency: str = "USD"
    release_date: Optional[str] = None
    release_type: str = "single"
    track_number: Optional[int] = None
    cover_art_cid: Optional[str] = None
    blossom_audio_hash: Optional[str] = None
    blossom_cover_hash: Optional[str] = None
    original_filename: Optional[str] = None
    status: str = "draft"
    nostr_event_id: Optional[str] = None
    nostr_d_tag: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    released_at: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return asdict(self)


SCHEMA = """
CREATE TABLE IF NOT EXISTS draft_tracks (
    id TEXT PRIMARY KEY,
    artist_pubkey TEXT NOT NULL,

    -- Metadata
    title TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    album TEXT,
    genre TEXT,
    price_amount REAL NOT NULL DEFAULT 0.05,
    price_currency TEXT NOT NULL DEFAULT 'USD',
    release_date TEXT,
    release_type TEXT DEFAULT 'single',
    track_number INTEGER,
    cover_art_cid TEXT,

    -- IPFS (populated on upload)
    ipfs_manifest_cid TEXT NOT NULL,
    ipfs_preview_cid TEXT NOT NULL,
    duration INTEGER NOT NULL,

    -- Blossom (original files)
    blossom_audio_hash TEXT,
    blossom_cover_hash TEXT,
    original_filename TEXT,

    -- Status
    status TEXT DEFAULT 'draft',
    nostr_event_id TEXT,
    nostr_d_tag TEXT,

    -- Timestamps
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    released_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_draft_tracks_artist ON draft_tracks(artist_pubkey);
CREATE INDEX IF NOT EXISTS idx_draft_tracks_status ON draft_tracks(status);
CREATE INDEX IF NOT EXISTS idx_draft_tracks_artist_status ON draft_tracks(artist_pubkey, status);
CREATE INDEX IF NOT EXISTS idx_draft_tracks_album ON draft_tracks(album);
"""


async def init_db():
    """Initialize the database with schema and run migrations."""
    # Ensure directory exists
    db_dir = os.path.dirname(DATABASE_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.executescript(SCHEMA)

        # Migration: add Blossom columns to existing databases
        for col in ["blossom_audio_hash TEXT", "blossom_cover_hash TEXT", "original_filename TEXT"]:
            try:
                await db.execute(f"ALTER TABLE draft_tracks ADD COLUMN {col}")
            except Exception:
                pass  # Column already exists

        await db.commit()
    print(f"Database initialized at {DATABASE_PATH}")


async def get_db():
    """Get database connection (async context manager)."""
    return aiosqlite.connect(DATABASE_PATH)


async def create_draft(draft: DraftTrack) -> DraftTrack:
    """Create a new draft track."""
    now = datetime.utcnow().isoformat()
    draft.created_at = now
    draft.updated_at = now

    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            """
            INSERT INTO draft_tracks (
                id, artist_pubkey, title, artist_name, album, genre,
                price_amount, price_currency, release_date, release_type, track_number,
                cover_art_cid, ipfs_manifest_cid, ipfs_preview_cid,
                duration, blossom_audio_hash, blossom_cover_hash, original_filename,
                status, nostr_event_id, nostr_d_tag,
                created_at, updated_at, released_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                draft.id, draft.artist_pubkey, draft.title, draft.artist_name,
                draft.album, draft.genre, draft.price_amount, draft.price_currency,
                draft.release_date,
                draft.release_type, draft.track_number, draft.cover_art_cid,
                draft.ipfs_manifest_cid, draft.ipfs_preview_cid, draft.duration,
                draft.blossom_audio_hash, draft.blossom_cover_hash, draft.original_filename,
                draft.status, draft.nostr_event_id, draft.nostr_d_tag,
                draft.created_at, draft.updated_at, draft.released_at
            )
        )
        await db.commit()

    return draft


async def get_draft(draft_id: str, artist_pubkey: Optional[str] = None) -> Optional[DraftTrack]:
    """Get a draft by ID, optionally verifying ownership."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row

        if artist_pubkey:
            cursor = await db.execute(
                "SELECT * FROM draft_tracks WHERE id = ? AND artist_pubkey = ?",
                (draft_id, artist_pubkey)
            )
        else:
            cursor = await db.execute(
                "SELECT * FROM draft_tracks WHERE id = ?",
                (draft_id,)
            )

        row = await cursor.fetchone()
        if not row:
            return None

        return DraftTrack(**dict(row))


async def list_drafts(
    artist_pubkey: str,
    status: Optional[str] = None,
    album: Optional[str] = None
) -> list[DraftTrack]:
    """List drafts for an artist, optionally filtered by status or album."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row

        query = "SELECT * FROM draft_tracks WHERE artist_pubkey = ?"
        params = [artist_pubkey]

        if status:
            query += " AND status = ?"
            params.append(status)

        if album:
            query += " AND album = ?"
            params.append(album)

        query += " ORDER BY created_at DESC"

        cursor = await db.execute(query, params)
        rows = await cursor.fetchall()

        return [DraftTrack(**dict(row)) for row in rows]


async def update_draft(
    draft_id: str,
    artist_pubkey: str,
    updates: dict
) -> Optional[DraftTrack]:
    """Update a draft's metadata. Returns updated draft or None if not found."""
    # Build update query dynamically
    allowed_fields = {
        "title", "artist_name", "album", "genre", "price_amount", "price_currency",
        "release_date", "release_type", "track_number", "cover_art_cid",
        "blossom_cover_hash"
    }

    # Filter to allowed fields only
    filtered_updates = {k: v for k, v in updates.items() if k in allowed_fields}

    if not filtered_updates:
        return await get_draft(draft_id, artist_pubkey)

    # Add updated_at
    filtered_updates["updated_at"] = datetime.utcnow().isoformat()

    # Build SET clause
    set_clause = ", ".join(f"{k} = ?" for k in filtered_updates.keys())
    values = list(filtered_updates.values())
    values.extend([draft_id, artist_pubkey])

    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            f"UPDATE draft_tracks SET {set_clause} WHERE id = ? AND artist_pubkey = ?",
            values
        )
        await db.commit()

    return await get_draft(draft_id, artist_pubkey)


async def mark_released(
    draft_id: str,
    nostr_event_id: str,
    nostr_d_tag: str
) -> bool:
    """Delete a draft after successful NOSTR publication.

    We delete rather than mark as 'released' because released tracks
    are now sourced from the NOSTR relay, not the database. This avoids
    sync issues between DB and NOSTR.

    Returns True if deleted, False if not found.
    """
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute(
            "DELETE FROM draft_tracks WHERE id = ?",
            (draft_id,)
        )
        await db.commit()
        return cursor.rowcount > 0


async def delete_draft(draft_id: str, artist_pubkey: str) -> bool:
    """Delete a draft. Returns True if deleted, False if not found."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute(
            "DELETE FROM draft_tracks WHERE id = ? AND artist_pubkey = ? AND status = 'draft'",
            (draft_id, artist_pubkey)
        )
        await db.commit()
        return cursor.rowcount > 0


async def get_album_drafts(album: str, artist_pubkey: str) -> list[DraftTrack]:
    """Get all draft tracks for an album, ordered by track number."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row

        cursor = await db.execute(
            """
            SELECT * FROM draft_tracks
            WHERE album = ? AND artist_pubkey = ? AND status = 'draft'
            ORDER BY track_number ASC, created_at ASC
            """,
            (album, artist_pubkey)
        )
        rows = await cursor.fetchall()

        return [DraftTrack(**dict(row)) for row in rows]
