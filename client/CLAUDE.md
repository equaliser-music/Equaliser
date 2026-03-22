# Client (Fan-Facing UI)

SPA for listeners/fans. Served at `/` by nginx. No build step — vanilla JS + HTML.

## Architecture

`app.html` is the SPA shell. It loads the sidebar, player, and router, which dynamically loads page HTML into `#page-content`. Three standalone pages bypass the shell: `index.html` (landing), `login.html`, `onboarding.html`.

Script load order in app.html:
nostr-tools (CDN) → hls.js (CDN) → session.js → sidebar.js → cache-api.js → nostr-social.js → [global registrations] → nostr-dm.js → nostr-playlists.js → player.js → router.js

After nostr-social.js loads, app.html registers global onclick handlers: `expandReleaseCard`, `playFromReleaseCard`, `addReleaseToLibrary`, `addPlaylistToLibrary` (used by dynamically rendered HTML in feed cards).

## Core Modules (js/)

| Module | Purpose | Key Details |
|--------|---------|-------------|
| `session.js` | Session management | nsec or NIP-07 login. Keys in sessionStorage. Auto-adds `["app", "Equaliser"]` tag to all signed events. 30-min idle timeout, multi-tab logout via BroadcastChannel. Auto-registers pubkey with relay on login. API: `init()`, `signEvent()`, `getSession()`, `hasSession()`, `logout()` |
| `cache-api.js` | Cache REST API client | Fetches data from `/api/cache/` (relay REST API). 3s timeout, returns null on failure for graceful fallback. API: `queryEvents(filter)`, `getProfiles(pubkeys)`, `getUserFollows(pubkey)`, `getUserFeed(pubkey, limit)`, `getArtists()`, `getTracksByArtist(pubkey)`, `getRecentTracks(limit)`, `getAlbumsByArtist(pubkey)` |
| `nostr-social.js` | Relay communication + social UI | Fetch/publish events, profile caching, relay config. **REST-first**: `_queryRelay()` uses cache API for local relay reads, skips external relay WebSocket entirely when cache is available. WebSocket only for publishing. API: `fetchNotes()`, `fetchProfiles()`, `fetchContactList()`, `fetchReactions()`, `publishEvent()`, `loadUserRelays()`, `queryRelays()`. Utilities: `escapeHtml()`, `relativeTime()`, `linkifyContent()`, `isEqualiserEvent()`. Rich feed: `generateLinkPreviews()` (YouTube + inline images), `generateReleaseAnnouncementCard()`, `expandReleaseCard()`, `playFromReleaseCard()`, `addReleaseToLibrary()`, `addPlaylistToLibrary()`. Social UI: `showFollowListModal()` |
| `nostr-dm.js` | Direct messages (NIP-04) | Kind 4 encrypted DMs. Supports nsec and NIP-07 extension. API: `encrypt()`, `decrypt()`, `fetchAllDMs()`, `groupConversations()`, `sendDM()`, `canDM()` |
| `nostr-playlists.js` | Playlist CRUD (NIP-51) | Kind 30001. Public/private playlists (private encrypts via NIP-04 to self). 60s cache TTL. API: `createPlaylist()`, `updatePlaylist()`, `deletePlaylist()`, `fetchMyPlaylists()`, `addTrackToPlaylist()`, `followPlaylist()` |
| `sidebar.js` | Navigation sidebar | Renders nav links, user profile card, login/logout. Fetches Kind 0 for display. API: `init()`, `updateUserDisplay()` |
| `player.js` | HLS audio player | Persistent player bar. HLS.js for streaming. API: `setPlaylist(tracks, index)`. Queue management, prev/next, progress, volume |
| `router.js` | SPA router | Intercepts links, loads page HTML + JS into shell. Pages register via `window.EqualiserPages[name]` with `init(params)` and `cleanup()` |

## Page Modules (js/pages/)

Each is an IIFE registering with `window.EqualiserPages`. Has `init(params)` and `cleanup()`.

