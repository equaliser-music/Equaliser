# Playlists

User playlists built on NIP-51 (Kind 30001) parameterized replaceable events. Users can create, edit, share, and follow playlists. Non-logged-in users can view public playlists and play 30s previews.

## NOSTR Event Design

### Playlist Event (Kind 30001)

**Public playlist:**
```javascript
{
  kind: 30001,
  content: "",
  tags: [
    ["d", "playlist-1709654321"],      // unique identifier
    ["app", "Equaliser"],
    ["title", "My Chill Mix"],
    ["description", "Relaxing tracks"],
    ["image", "/blossom/{hash}"],       // optional cover image
    ["visibility", "public"],
    ["e", "track_event_id_1"],          // track references (Kind 30050 event IDs)
    ["e", "track_event_id_2"],
    ["e", "track_event_id_3"]
  ]
}
```

**Private playlist:** Track references encrypted in `content` field (NIP-04 to self). Only metadata tags are public.
```javascript
{
  kind: 30001,
  content: "<NIP-04 encrypted JSON: [{e: 'track_id_1'}, {e: 'track_id_2'}]>",
  tags: [
    ["d", "playlist-1709654321"],
    ["app", "Equaliser"],
    ["title", "My Private Mix"],
    ["visibility", "private"]
  ]
}
```

### Followed Playlists (Kind 30001, special d-tag)

A single replaceable event storing all playlist follows:
```javascript
{
  kind: 30001,
  content: "",
  tags: [
    ["d", "eq:followed-playlists"],
    ["app", "Equaliser"],
    ["a", "30001:pubkey1:playlist-123"],  // NIP-33 address references
    ["a", "30001:pubkey2:playlist-456"]
  ]
}
```

### Share Playlist Post (Kind 1)

```javascript
{
  kind: 1,
  content: "Check out my playlist \"Chill Vibes\" - 12 tracks of pure relaxation\n\nequaliser:playlist:npub1.../playlist-123",
  tags: [
    ["app", "Equaliser"],
    ["content-type", "playlist-share"],
    ["a", "30001:pubkey:playlist-123"]
  ]
}
```

## Architecture

### New Files

| File | Purpose |
|------|---------|
| `client/js/nostr-playlists.js` | NOSTR playlist CRUD module |
| `client/library.html` | Library page — grid of user's playlists + followed playlists |
| `client/js/pages/library.js` | Library page module |
| `client/playlist.html` | Playlist detail page — view/play/edit a single playlist |
| `client/js/pages/playlist.js` | Playlist page module |

### Modified Files

| File | Change |
|------|--------|
| `client/app.html` | Add `<script src="/js/nostr-playlists.js">` after nostr-dm.js |
| `client/js/router.js` | Add `'library'` and `'playlist'` to `_pageModules` |
| `client/js/sidebar.js` | Enable Library link (remove `disabled`, set `href="/library.html"`) |
| `content_node/web/nginx.conf` | Add `library\|playlist` to SPA route regex |
| `client/js/pages/home.js` | Add "+" playlist button to track rows |
| `client/js/pages/artist.js` | Add "+" playlist button to tracklist items |

## NOSTR Playlist Module (`nostr-playlists.js`)

Follows the pattern of `nostr-social.js` and `nostr-dm.js`.

### API Surface

```javascript
const NostrPlaylists = {
  // CRUD
  createPlaylist(title, trackEventIds, options)   // → signedEvent
  updatePlaylist(dTag, title, trackEventIds, options) // → signedEvent
  deletePlaylist(dTag)                             // → signedEvent (Kind 5 deletion)

  // Queries
  fetchMyPlaylists()                // → [{dTag, title, description, visibility, trackIds, image, createdAt}]
  fetchPlaylist(pubkey, dTag)       // → playlist object
  fetchPublicPlaylists(pubkey)      // → playlists for a given user
  resolveTrackEvents(trackEventIds) // → track objects with full metadata

  // Privacy
  encryptTrackList(trackIds)        // → encrypted content string
  decryptTrackList(content)         // → trackIds array

  // Following
  fetchFollowedPlaylists()          // → [{pubkey, dTag}]
  followPlaylist(pubkey, dTag)      // → signedEvent
  unfollowPlaylist(pubkey, dTag)    // → signedEvent

  // Sharing
  sharePlaylistToFeed(playlist, message) // → signedEvent (Kind 1)
}
```

