"""
Track upload and management router.

Handles:
- Audio file upload
- HLS encoding via FFmpeg
- IPFS upload of segments
- NOSTR event publishing (Kind 30050)
"""

import os
import uuid
import json
import time
import asyncio
import hashlib
from typing import Optional
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, BackgroundTasks, Depends
from pydantic import BaseModel

import logging

from dependencies import require_auth
from services.hls import encode_to_hls, get_audio_duration
from services.ipfs import upload_directory_to_ipfs, upload_file_to_ipfs, unpin_cid
from services.nostr import create_track_event, publish_event, publish_signed_event
from services.database import DraftTrack, create_draft, mark_released, get_draft
from services.blossom import upload_to_blossom, download_from_blossom, delete_from_blossom

logger = logging.getLogger(__name__)

router = APIRouter()

# Temporary upload directory
UPLOAD_DIR = Path("/tmp/equaliser/uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


class TrackMetadata(BaseModel):
    """Track metadata for upload."""
    title: str
    artist: str
    album: Optional[str] = None
    genre: Optional[str] = None
    release_date: Optional[str] = None
    price_amount: float = 0.05  # Default price per stream
    price_currency: str = "USD"  # ISO 4217 code or SAT
    release_type: Optional[str] = None  # single, album, ep
    cover_art_cid: Optional[str] = None  # IPFS CID of cover art
    blossom_cover_hash: Optional[str] = None  # SHA-256 hash on Blossom


class TrackUploadResponse(BaseModel):
    """Response after successful track upload (now saved as draft)."""
    track_id: str
    draft_id: str  # Database draft ID
    title: str
    artist: str
    duration: int
    ipfs_manifest_cid: str
    ipfs_preview_cid: str
    blossom_audio_hash: Optional[str] = None  # SHA-256 of original audio on Blossom
    status: str  # "draft" for new uploads


class UploadStatus(BaseModel):
    """Track upload processing status."""
    track_id: str
    status: str  # pending, encoding, uploading, publishing, complete, error
    progress: int  # 0-100
    message: str
    result: Optional[TrackUploadResponse] = None


# In-memory status tracking (use Redis/DB in production)
upload_status: dict[str, UploadStatus] = {}


@router.post("/upload", response_model=UploadStatus)
async def upload_track(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    title: str = Form(...),
    artist: str = Form(...),
    album: Optional[str] = Form(None),
    genre: Optional[str] = Form(None),
    release_date: Optional[str] = Form(None),
    price_amount: float = Form(0.05),
    price_currency: str = Form("USD"),
    release_type: Optional[str] = Form(None),  # single, album, ep
    cover_art_cid: Optional[str] = Form(None),  # IPFS CID of cover art
    blossom_cover_hash: Optional[str] = Form(None),  # SHA-256 hash on Blossom
    artist_pubkey: str = Depends(require_auth),
):
    """
    Upload a track for processing.

    The track will be:
    1. Saved temporarily
    2. Encoded to HLS segments (background)
    3. Uploaded to IPFS (background)
    4. Published as NOSTR Kind 30050 event (background)

    Returns immediately with a track_id to poll for status.
    """
    # Validate file type
    if not file.content_type or not file.content_type.startswith("audio/"):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type: {file.content_type}. Must be an audio file."
        )

    # Generate unique track ID
    track_id = str(uuid.uuid4())

    # Create track directory
    track_dir = UPLOAD_DIR / track_id
    track_dir.mkdir(parents=True, exist_ok=True)

    # Determine file extension
    ext = Path(file.filename).suffix if file.filename else ".mp3"
    input_path = track_dir / f"original{ext}"

    # Save uploaded file
    try:
        content = await file.read()
        with open(input_path, "wb") as f:
            f.write(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")

    # Initialize status
    upload_status[track_id] = UploadStatus(
        track_id=track_id,
        status="pending",
        progress=0,
        message="Upload received, queued for processing"
    )

    # Prepare metadata
    metadata = TrackMetadata(
        title=title,
        artist=artist,
        album=album,
        genre=genre,
        release_date=release_date,
        price_amount=price_amount,
        price_currency=price_currency,
        release_type=release_type,
        cover_art_cid=cover_art_cid,
        blossom_cover_hash=blossom_cover_hash
    )

    # Start background processing
    background_tasks.add_task(
        process_track,
        track_id=track_id,
        input_path=input_path,
        track_dir=track_dir,
        metadata=metadata,
        artist_pubkey=artist_pubkey
    )

    return upload_status[track_id]


@router.get("/status/{track_id}", response_model=UploadStatus)
async def get_upload_status(track_id: str):
    """Get the processing status of an uploaded track."""
    if track_id not in upload_status:
        raise HTTPException(status_code=404, detail="Track not found")
    return upload_status[track_id]


@router.get("/")
async def list_tracks():
    """List all uploaded tracks (from status cache)."""
    completed = [
        status.result.model_dump()
        for status in upload_status.values()
        if status.status == "complete" and status.result
    ]
    return {"tracks": completed, "count": len(completed)}


class SignedEventRequest(BaseModel):
    """Request to publish a signed NOSTR event."""
    signed_event: dict
    draft_id: Optional[str] = None  # Optional: to update draft status after publish


class PublishEventResponse(BaseModel):
    """Response after publishing a NOSTR event."""
    event_id: str
    success: bool


@router.post("/publish", response_model=PublishEventResponse)
async def publish_track_event(request: SignedEventRequest, pubkey: str = Depends(require_auth)):
    """
    Publish a pre-signed NOSTR event for a track.

    Used when client-side signing is preferred (non-custodial).
    The event must be a valid signed Kind 30050 track event.

    If draft_id is provided, the draft will be deleted from the database
    (released tracks are sourced from NOSTR, not the database).
    """
    event = request.signed_event

    # Verify the signed event belongs to the authenticated user
    if event.get("pubkey") != pubkey:
        raise HTTPException(
            status_code=403,
            detail="Signed event pubkey does not match authenticated user"
        )

    # Validate event structure
    if "id" not in event or "sig" not in event:
        raise HTTPException(
            status_code=400,
            detail="Event must include 'id' and 'sig' fields (must be signed)"
        )

    if event.get("kind") != 30050:
        raise HTTPException(
            status_code=400,
            detail="Event must be Kind 30050 (track metadata)"
        )

    try:
        event_id = await publish_signed_event(event)

        # Delete draft from database if draft_id provided
        # (released tracks are now sourced from NOSTR relay)
        if request.draft_id:
            # Extract d-tag from event (for logging/debugging)
            d_tag = None
            for tag in event.get("tags", []):
                if tag[0] == "d" and len(tag) > 1:
                    d_tag = tag[1]
                    break
            await mark_released(request.draft_id, event_id, d_tag or "")

        return PublishEventResponse(event_id=event_id, success=True)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to publish event: {str(e)}"
        )


