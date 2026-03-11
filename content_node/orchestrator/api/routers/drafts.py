"""
Draft management router.

Handles:
- CRUD operations for draft tracks
- Release preparation (returns unsigned NOSTR events)
- Album release (batch release all tracks in an album)
"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from services.database import (
    DraftTrack,
    get_draft,
    list_drafts,
    update_draft,
    delete_draft,
    get_album_drafts,
    mark_released,
)
from services.nostr import create_track_event
from services.blossom import get_blob_url

router = APIRouter()


class DraftResponse(BaseModel):
    """Draft track response model."""
    id: str
    artist_pubkey: str
    title: str
    artist_name: str
    album: Optional[str]
    genre: Optional[str]
    price_amount: float
    price_currency: str
    release_date: Optional[str]
    release_type: str
    track_number: Optional[int]
    cover_art_cid: Optional[str]
    ipfs_manifest_cid: str
    ipfs_preview_cid: str
    duration: int
    blossom_audio_hash: Optional[str] = None
    blossom_cover_hash: Optional[str] = None
    original_filename: Optional[str] = None
    status: str
    nostr_event_id: Optional[str]
    nostr_d_tag: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]
    released_at: Optional[str]

    @classmethod
    def from_draft(cls, draft: DraftTrack) -> "DraftResponse":
        return cls(**draft.to_dict())


class DraftListResponse(BaseModel):
    """Response for listing drafts."""
    drafts: list[DraftResponse]
    count: int


class DraftUpdateRequest(BaseModel):
    """Request to update draft metadata."""
    title: Optional[str] = None
    artist_name: Optional[str] = None
    album: Optional[str] = None
    genre: Optional[str] = None
    price_amount: Optional[float] = None
    price_currency: Optional[str] = None
    release_date: Optional[str] = None
    release_type: Optional[str] = None
    track_number: Optional[int] = None
    cover_art_cid: Optional[str] = None
    blossom_cover_hash: Optional[str] = None


class ReleaseResponse(BaseModel):
    """Response containing unsigned NOSTR event for release."""
    draft_id: str
    unsigned_event: dict


class AlbumReleaseRequest(BaseModel):
    """Request to release all tracks in an album."""
    album: str
    pubkey: str


class AlbumReleaseResponse(BaseModel):
    """Response containing unsigned events for all album tracks."""
    album: str
    tracks: list[ReleaseResponse]
    count: int


@router.get("", response_model=DraftListResponse)
async def get_drafts(
    pubkey: str = Query(..., description="Artist public key"),
    status: Optional[str] = Query(None, description="Filter by status (draft, released)"),
    album: Optional[str] = Query(None, description="Filter by album name"),
):
    """List all drafts for an artist."""
    drafts = await list_drafts(pubkey, status=status, album=album)
    return DraftListResponse(
        drafts=[DraftResponse.from_draft(d) for d in drafts],
        count=len(drafts)
    )


@router.get("/{draft_id}", response_model=DraftResponse)
async def get_single_draft(
    draft_id: str,
    pubkey: str = Query(..., description="Artist public key"),
):
    """Get a single draft by ID."""
    draft = await get_draft(draft_id, pubkey)
    if not draft:
        raise HTTPException(status_code=404, detail="Draft not found")
    return DraftResponse.from_draft(draft)


@router.patch("/{draft_id}", response_model=DraftResponse)
async def update_single_draft(
    draft_id: str,
    updates: DraftUpdateRequest,
    pubkey: str = Query(..., description="Artist public key"),
):
    """Update a draft's metadata."""
    # Check draft exists
    existing = await get_draft(draft_id, pubkey)
    if not existing:
        raise HTTPException(status_code=404, detail="Draft not found")

    if existing.status == "released":
        raise HTTPException(status_code=400, detail="Cannot update released track")

    # Apply updates
    update_dict = {k: v for k, v in updates.model_dump().items() if v is not None}
    updated = await update_draft(draft_id, pubkey, update_dict)

    if not updated:
        raise HTTPException(status_code=500, detail="Failed to update draft")

    return DraftResponse.from_draft(updated)


