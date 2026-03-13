# Release Deletion

## Context
Artists have no way to delete released tracks. Once published to NOSTR (Kind 30050), content persists permanently on the relay, IPFS, and Blossom. Artists need to be able to remove releases — whether to take down content, fix mistakes, or manage their catalogue. The relay already supports NIP-09 (Kind 5 deletion events) and the peer syncer forwards them to peers. What's missing is the UI, the client-side Kind 5 signing, and server-side storage cleanup.

## Architecture

**Deletion flow:**
1. Artist clicks "Delete Release" in admin UI → confirms
2. Browser signs a Kind 5 deletion event referencing all track event IDs (`e` tags)
3. Kind 5 published to relay via WebSocket → relay deletes events + denormalized data
4. Peer syncer forwards Kind 5 to peer relays (existing behaviour)
5. Browser calls orchestrator cleanup endpoint → unpins IPFS CIDs + deletes Blossom blobs
6. Redirect to releases.html

**Non-custodial**: Browser signs the Kind 5 event (server never has private key). Storage cleanup is a separate authenticated API call.

## Files to Modify

### 1. `content_node/orchestrator/api/services/ipfs.py` — Add `unpin_cid()`

Add function mirroring the existing `pin_cid()` pattern:

```python
async def unpin_cid(cid: str) -> bool:
    """Unpin a CID from IPFS. Content will be garbage collected."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            response = await client.post(
                f"{IPFS_API_URL}/api/v0/pin/rm",
                params={"arg": cid}
            )
            if response.status_code != 200:
                logger.warning(f"IPFS unpin failed for {cid[:16]}: {response.text}")
                return False
            return True
        except httpx.RequestError as e:
            logger.warning(f"IPFS unpin error for {cid[:16]}: {e}")
            return False
```

### 2. `content_node/orchestrator/api/services/blossom.py` — Add `delete_from_blossom()`

Add delete auth (BUD-03 with `["t", "delete"]`) and delete function:

```python
def _create_delete_auth(sha256_hash: str) -> str:
    """Create a BUD-03 delete authorization header."""
    # Same pattern as _create_upload_auth but with ["t", "delete"] tag
    # Kind 24242, tags: [["t", "delete"], ["x", sha256_hash], ["expiration", ...]]

async def delete_from_blossom(sha256_hash: str) -> bool:
    """Delete a blob from Blossom with BUD-03 authentication."""
    # DELETE /{sha256_hash} with Authorization: Nostr <base64 event>
```

### 3. `content_node/orchestrator/api/routers/tracks.py` — Add `POST /api/tracks/cleanup`

New endpoint for storage cleanup after Kind 5 is published:

```python
class TrackCleanupItem(BaseModel):
    ipfs_manifest_cid: str
    ipfs_preview_cid: str
    blossom_audio_hash: Optional[str] = None
    cover_art_cid: Optional[str] = None       # Only set if safe to delete
    blossom_cover_hash: Optional[str] = None   # Only set if safe to delete

class CleanupRequest(BaseModel):
    tracks: list[TrackCleanupItem]

@router.post("/cleanup")
async def cleanup_deleted_tracks(
    request: CleanupRequest,
    pubkey: str = Depends(require_auth),
):
```

For each track:
- Unpin `ipfs_manifest_cid` and `ipfs_preview_cid`
- Delete `blossom_audio_hash` from Blossom
- If `cover_art_cid` provided: unpin from IPFS
- If `blossom_cover_hash` provided: delete from Blossom
- Best-effort — log failures but don't block the response
- Also clean up any `mark_released` draft rows in SQLite matching these tracks

**Cover art safety**: The client determines whether cover art is shared with other releases (it already has all tracks loaded). If shared, the client omits `cover_art_cid` and `blossom_cover_hash` from the request.

### 4. `content_node/orchestrator/edit-release.html` — Delete button + Kind 5 flow

**Changes:**

a) **Add `blossom_audio_hash` to `parseTrackEvent()`** (line ~1043):
Currently missing. Add: `blossomAudioHash: tags.blossom_audio_hash || ''`

b) **Add Delete button for released tracks** (line ~1163):
The `renderEditForm()` currently only shows Delete for `isDraftMode`. Add a Delete button in the else branch (released mode) alongside existing buttons.

c) **Add `publishToRelay()` helper**:
Opens WebSocket to `/relay`, sends `["EVENT", signedEvent]`, waits for `["OK", ...]` response.

d) **Add `deleteRelease()` function**:
1. Confirm dialog: "Permanently delete this release? This removes it from NOSTR, deletes audio files, and cannot be undone."
2. Determine cover art safety: check all artist tracks, see if any non-deleted track shares the same `coverArtCid` or `blossomCoverHash`
3. Sign Kind 5 event: `kind: 5`, `tags: [["app", "Equaliser"], ["e", eventId1], ["e", eventId2], ...]`, `content: "Release deleted by artist"`
4. Publish Kind 5 to relay via `publishToRelay()`
5. Call `POST /api/tracks/cleanup` via `authFetch()` with track content references
6. Show success notification, redirect to releases.html

**Track event IDs**: The `editingTracks` array already has `eventId` on each track (from `parseTrackEvent()`). For album releases, all tracks in the album are deleted in one Kind 5 event.

## What We're NOT Doing

- **Relay `a` tag deletion**: HandleDeletion() only processes `e` tags. We use concrete event IDs (which the UI already has), so `a` tag support isn't needed for this feature.
- **Delete from releases.html list**: Only from edit-release.html for now. Keeps the scope focused — the edit page already has the track data loaded.
- **Draft cleanup of IPFS/Blossom**: Existing draft deletion doesn't clean up storage. That's a separate concern.

## Verification

1. Start node: `./tools/start-node.sh -d`
2. Import test data: `./tools/import-artist.sh ./packages/*.eqpkg.zip`
3. Open admin UI → Releases → click a released track → Edit
4. Verify Delete button appears for released tracks
5. Click Delete → confirm → verify:
   - Kind 5 event published (check relay: `./tools/nostr-browse.sh kind 5`)
   - Track no longer appears in releases list
   - IPFS CIDs unpinned: `docker exec equaliser-ipfs ipfs pin ls | grep <cid>` returns nothing
   - Blossom blob deleted: `curl -I http://localhost/blossom/<hash>` returns 404
6. Check peer relay receives the Kind 5 (if peer sync is configured)
7. Test with album (multiple tracks) — all tracks should be deleted in one operation
8. Test cover art shared across releases — cover art should NOT be deleted if another release uses it
