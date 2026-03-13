"""
Release package export/import router.

Handles:
- Export preparation (build manifest, return unsigned event for signing)
- Export download (build .eqpkg.zip with signed event)
- Import (extract .eqpkg.zip, create drafts)

Package format (.eqpkg.zip):
    manifest.json       - Metadata, track list, file hashes
    signature.json      - Signed NOSTR event covering manifest hash
    cover.{ext}         - Cover art image
    tracks/
        01-track.mp3    - Original audio files
"""

import os
import json
import time
import uuid
import hashlib
import zipfile
import tempfile
import logging
from io import BytesIO
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from dependencies import require_auth
from services.database import (
    DraftTrack,
    get_album_drafts,
    list_drafts,
    create_draft,
)
from services.nostr import fetch_track_events
from services.blossom import (
    download_from_blossom,
    upload_to_blossom,
    check_blob_exists,
)
from services.hls import encode_to_hls, get_audio_duration
from services.ipfs import upload_directory_to_ipfs, upload_file_to_ipfs

logger = logging.getLogger(__name__)

router = APIRouter()

FORMAT_VERSION = "1.0"
UPLOAD_DIR = Path("/tmp/equaliser/uploads")


# --- Request/Response Models ---

class ExportPrepareRequest(BaseModel):
    """Request to prepare a release for export."""
    album: str
    source: str = "draft"  # "draft" or "nostr"


class ExportPrepareResponse(BaseModel):
    """Response with manifest and unsigned event for signing."""
    manifest: dict
    manifest_sha256: str
    unsigned_event: dict


class ExportDownloadRequest(BaseModel):
    """Request to download the package with signed event."""
    manifest: dict
    signed_event: dict


class ImportResponse(BaseModel):
    """Response after importing a package."""
    draft_ids: list[str]
    track_count: int
    album: str
    artist: str
    warnings: list[str] = []


# --- Export Endpoints ---