class CoverArtResponse(BaseModel):
    """Response after successful cover art upload."""
    cid: str
    blossom_hash: Optional[str] = None  # SHA-256 on Blossom
    url: str  # Primary URL (Blossom if available, else IPFS)
    ipfs_url: Optional[str] = None  # IPFS fallback URL


@router.post("/cover-art", response_model=CoverArtResponse)
async def upload_cover_art(
    file: UploadFile = File(...),
    pubkey: str = Depends(require_auth),
):
    """
    Upload cover art image to Blossom (primary) and IPFS (fallback).

    Accepts JPEG, PNG, or WebP images.
    Returns both Blossom hash and IPFS CID for use in release/track metadata.
    """
    # Validate file type
    valid_types = ["image/jpeg", "image/png", "image/webp"]
    if not file.content_type or file.content_type not in valid_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type: {file.content_type}. Must be JPEG, PNG, or WebP."
        )

    try:
        # Read file content
        content = await file.read()

        # Create temp file
        import tempfile
        ext = {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp"
        }.get(file.content_type, ".jpg")

        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        blossom_hash = None
        cid = None

        # Upload to Blossom (primary)
        try:
            blossom_hash = await upload_to_blossom(Path(tmp_path))
        except Exception as e:
            logger.warning(f"Blossom cover art upload failed: {e}")

        # Upload to IPFS (secondary/fallback)
        try:
            cid = await upload_file_to_ipfs(Path(tmp_path))
        except Exception as e:
            logger.warning(f"IPFS cover art upload failed: {e}")

        # Clean up temp file
        os.unlink(tmp_path)

        if not blossom_hash and not cid:
            raise RuntimeError("Both Blossom and IPFS uploads failed")

        # Prefer Blossom URL, fall back to IPFS
        primary_url = f"/blossom/{blossom_hash}{ext}" if blossom_hash else f"/ipfs/{cid}"
        ipfs_url = f"/ipfs/{cid}" if cid else None

        return CoverArtResponse(
            cid=cid or "",
            blossom_hash=blossom_hash,
            url=primary_url,
            ipfs_url=ipfs_url,
        )

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to upload cover art: {str(e)}"
        )


