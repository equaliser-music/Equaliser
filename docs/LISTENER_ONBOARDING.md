# Listener Onboarding

## Overview

Listener onboarding enables fans/listeners to create NOSTR identities from the client home page. With a NOSTR identity, listeners can:

- Follow artists and other fans
- Create and store playlists
- React to and comment on tracks
- Participate in the Equaliser community feed
- Get a personalised home page based on their follows and preferences

All user data is stored on NOSTR relays, making it portable and decentralised. No Equaliser-specific backend account is needed.

## Design Principles

### NOSTR-Native Identity
Listeners get regular NOSTR accounts — the same protocol used by artists. This means:
- Identity is portable across all NOSTR apps (Damus, Primal, etc.)
- No centralised account database
- Users truly own their identity via cryptographic keys
- Recovery is possible from any device with the private key or backup file

### Ringfenced Social Activity
All Equaliser social activity uses **standard NOSTR events** with Equaliser-specific tags. Posts are visible across the broader NOSTR ecosystem but filterable by the Equaliser client:

- Social posts: Kind 1 with `["t", "equaliser"]` tag
- Track references: `["a", "30050:pubkey:track-d-tag"]` tag (NIP-01 `a` tag)
- Now Playing: Kind 1 with `["t", "nowplaying"]` + `["t", "equaliser"]`
- Reviews: Kind 1 with `["t", "review"]` + `["t", "equaliser"]`

This approach means posts **are** regular NOSTR notes (they show up on other clients) but the Equaliser community feed can filter for its own content.

### Relay Strategy
The user's relay list grows organically:

1. **On signup**: local content node relay is the default
2. **Following artists**: their content node relays get added automatically
3. **User-curated**: users can add public relays manually for broader discovery
4. **Stored on NOSTR**: relay list published as NIP-65 Kind 10002 event (portable, recoverable)

## User Data on NOSTR

| Data | NIP | Kind | Notes |
|------|-----|------|-------|
| Profile | NIP-01 | 0 | Display name, bio, avatar |
| Follows | NIP-02 | 3 | Contact list — artists + fellow fans |
| Relay List | NIP-65 | 10002 | Read/write relay preferences |
| Playlists | NIP-51 | 30001 | Named lists referencing track events |
| Favorites | NIP-51 | 10003 | Bookmarks list referencing tracks |
| Preferences | NIP-78 | 30078 | App-specific data (`d` tag: `equaliser:preferences`) |
| Listening History | NIP-78 | 30078 | App-specific (`d` tag: `equaliser:history`) |
| Reactions | NIP-25 | 7 | Likes/reactions on tracks and posts |
| Zaps | NIP-57 | 9735 | Lightning payments to artists |

## Onboarding Flow

### Three Steps

The listener onboarding is simpler than artist onboarding (which has 5 steps). No relay configuration step and no artist-specific profile fields.

#### Step 1: Create or Import Identity

**New user path:**
- "Create Your Account" heading
- Friendly, non-technical messaging — explain NOSTR as "your portable identity" rather than "cryptographic key pair"
- Generate keys button → creates NOSTR keypair in browser
- Keys never sent to any server

**Returning user paths:**
- NIP-07 browser extension (Alby, nos2x) — "Connect with Nostr Extension" button
- Manual nsec entry — for users who have their private key
- Backup file restore — load an `equaliser-backup-*.json` file

For extension users, skip straight to the profile step (no keys to save).

#### Step 2: Your Profile

- **Display name** (required)
- **Bio** (optional)
- **Avatar** (placeholder for now — future: upload to Blossom)
- Pre-fill from backup data or existing Kind 0 if restoring identity
- No artist-specific fields (no genres, location, etc.)

#### Step 3: Success

- "Welcome to Equaliser!"
- Show npub with copy button
- Publish results showing per-relay status (Kind 0 profile + Kind 10002 relay list)
- **"Start Listening"** button → redirects to home page
- **"Download Backup"** button → saves keys + profile as JSON
- Save keys warning (only shown for generated keys, not extension users)

### NOSTR Events Published During Onboarding

1. **Kind 0** (profile metadata): `{ "name": "...", "about": "...", "picture": "" }`
2. **Kind 10002** (relay list): NIP-65 tags — `["r", "ws://localhost/relay"]` plus any public relays
3. **Kind 3** (contact list): Empty initially, populated as user follows artists