@router.delete("/{draft_id}")
async def delete_single_draft(
    draft_id: str,
    pubkey: str = Query(..., description="Artist public key"),
):
    """Delete a draft."""
    deleted = await delete_draft(draft_id, pubkey)
    if not deleted:
        raise HTTPException(
            status_code=404,
            detail="Draft not found or already released"
        )
    return {"success": True, "deleted_id": draft_id}


@router.post("/{draft_id}/release", response_model=ReleaseResponse)
async def prepare_release(
    draft_id: str,
    pubkey: str = Query(..., description="Artist public key"),
):
    """
    Prepare a draft for release by generating an unsigned NOSTR event.

    Returns the event for client-side signing. After signing, call
    POST /api/tracks/publish with the signed event and draft_id.
    """
    draft = await get_draft(draft_id, pubkey)
    if not draft:
        raise HTTPException(status_code=404, detail="Draft not found")

    if draft.status == "released":
        raise HTTPException(status_code=400, detail="Track already released")

    # Generate unsigned NOSTR event
    unsigned_event = create_track_event(
        title=draft.title,
        artist=draft.artist_name,
        album=draft.album,
        genre=draft.genre,
        duration=draft.duration,
        manifest_cid=draft.ipfs_manifest_cid,
        preview_cid=draft.ipfs_preview_cid,
        price_amount=draft.price_amount,
        price_currency=draft.price_currency,
        release_date=draft.release_date,
        pubkey=pubkey,
        release_type=draft.release_type,
        cover_art_cid=draft.cover_art_cid,
        track_number=draft.track_number,
        blossom_audio_hash=draft.blossom_audio_hash,
        blossom_cover_hash=draft.blossom_cover_hash,
        blossom_cover_url=get_blob_url(draft.blossom_cover_hash) if draft.blossom_cover_hash else None,
    )

    return ReleaseResponse(
        draft_id=draft_id,
        unsigned_event=unsigned_event
    )


@router.post("/release-album", response_model=AlbumReleaseResponse)
async def prepare_album_release(request: AlbumReleaseRequest):
    """
    Prepare all tracks in an album for release.

    Returns unsigned events for all tracks. Client should sign each
    and publish via POST /api/tracks/publish.
    """
    drafts = await get_album_drafts(request.album, request.pubkey)

    if not drafts:
        raise HTTPException(
            status_code=404,
            detail=f"No draft tracks found for album '{request.album}'"
        )

    tracks = []
    for i, draft in enumerate(drafts, start=1):
        # Use existing track number or assign based on position
        track_num = draft.track_number if draft.track_number else i

        unsigned_event = create_track_event(
            title=draft.title,
            artist=draft.artist_name,
            album=draft.album,
            genre=draft.genre,
            duration=draft.duration,
            manifest_cid=draft.ipfs_manifest_cid,
            preview_cid=draft.ipfs_preview_cid,
            price_amount=draft.price_amount,
            price_currency=draft.price_currency,
            release_date=draft.release_date,
            pubkey=request.pubkey,
            release_type=draft.release_type,
            cover_art_cid=draft.cover_art_cid,
            track_number=track_num,
            blossom_audio_hash=draft.blossom_audio_hash,
            blossom_cover_hash=draft.blossom_cover_hash,
            blossom_cover_url=get_blob_url(draft.blossom_cover_hash) if draft.blossom_cover_hash else None,
        )

        tracks.append(ReleaseResponse(
            draft_id=draft.id,
            unsigned_event=unsigned_event
        ))

    return AlbumReleaseResponse(
        album=request.album,
        tracks=tracks,
        count=len(tracks)
    )


@router.post("/{draft_id}/mark-released")
async def mark_draft_released(
    draft_id: str,
    nostr_event_id: str = Query(..., description="NOSTR event ID after publish"),
    nostr_d_tag: str = Query(..., description="NOSTR d-tag from event"),
):
    """
    Mark a draft as released after successful NOSTR publication.

    Called after client publishes the signed event.
    """
    draft = await mark_released(draft_id, nostr_event_id, nostr_d_tag)
    if not draft:
        raise HTTPException(status_code=404, detail="Draft not found")

    return {"success": True, "draft_id": draft_id, "status": "released"}