### Key Implementation Details

- **`fetchMyPlaylists()`**: Query `{kinds: [30001], authors: [myPubkey]}`, filter client-side for `["app", "Equaliser"]` tag (relay only indexes single-letter tags)
- **`resolveTrackEvents()`**: Query `{kinds: [30050], ids: [trackId1, trackId2, ...]}` to get full track metadata for playback
- **Private playlists**: Use `NostrDM.encrypt(privateKey, myPubkey, JSON.stringify(trackIds))` to encrypt to self
- **Decryption**: Use `NostrDM.decrypt(privateKey, myPubkey, content)` when loading own private playlists
- **`updatePlaylist()`**: Since Kind 30001 is parameterized replaceable, publishing a new event with the same `d` tag replaces the old one

## Library Page

### Structure

```
.main-content
  h1 "Library"
  .library-tabs
    button "My Playlists" (active)
    button "Following"
  .library-toolbar
    button "+ New Playlist"
  .playlist-grid
    .playlist-card * N  (links to /playlist.html?pubkey=...&d=...)
      .playlist-card-cover (mosaic of first 4 track covers or placeholder)
      .playlist-card-info
        .playlist-card-title
        .playlist-card-meta ("12 tracks · Private")
      .playlist-card-link (copy link icon)
```

### Behaviour

- **"My Playlists" tab**: Fetches own playlists via `NostrPlaylists.fetchMyPlaylists()`, renders grid of cards
- **"Following" tab**: Fetches followed playlists via `NostrPlaylists.fetchFollowedPlaylists()`, resolves each, renders grid
- **Create playlist**: "+ New Playlist" button opens inline form or modal (title, description, visibility). Creates empty playlist, navigates to its playlist page
- **Card click**: Navigates to `/playlist.html?pubkey={hex}&d={dTag}`
- **Copy link icon**: Copies shareable URL to clipboard with "Copied!" toast

## Playlist Detail Page

Shareable URL: `/playlist.html?pubkey=...&d=...`

### Works Without Login

Non-authenticated users can view any public playlist and play preview CIDs (30s previews). Logged-in users get full track playback. This mirrors the existing player behaviour where `previewCid` vs `manifestCid` is chosen based on `SessionManager.hasSession()`. Owner-only actions (Edit, Delete, Share, Remove track) and login-required actions (Follow) are hidden when not logged in.

### Structure

```
.main-content
  .playlist-header
    .playlist-cover (mosaic of first 4 track covers or gradient placeholder)
    .playlist-info
      h1 playlist title
      .playlist-creator (link to user profile)
      .playlist-meta ("12 tracks · 45 min · Public")
      .playlist-description
    .playlist-actions
      button "Play All"
      button "Shuffle"
      button "Share" (owner only — posts to feed)
      button "Copy Link" (available to anyone)
      button "Edit" (owner only)
      button "Delete" (owner only)
      button "Follow" / "Unfollow" (non-owner, logged in, public playlists only)
  .playlist-tracks
    .playlist-track-item * N
      .track-number
      .track-cover (48px)
      .track-info (title, artist as link to profile)
      .track-duration
      .track-remove (owner only, X button on hover)
```

### Page Module (`js/pages/playlist.js`)

- **`init({pubkey, d})`**: Loads playlist event, resolves track events, renders. Works regardless of login state.
- **Auth-aware rendering**: Checks `SessionManager.hasSession()` to determine:
  - **Logged in**: Show all actions; Play All/Shuffle uses `manifestCid` (full tracks); show Follow button for non-owner playlists
  - **Not logged in**: Show only Play All, Shuffle, Copy Link; uses `previewCid` (30s previews); hide Edit/Delete/Share/Follow/Remove
- **Owner detection**: Compare playlist pubkey to `SessionManager.getSession()?.publicKey`
- **Play All**: Resolves all tracks, calls `EqualiserPlayer.setPlaylist(tracks, 0)`
- **Shuffle**: Same as Play All but randomises track order
- **Edit**: Inline editing of title, description. Visibility toggle re-saves with encrypted/decrypted content
- **Delete**: Kind 5 deletion event, navigate back to library
- **Remove track**: Removes `e` tag, saves via `updatePlaylist()`
- **Drag to reorder**: HTML5 drag API on track items, saves new order
- **Follow/Unfollow**: Updates `eq:followed-playlists` Kind 30001 event
- **Share**: Opens compose modal, posts Kind 1 with playlist link
- **Copy Link**: Copies playlist URL to clipboard with "Copied!" toast