async def process_track(
    track_id: str,
    input_path: Path,
    track_dir: Path,
    metadata: TrackMetadata,
    artist_pubkey: str
):
    """
    Background task to process an uploaded track.

    Steps:
    1. Get audio duration
    2. Encode to HLS segments
    3. Upload to IPFS
    4. Save as draft in database (NOSTR publication deferred until release)
    """
    try:
        # Step 1: Upload original to Blossom (preserve for downloads/packages)
        update_status(track_id, "uploading", 5, "Preserving original audio on Blossom...")
        blossom_audio_hash = None
        try:
            blossom_audio_hash = await upload_to_blossom(input_path)
        except Exception as e:
            logger.warning(f"Blossom upload failed for {track_id}: {e}")
            update_status(track_id, "uploading", 5, f"Warning: Blossom unavailable, continuing without original backup")

        # Step 2: Get duration
        update_status(track_id, "encoding", 10, "Analyzing audio file...")
        duration = await get_audio_duration(input_path)

        # Step 3: Encode to HLS
        update_status(track_id, "encoding", 20, "Encoding to HLS segments...")
        hls_dir = track_dir / "hls"
        preview_dir = track_dir / "preview"

        await encode_to_hls(
            input_path=input_path,
            output_dir=hls_dir,
            preview_dir=preview_dir,
            preview_duration=30  # 30 second preview
        )

        update_status(track_id, "uploading", 50, "Uploading to IPFS...")

        # Step 4: Upload to IPFS
        # Upload full track directory
        manifest_cid = await upload_directory_to_ipfs(hls_dir)

        # Upload preview separately
        preview_cid = await upload_directory_to_ipfs(preview_dir)

        update_status(track_id, "saving", 80, "Saving draft...")

        # Determine original filename
        original_filename = input_path.name
        if original_filename.startswith("original"):
            # Use the uploaded filename from metadata if available
            original_filename = f"{metadata.title}{input_path.suffix}"

        # Step 5: Save as draft in database (instead of creating NOSTR event)
        draft = DraftTrack(
            id=track_id,
            artist_pubkey=artist_pubkey,
            title=metadata.title,
            artist_name=metadata.artist,
            album=metadata.album,
            genre=metadata.genre,
            price_amount=metadata.price_amount,
            price_currency=metadata.price_currency,
            release_date=metadata.release_date,
            release_type=metadata.release_type or "single",
            cover_art_cid=metadata.cover_art_cid,
            blossom_cover_hash=metadata.blossom_cover_hash,
            ipfs_manifest_cid=manifest_cid,
            ipfs_preview_cid=preview_cid,
            duration=duration,
            blossom_audio_hash=blossom_audio_hash,
            original_filename=original_filename,
            status="draft",
        )

        await create_draft(draft)

        # Complete - track is now a draft, not published to NOSTR
        result = TrackUploadResponse(
            track_id=track_id,
            draft_id=track_id,
            title=metadata.title,
            artist=metadata.artist,
            duration=duration,
            ipfs_manifest_cid=manifest_cid,
            ipfs_preview_cid=preview_cid,
            blossom_audio_hash=blossom_audio_hash,
            status="draft"
        )

        upload_status[track_id] = UploadStatus(
            track_id=track_id,
            status="complete",
            progress=100,
            message="Track saved as draft",
            result=result
        )

        # Cleanup temp files (keep for now during development)
        # shutil.rmtree(track_dir)

    except Exception as e:
        upload_status[track_id] = UploadStatus(
            track_id=track_id,
            status="error",
            progress=0,
            message=f"Processing failed: {str(e)}"
        )
        raise


