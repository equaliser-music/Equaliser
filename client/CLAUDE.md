# Client (Fan-Facing UI)

SPA for listeners/fans. Served at `/` by nginx. No build step — vanilla JS + HTML.

## Architecture

`app.html` is the SPA shell. It loads the sidebar, player, and router, which dynamically loads page HTML into `#page-content`. Three standalone pages bypass the shell: `index.html` (landing), `login.html`, `onboarding.html`.

Script load order in app.html:
nostr-tools (CDN) → hls.js (CDN) → session.js → sidebar.js → nostr-social.js → nostr-dm.js → nostr-playlists.js → player.js → router.js

## Core Modules (js/)

| Module | Purpose | Key Details |
|--------|---------|-------------|
| `session.js` | Session management | nsec or NIP-07 login. Keys in sessionStorage. Auto-adds `["app", "Equaliser"]` tag to all signed events. 30-min idle timeout, multi-tab logout via BroadcastChannel. API: `init()`, `signEvent()`, `getSession()`, `hasSession()`, `logout()` |
| `nostr-social.js` | Relay communication | Fetch/publish events, profile caching, relay config. Local relay at `/relay`, fallback to damus.io/nos.lol/primal.net. API: `fetchNotes()`, `fetchProfiles()`, `fetchContactList()`, `fetchReactions()`, `publishEvent()`, `loadUserRelays()`. Utilities: `escapeHtml()`, `relativeTime()`, `linkifyContent()`, `isEqualiserEvent()` |
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
| `settings.js` | `settings.html` | Profile editor, relay management, NIP-05, account | 0, 10002 |
| `library.js` | `library.html` | User's playlists + followed playlists | 30001 |
| `playlist.js` | `playlist.html` | Single playlist: play, shuffle, edit, share | 30001, 30050 |

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

| Content | Primary | Fallback |
|---------|---------|----------|
| Cover art | `/blossom/{hash}` (blossom_cover_hash tag) | `/ipfs/{cid}` (cover_art_cid tag) |
| HLS streams | `/ipfs/{cid}/playlist.m3u8` (ipfs_preview_cid or ipfs_manifest_cid tag) | — |
| Avatars/banners | `/ipfs/{cid}` or `/blossom/{hash}` from Kind 0 profile | Gradient placeholder |

## Key Patterns

- **Relay queries**: Fetch from all relays in parallel, deduplicate by event ID, sort newest-first
- **Profile cache**: In-memory pubkey → {name, picture} map, avoids repeated fetches
- **Client-side tag filtering**: Multi-char tags (`app`, `content-type`, `board`) are NOT relay-indexed — fetch broadly then filter in JS
- **App tag**: All events signed via SessionManager get `["app", "Equaliser"]` automatically