## Add-to-Playlist UI

A reusable dropdown/popover component that appears when clicking the "+" button on any track.

### Structure

```
.eq-playlist-picker (positioned dropdown)
  .eq-playlist-picker-header "Add to playlist"
  .eq-playlist-picker-list (scrollable)
    .eq-playlist-picker-item * N
      checkbox (checked if track already in playlist)
      playlist title
  .eq-playlist-picker-create
    button "+ Create new playlist"
```

### Behaviour

- Click "+" on a track to show the picker near the button
- Lists all user's playlists with checkboxes
- Tick/untick to add/remove track from playlist (immediately saves)
- "Create new playlist" with inline title input creates playlist with the track
- Click outside to dismiss
- For albums: adds all tracks in the album

### Integration Points

- `home.js`: Add `+` button to track rows after price
- `artist.js`: Add `+` button to tracklist items

## Public/Private Visibility

### Visibility Toggle

On the playlist detail page, a toggle switch (Public/Private). Changing visibility:

- **To private**: Re-saves playlist with track IDs encrypted in `content` (NIP-04 to self), removes `e` tags from public tags
- **To public**: Decrypts content, moves track IDs back to `e` tags, clears content

### Sharing to Feed

Share button on playlist detail page opens a compose modal pre-filled with:
```
Check out my playlist "[title]" - [N] tracks

equaliser:playlist:[npub]/[d-tag]
```
Posts as Kind 1 with `["content-type", "playlist-share"]` and `["a", "30001:pubkey:d-tag"]` tags.

### Feed Rendering

In `social.js`, detect `content-type: playlist-share` posts and render a rich card with:
- Playlist title
- Track count
- "View Playlist" link navigating to `/playlist.html?pubkey=...&d=...`
- "Play" button that resolves tracks and plays in the player

## Following Playlists

- **Follow button**: On any public playlist detail page (when it's not your own and you're logged in)
- **Follow action**: Updates the user's `eq:followed-playlists` Kind 30001 event with an `["a", "30001:pubkey:d-tag"]` reference
- **Library "Following" tab**: Fetches followed playlist references, resolves each to get title/track count, renders as cards. Read-only (no edit/delete, but can play and unfollow)

## Caching

Playlist data is cached in-memory inside `nostr-playlists.js` to avoid redundant relay queries during SPA navigation. The SPA shell (`app.html`) persists across page navigations, so these caches survive until a full page refresh or session end.

### Cache Layers

| Cache | Key | TTL | Rationale |
|-------|-----|-----|-----------|
| `_trackCache` | `eventId` | **No expiry** | Kind 30050 events are immutable (published once, never modified) |
| `_playlistCache` | `${pubkey}:${dTag}` | 60s | Playlists can be edited; short TTL ensures freshness |
| `_myPlaylistsCache` | single entry | 60s | User's own playlist list; may change via create/edit/delete |

### How It Works

- **`fetchMyPlaylists()`**: Returns cached data if within 60s TTL, otherwise queries relay and caches
- **`fetchPlaylist(pubkey, dTag)`**: Per-playlist cache by `pubkey:dTag` key with 60s TTL
- **`resolveTrackEvents(trackEventIds)`**: Splits IDs into cached hits and uncached misses. Only queries relay for misses, caches results permanently
- **Write operations** (`createPlaylist`, `updatePlaylist`, `deletePlaylist`): Invalidate `_myPlaylistsCache` and the specific `_playlistCache` entry so the next fetch returns fresh data
- **`invalidateCache()`**: Clears all playlist caches but preserves `_trackCache` (tracks are immutable)

### Followed Playlist Loading

The library page loads followed playlists in parallel using `Promise.all()` rather than sequentially, so all followed playlists are fetched concurrently. Combined with caching, revisiting the library page is near-instant.

## Additional Features

1. **Auto-generated cover art**: Playlist cards show a 2x2 mosaic grid of the first 4 unique track cover arts. Falls back to a gradient with music note icon.
2. **Playlist duration**: Show total duration on playlist cards and detail view (sum of resolved track durations).
3. **"Liked Tracks" playlist**: Auto-populate from Kind 7 reactions on Kind 30050 events. Show as a special non-editable playlist on the library page.