def update_status(track_id: str, status: str, progress: int, message: str):
    """Update the processing status for a track."""
    if track_id in upload_status:
        upload_status[track_id].status = status
        upload_status[track_id].progress = progress
        upload_status[track_id].message = message


class DuplicateRequest(BaseModel):
    """Request to duplicate a draft track with independent IPFS CIDs."""
    source_draft_id: str


@router.post("/duplicate", response_model=UploadStatus)
async def duplicate_track(
    request: DuplicateRequest,
    background_tasks: BackgroundTasks,
    artist_pubkey: str = Depends(require_auth),
):
    """
    Duplicate a draft track with new HLS encoding and IPFS CIDs.

    Downloads original audio from Blossom, re-encodes to HLS, uploads to IPFS,
    and creates a new draft. The new draft shares the same blossom_audio_hash
    but has independent IPFS CIDs (safe to delete independently).
    """
    # Fetch source draft
    source = await get_draft(request.source_draft_id, artist_pubkey)
    if not source:
        raise HTTPException(status_code=404, detail="Source draft not found")

    if not source.blossom_audio_hash:
        raise HTTPException(
            status_code=400,
            detail="Source track has no original audio on Blossom. Cannot duplicate."
        )

    track_id = str(uuid.uuid4())

    upload_status[track_id] = UploadStatus(
        track_id=track_id,
        status="pending",
        progress=0,
        message="Queued for duplication"
    )

    background_tasks.add_task(process_duplicate, track_id, source, artist_pubkey)

    return upload_status[track_id]


async def process_duplicate(
    track_id: str,
    source: DraftTrack,
    artist_pubkey: str
):
    """
    Background task to duplicate a track with independent IPFS CIDs.

    Steps:
    1. Download original audio from Blossom
    2. Get audio duration
    3. Encode to HLS segments (new CIDs)
    4. Upload to IPFS
    5. Create new draft in database
    """
    try:
        # Step 1: Download original from Blossom
        update_status(track_id, "downloading", 5, "Downloading original audio from Blossom...")
        track_dir = UPLOAD_DIR / track_id
        track_dir.mkdir(parents=True, exist_ok=True)

        # Determine file extension from original filename
        ext = ".mp3"
        if source.original_filename:
            original_ext = Path(source.original_filename).suffix
            if original_ext:
                ext = original_ext

        input_path = track_dir / f"original{ext}"
        success = await download_from_blossom(source.blossom_audio_hash, input_path)
        if not success:
            raise RuntimeError("Failed to download original audio from Blossom")

        # Step 2: Get duration
        update_status(track_id, "encoding", 15, "Analyzing audio file...")
        duration = await get_audio_duration(input_path)

        # Step 3: Encode to HLS
        update_status(track_id, "encoding", 20, "Encoding to HLS segments...")
        hls_dir = track_dir / "hls"
        preview_dir = track_dir / "preview"

        await encode_to_hls(
            input_path=input_path,
            output_dir=hls_dir,
            preview_dir=preview_dir,
            preview_duration=30
        )

        # Step 4: Upload to IPFS (new CIDs)
        update_status(track_id, "uploading", 50, "Uploading to IPFS...")
        manifest_cid = await upload_directory_to_ipfs(hls_dir)
        preview_cid = await upload_directory_to_ipfs(preview_dir)

        # Step 5: Create new draft
        update_status(track_id, "saving", 80, "Creating draft...")
        draft = DraftTrack(
            id=track_id,
            artist_pubkey=artist_pubkey,
            title=source.title,
            artist_name=source.artist_name,
            ipfs_manifest_cid=manifest_cid,
            ipfs_preview_cid=preview_cid,
            duration=duration,
            price_amount=source.price_amount,
            price_currency=source.price_currency,
            blossom_audio_hash=source.blossom_audio_hash,
            original_filename=source.original_filename,
            genre=source.genre,
            status="draft",
        )

        await create_draft(draft)

        result = TrackUploadResponse(
            track_id=track_id,
            draft_id=track_id,
            title=source.title,
            artist=source.artist_name,
            duration=duration,
            ipfs_manifest_cid=manifest_cid,
            ipfs_preview_cid=preview_cid,
            blossom_audio_hash=source.blossom_audio_hash,
            status="draft"
        )

        upload_status[track_id] = UploadStatus(
            track_id=track_id,
            status="complete",
            progress=100,
            message="Track duplicated successfully",
            result=result
        )

    except Exception as e:
        upload_status[track_id] = UploadStatus(
            track_id=track_id,
            status="error",
            progress=0,
            message=f"Duplication failed: {str(e)}"
        )
        raise