| Module | Page HTML | Purpose | NOSTR Kinds |
|--------|-----------|---------|-------------|
| `home.js` | `home.html` | Album grid, track search, community feed sidebar | 0, 1, 3, 7, 30050 |
| `artist.js` | `artist.html` | Artist profile, discography, feed, follow/unfollow | 0, 1, 3, 6, 7, 30050 |
| `social.js` | `social.html` | Timeline + Community tabs. Post composer, reactions | 0, 1, 5, 6, 7 |
| `thread.js` | `thread.html` | Root post + chronological replies. NIP-10 tags | 0, 1, 7 |
| `messages.js` | `messages.html` | Conversation list + chat UI (NIP-04 encrypted) | 0, 4 |
| `profile.js` | `profile.html` | Own profile. Posts/Likes tabs, follow stats | 0, 1, 3, 6, 7 |
| `user.js` | `user.html` | Other user's profile. Follow, message, artist detection | 0, 1, 3, 7, 30050 |
| `settings.js` | `settings.html` | Profile editor (avatar/banner Blossom upload), relay management, NIP-05, account | 0, 10002 |
| `library.js` | `library.html` | User's playlists + followed playlists | 30001 |
| `playlist.js` | `playlist.html` | Single playlist: play, shuffle, edit, share, Add to Library | 30001, 30050 |

## Standalone Pages

| File | Purpose |
|------|---------|
| `index.html` | Landing page. Links to login/onboarding |
| `login.html` | nsec / NIP-07 / backup file login. Redirects to `/app.html` |
| `onboarding.html` | New user signup. Key generation, Kind 0 profile creation, relay list (Kind 10002) |

## Redirects

- `feed.html` → `social.html`
- `community.html` → `social.html?tab=community`

## Content URL Patterns

| Content | Primary | Fallback | Final Fallback |
|---------|---------|----------|----------------|
| Cover art | Absolute Blossom URL (blossom_cover_url tag) | `/blossom/{hash}` (blossom_cover_hash tag) | `/ipfs/{cid}` (cover_art_cid tag) |
| HLS streams | `/ipfs/{cid}/playlist.m3u8` (ipfs_preview_cid or ipfs_manifest_cid tag) | — | — |
| Avatars/banners | Absolute Blossom URL from Kind 0 `picture`/`banner` fields | `/blossom/{hash}` (relative) | Gradient placeholder |

### Cross-Node Cover Art Resilience

Cover art `<img>` tags use a `data-fallback` attribute with the IPFS URL. When the primary Blossom URL fails (e.g. origin node is down), the `onerror` handler swaps to the IPFS fallback before hiding the image. This enables cover art to work across peer nodes without mirroring Blossom data:

1. `blossom_cover_url` (absolute URL to origin node's Blossom) — fast, works cross-node
2. `blossom_cover_hash` (relative `/blossom/{hash}`) — works on the origin node only
3. `cover_art_cid` (IPFS `/ipfs/{cid}`) — resilient fallback via content-addressed network

## Key Patterns

- **REST-first data fetching**: `_queryRelay()` routes local relay reads through the cache REST API (`/api/cache/events`), skipping external relay WebSocket connections entirely. All NostrSocial functions benefit automatically. 3s timeout with WebSocket fallback if cache unavailable. artist.js migrated to Cache API. home.js and user.js still have custom WebSocket queries for Kind 0/30050 — TODO to migrate.
- **Relay queries (WebSocket fallback)**: When cache API is unavailable, fetches from all relays in parallel, deduplicates by event ID, sorts newest-first
- **Profile cache**: In-memory pubkey → {name, picture} map, avoids repeated fetches
- **Client-side tag filtering**: Multi-char tags (`app`, `content-type`, `board`) are NOT relay-indexed — fetch broadly then filter in JS
- **App tag**: All events signed via SessionManager get `["app", "Equaliser"]` automatically
- **Relay config flow**: `NostrSocial.loadServerConfig()` fetches `STANDARD_RELAYS` from `GET /api/config` on app init. These become the default outbound publishing relays (alongside the local relay). Users can customise via settings page (Kind 10002). On localhost (no `STANDARD_RELAYS`), events publish to local relay only. Posts without the app tag (from standard relays) display with a "via NOSTR" badge.
