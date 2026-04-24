"""
Draft management router.

Handles:
- CRUD operations for draft tracks
- Release preparation (returns unsigned NOSTR events)
- Album release (batch release all tracks in an album)
"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel

from dependencies import require_auth, require_role, RoleContext
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
    ctx: RoleContext = Depends(require_role),
):
    """List drafts for an artist. Caller must be able to manage that artist."""
    if not ctx.can_manage(pubkey):
        raise HTTPException(status_code=403, detail="Cannot access this artist's drafts")
    drafts = await list_drafts(pubkey, status=status, album=album)
    return DraftListResponse(
        drafts=[DraftResponse.from_draft(d) for d in drafts],
        count=len(drafts)
    )


@router.get("/{draft_id}", response_model=DraftResponse)
async def get_single_draft(
    draft_id: str,
    ctx: RoleContext = Depends(require_role),
):
    """Get a single draft by ID."""
    draft = await get_draft(draft_id)
    if not draft:
        raise HTTPException(status_code=404, detail="Draft not found")
    if not ctx.can_manage(draft.artist_pubkey):
        raise HTTPException(status_code=403, detail="Cannot access this draft")
    return DraftResponse.from_draft(draft)


@router.patch("/{draft_id}", response_model=DraftResponse)
async def update_single_draft(
    draft_id: str,
    updates: DraftUpdateRequest,
    ctx: RoleContext = Depends(require_role),
):
    """Update a draft's metadata."""
    existing = await get_draft(draft_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Draft not found")
    if not ctx.can_manage(existing.artist_pubkey):
        raise HTTPException(status_code=403, detail="Cannot update this draft")

    if existing.status == "released":
        raise HTTPException(status_code=400, detail="Cannot update released track")

    # Apply updates (exclude_unset=True: only include fields the client sent,
    # but DO allow null values — e.g. album: null to clear album when switching to single)
    update_dict = updates.model_dump(exclude_unset=True)
    updated = await update_draft(draft_id, existing.artist_pubkey, update_dict)

    if not updated:
        raise HTTPException(status_code=500, detail="Failed to update draft")

    return DraftResponse.from_draft(updated)


@router.delete("/{draft_id}")
async def delete_single_draft(
    draft_id: str,
    ctx: RoleContext = Depends(require_role),
):
    """Delete a draft."""
    existing = await get_draft(draft_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Draft not found")
    if not ctx.can_manage(existing.artist_pubkey):
        raise HTTPException(status_code=403, detail="Cannot delete this draft")

    deleted = await delete_draft(draft_id, existing.artist_pubkey)
    if not deleted:
        raise HTTPException(
            status_code=404,
            detail="Draft not found or already released"
        )
    return {"success": True, "deleted_id": draft_id}


@router.post("/{draft_id}/release", response_model=ReleaseResponse)
async def prepare_release(
    draft_id: str,
    ctx: RoleContext = Depends(require_role),
):
    """
    Prepare a draft for release by generating an unsigned NOSTR event.

    Returns the event for client-side signing. After signing, call
    POST /api/tracks/publish with the signed event and draft_id.
    """
    draft = await get_draft(draft_id)
    if not draft:
        raise HTTPException(status_code=404, detail="Draft not found")
    if not ctx.can_manage(draft.artist_pubkey):
        raise HTTPException(status_code=403, detail="Cannot release this draft")

    if draft.status == "released":
        raise HTTPException(status_code=400, detail="Track already released")

    # Sign as the artist (the draft's owner), not necessarily the caller.
    # For custodial label flows the label may release on behalf of an artist.
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
        pubkey=draft.artist_pubkey,
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
async def prepare_album_release(
    request: AlbumReleaseRequest,
    artist_pubkey: str = Query(..., description="Artist whose album to release"),
    ctx: RoleContext = Depends(require_role),
):
    """
    Prepare all tracks in an album for release.

    Returns unsigned events for all tracks. Client should sign each
    and publish via POST /api/tracks/publish.
    """
    if not ctx.can_manage(artist_pubkey):
        raise HTTPException(status_code=403, detail="Cannot release this artist's album")

    drafts = await get_album_drafts(request.album, artist_pubkey)

    if not drafts:
        raise HTTPException(
            status_code=404,
            detail=f"No draft tracks found for album '{request.album}'"
        )

    tracks = []
    for i, draft in enumerate(drafts, start=1):
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
            pubkey=artist_pubkey,
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
    ctx: RoleContext = Depends(require_role),
):
    """Mark a draft as released after successful NOSTR publication."""
    existing = await get_draft(draft_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Draft not found")
    if not ctx.can_manage(existing.artist_pubkey):
        raise HTTPException(status_code=403, detail="Cannot mark this draft released")

    draft = await mark_released(draft_id, nostr_event_id, nostr_d_tag)
    if not draft:
        raise HTTPException(status_code=404, detail="Draft not found")

    return {"success": True, "draft_id": draft_id, "status": "released"}