@router.post("/export-prepare", response_model=ExportPrepareResponse)
async def export_prepare(request: ExportPrepareRequest, pubkey: str = Depends(require_auth)):
    """
    Prepare a release for export.

    Gathers track data, builds a manifest, and returns an unsigned
    NOSTR event for the client to sign. The signed event proves
    the package was created by the artist.
    """
    tracks_data = []
    cover_art_info = None
    release_info = {
        "title": request.album,
        "artist": "",
        "release_type": "album",
        "genre": "",
        "release_date": "",
    }

    if request.source == "draft":
        drafts = await get_album_drafts(request.album, pubkey)
        if not drafts:
            # Try as a single track
            all_drafts = await list_drafts(pubkey, status="draft")
            drafts = [d for d in all_drafts if d.title == request.album]

        if not drafts:
            raise HTTPException(
                status_code=404,
                detail=f"No draft tracks found for '{request.album}'"
            )

        for i, draft in enumerate(drafts, start=1):
            track_num = draft.track_number or i

            if not draft.blossom_audio_hash:
                raise HTTPException(
                    status_code=400,
                    detail=f"Track '{draft.title}' has no original audio on Blossom. "
                           "Re-upload the track to preserve the original."
                )

            tracks_data.append({
                "title": draft.title,
                "track_number": track_num,
                "duration": draft.duration,
                "price_amount": draft.price_amount,
                "price_currency": draft.price_currency,
                "genre": draft.genre or "",
                "audio": {
                    "filename": f"tracks/{track_num:02d}-{_safe_filename(draft.title)}{_ext_from_filename(draft.original_filename)}",
                    "sha256": draft.blossom_audio_hash,
                    "original_filename": draft.original_filename or "",
                },
            })

            # Use first track's data for release info
            if i == 1:
                release_info["artist"] = draft.artist_name
                release_info["release_type"] = draft.release_type or "album"
                release_info["genre"] = draft.genre or ""
                release_info["release_date"] = draft.release_date or ""

            # Cover art from any track that has it
            if draft.blossom_cover_hash and not cover_art_info:
                cover_art_info = {
                    "filename": "cover.jpg",
                    "sha256": draft.blossom_cover_hash,
                }
            elif draft.cover_art_cid and not cover_art_info:
                cover_art_info = {
                    "filename": "cover.jpg",
                    "ipfs_cid": draft.cover_art_cid,
                }

    elif request.source == "nostr":
        events = await fetch_track_events(pubkey=pubkey)
        # Filter to matching album
        album_events = [e for e in events if _get_tag(e, "album") == request.album]

        if not album_events:
            raise HTTPException(
                status_code=404,
                detail=f"No released tracks found for album '{request.album}'"
            )

        for i, event in enumerate(album_events, start=1):
            blossom_hash = _get_tag(event, "blossom_audio_hash")
            if not blossom_hash:
                raise HTTPException(
                    status_code=400,
                    detail=f"Track '{_get_tag(event, 'title')}' has no original audio on Blossom"
                )

            track_num = int(_get_tag(event, "track_number") or i)
            title = _get_tag(event, "title") or "Untitled"

            tracks_data.append({
                "title": title,
                "track_number": track_num,
                "duration": int(_get_tag(event, "duration") or 0),
                "price_amount": float(_get_tag(event, "price") or 0.05),
                "price_currency": _get_tag(event, "price_currency") or "USD",
                "genre": _get_tag(event, "genre") or "",
                "audio": {
                    "filename": f"tracks/{track_num:02d}-{_safe_filename(title)}.mp3",
                    "sha256": blossom_hash,
                    "original_filename": "",
                },
            })

            if i == 1:
                release_info["artist"] = _get_tag(event, "artist") or ""
                release_info["release_type"] = _get_tag(event, "release_type") or "album"
                release_info["genre"] = _get_tag(event, "genre") or ""
                release_info["release_date"] = _get_tag(event, "release_date") or ""

            blossom_cover = _get_tag(event, "blossom_cover_hash")
            if blossom_cover and not cover_art_info:
                cover_art_info = {
                    "filename": "cover.jpg",
                    "sha256": blossom_cover,
                }
    else:
        raise HTTPException(status_code=400, detail="source must be 'draft' or 'nostr'")

    # Sort tracks by track number
    tracks_data.sort(key=lambda t: t["track_number"])

    # Build manifest
    manifest = {
        "format_version": FORMAT_VERSION,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "release": release_info,
        "tracks": tracks_data,
    }

    if cover_art_info:
        manifest["release"]["cover_art"] = cover_art_info

    # Hash the manifest
    manifest_json = json.dumps(manifest, separators=(",", ":"), sort_keys=True)
    manifest_sha256 = hashlib.sha256(manifest_json.encode()).hexdigest()

    # Create unsigned event for client to sign
    unsigned_event = {
        "kind": 1,
        "pubkey": pubkey,
        "created_at": int(time.time()),
        "tags": [
            ["app", "Equaliser"],
            ["t", "eqpkg"],
            ["format_version", FORMAT_VERSION],
            ["album", request.album],
        ],
        "content": manifest_sha256,
    }

    return ExportPrepareResponse(
        manifest=manifest,
        manifest_sha256=manifest_sha256,
        unsigned_event=unsigned_event,
    )


@router.post("/export-download")
async def export_download(request: ExportDownloadRequest, pubkey: str = Depends(require_auth)):
    """
    Build and download the .eqpkg.zip package.

    Requires the manifest and a signed NOSTR event where
    content = SHA-256 of the manifest.
    """
    # Validate signed event
    event = request.signed_event

    # Verify the signed event belongs to the authenticated user
    if event.get("pubkey") != pubkey:
        raise HTTPException(
            status_code=403,
            detail="Signed event pubkey does not match authenticated user"
        )
    if "id" not in event or "sig" not in event:
        raise HTTPException(
            status_code=400,
            detail="Event must be signed (include 'id' and 'sig' fields)"
        )

    # Verify event content matches manifest hash
    manifest_json = json.dumps(request.manifest, separators=(",", ":"), sort_keys=True)
    manifest_sha256 = hashlib.sha256(manifest_json.encode()).hexdigest()

    if event.get("content") != manifest_sha256:
        raise HTTPException(
            status_code=400,
            detail="Signed event content does not match manifest hash"
        )

    manifest = request.manifest
    release = manifest.get("release", {})
    tracks = manifest.get("tracks", [])

    # Create temp directory for building the zip
    tmp_dir = Path(tempfile.mkdtemp(prefix="eqpkg-export-"))

    try:
        # Download audio files from Blossom
        tracks_dir = tmp_dir / "tracks"
        tracks_dir.mkdir()

        for track in tracks:
            audio = track.get("audio", {})
            sha256 = audio.get("sha256")
            filename = Path(audio.get("filename", "")).name

            if not sha256:
                raise HTTPException(
                    status_code=400,
                    detail=f"Track '{track['title']}' missing audio sha256"
                )

            output_path = tracks_dir / filename
            success = await download_from_blossom(sha256, output_path)
            if not success:
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to download audio for '{track['title']}' from Blossom"
                )

        # Download cover art if present
        cover_art = release.get("cover_art", {})
        cover_sha256 = cover_art.get("sha256")
        cover_filename = cover_art.get("filename", "cover.jpg")

        if cover_sha256:
            cover_path = tmp_dir / cover_filename
            await download_from_blossom(cover_sha256, cover_path)

        # Write manifest.json
        manifest_path = tmp_dir / "manifest.json"
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)

        # Write signature.json
        signature_path = tmp_dir / "signature.json"
        with open(signature_path, "w") as f:
            json.dump({
                "event": event,
                "manifest_sha256": manifest_sha256,
            }, f, indent=2)

        # Build zip in memory
        zip_buffer = BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(manifest_path, "manifest.json")
            zf.write(signature_path, "signature.json")

            if cover_sha256:
                cover_file = tmp_dir / cover_filename
                if cover_file.exists():
                    zf.write(cover_file, cover_filename)

            for track in tracks:
                audio = track.get("audio", {})
                filename = Path(audio.get("filename", "")).name
                track_file = tracks_dir / filename
                if track_file.exists():
                    zf.write(track_file, f"tracks/{filename}")

        zip_buffer.seek(0)

        # Generate download filename
        safe_title = _safe_filename(release.get("title", "release"))
        download_name = f"{safe_title}.eqpkg.zip"

        return StreamingResponse(
            zip_buffer,
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{download_name}"'
            },
        )

    finally:
        # Clean up temp directory
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)