class TrackCleanupItem(BaseModel):
    """A track's storage references for cleanup after deletion."""
    ipfs_manifest_cid: str
    ipfs_preview_cid: str
    blossom_audio_hash: Optional[str] = None
    cover_art_cid: Optional[str] = None
    blossom_cover_hash: Optional[str] = None


class CleanupRequest(BaseModel):
    """Request to clean up storage for deleted tracks."""
    tracks: list[TrackCleanupItem]


class CleanupResponse(BaseModel):
    """Response from storage cleanup."""
    ipfs_unpinned: int
    blossom_deleted: int
    errors: list[str]


@router.post("/cleanup", response_model=CleanupResponse)
async def cleanup_deleted_tracks(
    request: CleanupRequest,
    pubkey: str = Depends(require_auth),
):
    """
    Clean up IPFS pins and Blossom blobs for deleted tracks.

    Called after the client publishes a Kind 5 deletion event.
    IPFS CIDs are always safe to unpin (each release owns its own CIDs).
    Blossom hashes should only be included if the client confirmed no
    other release references them.

    Best-effort: logs failures but returns success.
    """
    ipfs_unpinned = 0
    blossom_deleted = 0
    errors = []

    for track in request.tracks:
        # Unpin IPFS manifest and preview (always safe — unique per release)
        for cid_name, cid in [("manifest", track.ipfs_manifest_cid), ("preview", track.ipfs_preview_cid)]:
            if cid:
                try:
                    if await unpin_cid(cid):
                        ipfs_unpinned += 1
                    else:
                        errors.append(f"IPFS unpin failed: {cid[:16]}...")
                except Exception as e:
                    errors.append(f"IPFS unpin error ({cid_name}): {str(e)}")

        # Delete Blossom audio blob (only if client says it's safe)
        if track.blossom_audio_hash:
            try:
                if await delete_from_blossom(track.blossom_audio_hash):
                    blossom_deleted += 1
                else:
                    errors.append(f"Blossom delete failed: {track.blossom_audio_hash[:16]}...")
            except Exception as e:
                errors.append(f"Blossom audio delete error: {str(e)}")

        # Unpin cover art from IPFS (only if client says it's safe)
        if track.cover_art_cid:
            try:
                if await unpin_cid(track.cover_art_cid):
                    ipfs_unpinned += 1
            except Exception as e:
                errors.append(f"IPFS cover unpin error: {str(e)}")

        # Delete cover art from Blossom (only if client says it's safe)
        if track.blossom_cover_hash:
            try:
                if await delete_from_blossom(track.blossom_cover_hash):
                    blossom_deleted += 1
            except Exception as e:
                errors.append(f"Blossom cover delete error: {str(e)}")

    if errors:
        logger.warning(f"Cleanup completed with {len(errors)} errors: {errors}")
    else:
        logger.info(f"Cleanup complete: {ipfs_unpinned} IPFS unpins, {blossom_deleted} Blossom deletes")

    return CleanupResponse(
        ipfs_unpinned=ipfs_unpinned,
        blossom_deleted=blossom_deleted,
        errors=errors,
    )