### Relay Defaults (No Configuration Step)

Rather than asking the user to configure relays (as in artist onboarding), use sensible defaults:

**Local development:**
- `ws://localhost/relay` (local content node relay)

**Production:**
- `wss://<host>/relay` (this content node)
- `wss://relay.damus.io` (public relay)
- `wss://nos.lol` (public relay)

Users can adjust relays later in settings.

## Home Page Integration

### Anonymous State (Not Logged In)
- Header shows **"Sign Up"** button → links to `/onboarding.html`
- **"Log In"** text link next to it → links to `/login.html`
- User avatar shows generic placeholder
- Content is publicly browsable (album grid, player work without login)
- Community feed shows public posts

### Logged-In State
- Header shows user display name and avatar (from Kind 0)
- Dropdown menu: Profile, Settings, Logout
- Community feed could be personalised based on follows (future)
- Personalized content based on followed artists (future)

### Session Management
- Reuse `session.js` patterns from admin side (nsec storage, extension delegation, idle timeout, multi-tab sync, media-aware timeout)
- Adapt for client paths (login URL points to `/login.html` instead of `/admin/login.html`)
- Session persists in `sessionStorage` (tab-scoped, cleared on browser close)

## Returning User Login

A separate lightweight login page (`/login.html`) for returning users:

- NIP-07 extension button (primary option if extension detected)
- nsec manual entry
- Backup file restore
- "Don't have an account?" link → `/onboarding.html`
- Return URL support (`?return=` parameter) for deep linking
- Session expired notice (`?expired=1`)

## File Structure

```
client/
├── home.html              # Modified: add session awareness to header
├── onboarding.html        # New: 3-step listener onboarding wizard
├── login.html             # New: returning user login page
├── js/
│   └── session.js         # New: session manager (adapted from admin version)
├── artist.html            # Existing: artist profile view
├── index.html             # Existing: landing page
└── images/
    └── equaliser-logo.png # Existing: logo
```

No changes needed to nginx config, Docker Compose, or backend APIs. Everything is client-side static files served from the existing `client/` directory mount.

## Differences from Artist Onboarding

| Aspect | Artist Onboarding | Listener Onboarding |
|--------|-------------------|---------------------|
| Steps | 5 (keys → save → profile → relays → success) | 3 (identity → profile → success) |
| Profile fields | Name, bio, location, genres | Name, bio only |
| Relay config | Manual selection step | Automatic defaults |
| Success action | "Go to Dashboard" (admin) | "Start Listening" (home page) |
| Key save step | Dedicated step 2 | Integrated into success step |
| Extension support | Available but secondary | Primary recommended path |
| Session redirect | `/admin/login.html` | `/login.html` |

## Community Feed (Future)

The home page community feed sidebar (currently hardcoded mock posts) will be wired to pull real NOSTR events:

- Query user's relay list (Kind 10002) for `#equaliser` tagged Kind 1 events
- Show posts from followed artists and fans
- Display reactions, zaps, replies
- Allow posting from within the client (requires login)

This is a separate task from onboarding but depends on users having NOSTR identities.

## Personalised Home Page (Future)

Once users have NOSTR identities with follows and favorites:

1. Fetch Kind 3 (contact list) → get followed artist pubkeys
2. Query relays for those artists' Kind 30050 (track events) → "From Artists You Follow"
3. Query relays for `#equaliser` Kind 1 from follows → personalised community feed
4. Fetch Kind 10003 (bookmarks) → "Your Favorites" section
5. Fetch Kind 30001 (lists) → "Your Playlists" section

## Testing

1. Start the node: `./tools/start-node.sh -d`
2. Browse to `http://localhost` → home page loads
3. Click "Sign Up" → navigates to `/onboarding.html`
4. Complete 3-step flow → profile published to local relay, redirected to home page
5. Home page header shows logged-in state (display name)
6. Close tab, reopen → session restored from sessionStorage
7. Click "Log Out" → returns to anonymous state
8. Browse to `/login.html` → can log back in with nsec or backup file
9. Check relay: `./tools/nostr-browse.sh kind 0` → listener profile visible
10. Check relay: `./tools/nostr-browse.sh kind 10002` → relay list event visible