# --- Import Endpoint ---

@router.post("/import", response_model=ImportResponse)
async def import_package(
    file: UploadFile = File(...),
    pubkey: str = Depends(require_auth),
):
    """
    Import a .eqpkg.zip package as draft tracks.

    Extracts the package, uploads audio to Blossom, encodes to HLS,
    uploads to IPFS, and creates draft entries in the database.
    """
    if not file.filename or not file.filename.endswith(".eqpkg.zip"):
        raise HTTPException(
            status_code=400,
            detail="File must be a .eqpkg.zip package"
        )

    content = await file.read()
    tmp_dir = Path(tempfile.mkdtemp(prefix="eqpkg-import-"))

    try:
        # Extract zip with path traversal protection
        zip_buffer = BytesIO(content)
        with zipfile.ZipFile(zip_buffer, "r") as zf:
            for info in zf.infolist():
                # Path traversal protection
                resolved = (tmp_dir / info.filename).resolve()
                if not str(resolved).startswith(str(tmp_dir.resolve())):
                    raise HTTPException(
                        status_code=400,
                        detail="Invalid zip: path traversal detected"
                    )
            zf.extractall(tmp_dir)

        # Parse manifest
        manifest_path = tmp_dir / "manifest.json"
        if not manifest_path.exists():
            raise HTTPException(
                status_code=400,
                detail="Invalid package: missing manifest.json"
            )

        with open(manifest_path, "r") as f:
            manifest = json.load(f)

        # Validate manifest structure
        if "release" not in manifest or "tracks" not in manifest:
            raise HTTPException(
                status_code=400,
                detail="Invalid manifest: missing 'release' or 'tracks'"
            )

        release = manifest["release"]
        tracks = manifest["tracks"]

        if not tracks:
            raise HTTPException(
                status_code=400,
                detail="Package contains no tracks"
            )

        # Optionally verify signature
        signature_path = tmp_dir / "signature.json"
        if signature_path.exists():
            with open(signature_path, "r") as f:
                sig_data = json.load(f)
            # Verify manifest hash matches
            manifest_json = json.dumps(manifest, separators=(",", ":"), sort_keys=True)
            manifest_sha256 = hashlib.sha256(manifest_json.encode()).hexdigest()
            if sig_data.get("manifest_sha256") != manifest_sha256:
                logger.warning("Package signature manifest hash mismatch - continuing anyway")

        # Import cover art if present
        blossom_cover_hash = None
        cover_art_cid = None
        import_warnings = []
        cover_art = release.get("cover_art", {})
        cover_filename = cover_art.get("filename")

        if cover_filename:
            cover_path = tmp_dir / cover_filename
            if cover_path.exists():
                try:
                    blossom_cover_hash = await upload_to_blossom(cover_path)
                except Exception as e:
                    msg = f"Blossom cover art upload failed: {e}"
                    logger.warning(msg)
                    import_warnings.append(msg)
                try:
                    cover_art_cid = await upload_file_to_ipfs(cover_path)
                except Exception as e:
                    msg = f"IPFS cover art upload failed: {e}"
                    logger.warning(msg)
                    import_warnings.append(msg)

        # Process each track
        draft_ids = []
        album_name = release.get("title", "")
        artist_name = release.get("artist", "")

        for track_data in tracks:
            audio = track_data.get("audio", {})
            audio_filename = audio.get("filename", "")

            # Find the audio file in the extracted package
            audio_path = tmp_dir / audio_filename
            if not audio_path.exists():
                # Try just the filename without directory
                audio_path = tmp_dir / "tracks" / Path(audio_filename).name
            if not audio_path.exists():
                logger.error(f"Audio file not found: {audio_filename}")
                continue

            # Verify SHA-256 if provided
            expected_sha256 = audio.get("sha256")
            if expected_sha256:
                actual_sha256 = _compute_file_sha256(audio_path)
                if actual_sha256 != expected_sha256:
                    logger.warning(
                        f"SHA-256 mismatch for {audio_filename}: "
                        f"expected {expected_sha256[:16]}..., got {actual_sha256[:16]}..."
                    )

            draft_id = str(uuid.uuid4())
            track_dir = UPLOAD_DIR / draft_id
            track_dir.mkdir(parents=True, exist_ok=True)

            try:
                # Upload original to Blossom
                blossom_audio_hash = None
                try:
                    blossom_audio_hash = await upload_to_blossom(audio_path)
                except Exception as e:
                    logger.warning(f"Blossom upload failed for {audio_filename}: {e}")

                # Get duration
                duration = track_data.get("duration", 0)
                if duration == 0:
                    duration = await get_audio_duration(audio_path)

                # Encode to HLS
                hls_dir = track_dir / "hls"
                preview_dir = track_dir / "preview"
                await encode_to_hls(
                    input_path=audio_path,
                    output_dir=hls_dir,
                    preview_dir=preview_dir,
                    preview_duration=30,
                )

                # Upload to IPFS
                manifest_cid = await upload_directory_to_ipfs(hls_dir)
                preview_cid = await upload_directory_to_ipfs(preview_dir)

                # Determine original filename
                original_filename = audio.get("original_filename") or Path(audio_filename).name

                # Create draft
                draft = DraftTrack(
                    id=draft_id,
                    artist_pubkey=pubkey,
                    title=track_data.get("title", "Untitled"),
                    artist_name=artist_name,
                    album=album_name if album_name else None,
                    genre=track_data.get("genre") or release.get("genre") or None,
                    price_amount=track_data.get("price_amount", 0.05),
                    price_currency=track_data.get("price_currency", "USD"),
                    release_date=release.get("release_date") or None,
                    release_type=release.get("release_type", "album"),
                    track_number=track_data.get("track_number"),
                    cover_art_cid=cover_art_cid,
                    ipfs_manifest_cid=manifest_cid,
                    ipfs_preview_cid=preview_cid,
                    duration=duration,
                    blossom_audio_hash=blossom_audio_hash,
                    blossom_cover_hash=blossom_cover_hash,
                    original_filename=original_filename,
                    status="draft",
                )

                await create_draft(draft)
                draft_ids.append(draft_id)
                logger.info(f"Imported track: {track_data.get('title')} -> {draft_id}")

            except Exception as e:
                logger.error(f"Failed to import track {audio_filename}: {e}")
                continue

        if not draft_ids:
            raise HTTPException(
                status_code=500,
                detail="Failed to import any tracks from the package"
            )

        return ImportResponse(
            draft_ids=draft_ids,
            track_count=len(draft_ids),
            album=album_name,
            artist=artist_name,
            warnings=import_warnings,
        )

    finally:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)


# --- Helper Functions ---

def _safe_filename(name: str) -> str:
    """Convert a name to a safe filename."""
    safe = name.lower().strip()
    safe = safe.replace(" ", "-")
    # Keep only alphanumeric, hyphens, underscores
    safe = "".join(c for c in safe if c.isalnum() or c in "-_")
    return safe[:60] or "untitled"


def _ext_from_filename(filename: Optional[str]) -> str:
    """Extract extension from a filename, defaulting to .mp3."""
    if filename:
        ext = Path(filename).suffix
        if ext:
            return ext
    return ".mp3"


def _get_tag(event: dict, tag_name: str) -> Optional[str]:
    """Get the value of a tag from a NOSTR event."""
    for tag in event.get("tags", []):
        if len(tag) >= 2 and tag[0] == tag_name:
            return tag[1]
    return None


def _compute_file_sha256(file_path: Path) -> str:
    """Compute SHA-256 hash of a file."""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()
