Documentation exists in the `docs/` folder. Read the following at the start of each session:

1. CONTENT_NODE.md
2. ORCHESTRATOR.md
3. IPFS.md
4. EQUALISER_RELAY.md
5. DATABASE.md
6. NODE-MANAGEMENT-SPEC.md
7. ARTIST_PACKAGE.md
8. DEPLOYMENT_OPTIONS.md
9. SCALING.md
10. feature-proposals/FUTURE_FEATURES.md

Implemented feature docs in `docs/implemented/` — consult when working on specific areas (ONBOARDING, SESSION_MANAGEMENT_FUNCTIONAL, PROFILE, SOCIAL, BLOSSOM, IPFS_CID_COMPATIBILITY, PRICING_CURRENCY).

Original specification docs in `docs/original/` (Functional Specification, Technical Specification) — written pre-implementation, aspirational. Refer to for project vision and planned features (payments, encryption, subscriptions).

Archived/deprecated docs in `docs/archive/` (NOSTR, BLOSSOM_INTEGRATION_IDEAS, README).

## Codebase Structure

**Always check `client/` and `content_node/` when assessing or making large-scale changes.** Do not modify mockup files unless specifically requested.

| Directory | Purpose | Tech | Docs |
|-----------|---------|------|------|
| `client/` | Fan-facing SPA (listener UI). Served by nginx at `/` | Vanilla JS, HTML, nostr-tools, hls.js | [client/CLAUDE.md](client/CLAUDE.md) |
| `content_node/` | Artist admin + backend services | Docker Compose: FastAPI orchestrator, IPFS, NOSTR relay, Blossom, nginx | [content_node/CLAUDE.md](content_node/CLAUDE.md), [CONTENT_NODE.md](docs/CONTENT_NODE.md) |
| `mockups/` | Early UX prototypes (archived) | Express.js server, static HTML | [MOCKUPS.md](mockups/MOCKUPS.md) |
| `tools/` | CLI scripts for dev, deploy, content management | Bash | See Tools section below |

- `content_node/orchestrator/` contains the FastAPI backend (`api/`) and artist admin HTML pages
- `content_node/web/nginx.conf` routes requests between client, orchestrator, IPFS, Blossom, and relay

## Important Rules

- **Never commit without explicit permission**: Do not run `git commit` or use the commit tool unless the user specifically asks you to commit changes. Always wait for explicit instructions like "commit this", "please commit", or "push the changes".

## Development Workflow

All changes follow a **local-first** workflow:

1. **Develop locally** - Make code changes on the local machine
2. **Test locally** - Start the local content node (`./tools/start-node.sh`) and verify changes work
3. **User confirms** - Wait for the user to say they are happy with the local test
4. **Ask about VPS deploy** - When the user confirms local testing is good, ask: *"Do you want to deploy this to the VPS?"*
5. **Deploy to VPS** - If the user says yes, commit and push changes (using `./tools/commit.sh`), then run `./tools/deploy-vps.sh` to deploy

**Never deploy to VPS without the user explicitly confirming they want to.** Always test locally first.

## Tools

Development tools are available in the `tools/` folder. **Use these tools when the user requests the corresponding actions.**

### start-node.sh
Start the Equaliser content node. **Use when user asks to "start the node" or "start the containers".**

```bash
./tools/start-node.sh              # Start with build (foreground)
./tools/start-node.sh -d           # Start detached (background)
./tools/start-node.sh --no-build   # Start without rebuilding
./tools/start-node.sh -h           # Show help
```

### reset-node.sh
Reset the content node to a fresh state (wipes all data). **Use when user asks to "reset", "wipe", "fresh start", or "clear all data".**

```bash
./tools/reset-node.sh              # Interactive (asks for confirmation)
./tools/reset-node.sh --force      # Skip confirmation
./tools/reset-node.sh -d           # Start detached after reset
./tools/reset-node.sh -h           # Show help
```

This script:
- Stops all containers
- Removes Docker volumes (IPFS data, NOSTR events, uploads)
- Rebuilds and starts containers with fresh volumes
- Waits for health check

### nostr-browse.sh
Browse and query the local NOSTR relay database. **Use when user asks to "check NOSTR events", "browse relay", or debug NOSTR data.**

```bash
./tools/nostr-browse.sh              # Show summary of all events
./tools/nostr-browse.sh kinds        # List event kinds with counts
./tools/nostr-browse.sh authors      # List authors with event counts
./tools/nostr-browse.sh kind 0       # Show events of specific kind
./tools/nostr-browse.sh kind 30050   # Show track events
./tools/nostr-browse.sh profile <hex> # Show parsed profile (Kind 0)
./tools/nostr-browse.sh recent 20    # Show last 20 events
```

### ipfs-browse.sh
Browse and inspect the Equaliser IPFS node. **Use when user asks to "check IPFS", "browse content", or debug IPFS data.**

```bash
./tools/ipfs-browse.sh               # Show node status and root directories
./tools/ipfs-browse.sh ls /music     # List MFS directory
./tools/ipfs-browse.sh info <CID>    # Get info about a CID
./tools/ipfs-browse.sh pins          # List pinned content
./tools/ipfs-browse.sh peers         # Show connected peers
./tools/ipfs-browse.sh stats         # Show bandwidth and repo stats
./tools/ipfs-browse.sh gateway <CID> # Show gateway URLs for CID
```

### commit.sh
Commit and push changes to origin. **Use when user asks to "commit", "push changes", or "sync to origin".**

```bash
./tools/commit.sh "Commit message"   # Commit with message and push
./tools/commit.sh -m "Message"       # Same, using -m flag
./tools/commit.sh --auto             # Auto-generate message from changes
./tools/commit.sh                    # Interactive (prompts for message)
./tools/commit.sh -h                 # Show help
```

This script:
- Shows current changes before committing
- Stages all changes automatically
- Auto-generates commit message when `--auto` flag is used (analyzes changed files)
- Adds Claude co-authorship to commit message
- Pushes to origin on the current branch

### deploy-vps.sh
Deploy committed changes to the VPS content node. **Use when user confirms they want to deploy to VPS after successful local testing.**

```bash
./tools/deploy-vps.sh              # Full deploy: git pull + configs + rebuild containers
./tools/deploy-vps.sh --restart    # Just restart containers (no code update)
./tools/deploy-vps.sh --status     # Check VPS container status
./tools/deploy-vps.sh -h           # Show help
```

This script:
- Checks all changes are committed and pushed before deploying
- Runs `git pull` on the VPS to fetch latest code
- Syncs VPS configs (nginx, docker-compose override)
- Rebuilds and restarts Docker containers on the VPS
- Shows container status after deploy

**Pre-requisites:** Changes must be committed and pushed to origin. The script will refuse to deploy if there are uncommitted or unpushed changes.

### reset-vps.sh
Reset VPS content nodes to a fresh state. **Use when user asks to "clean VPS", "reset VPS", "wipe VPS nodes", or "fresh start on VPS".**

Handles peer sync correctly: stops ALL targeted nodes first (preventing peer relays from re-syncing stale data during the wipe), then rebuilds and starts them.

```bash
./tools/reset-vps.sh              # Reset both VPS nodes (interactive)
./tools/reset-vps.sh --force      # Skip confirmation
./tools/reset-vps.sh cpx22        # Reset CPX22 only
./tools/reset-vps.sh cx23         # Reset CX23 only
./tools/reset-vps.sh --all        # Reset localhost + both VPS nodes
./tools/reset-vps.sh --status     # Check status of all nodes
./tools/reset-vps.sh -h           # Show help
```

### cleanup-relay.sh
**Deprecated** — the Equaliser Relay handles app-tag filtering at event ingestion via its event acceptance policy. This script is only needed for the legacy nostr-rs-relay setup.

Remove non-Equaliser events from the NOSTR relay. **Use when user asks to "clean up the relay", "remove spam", or "clear junk events".**

```bash
./tools/cleanup-relay.sh              # Dry run — show what would be deleted
./tools/cleanup-relay.sh --execute    # Actually delete untagged events
./tools/cleanup-relay.sh --local      # Run against local relay (default is VPS)
```

This script:
- Identifies events without the `["app", "Equaliser"]` tag
- Protects all known Equaliser pubkeys (from backup files and seed data)
- Shows breakdown by event kind before deleting
- Dry run by default for safety

### seed-user-cache.sh
Seed a standard relay with test fan data and register pubkeys with the content node. **Use when testing user data caching pipeline.**

```bash
./tools/seed-user-cache.sh                                                    # Seed local standard relay + register locally
./tools/seed-user-cache.sh --relay wss://relay1.equaliser.app --node https://test1.equaliser.app  # Seed VPS
```

This script:
- Publishes Kind 0 (profiles), Kind 3 (follow lists), Kind 1 (posts) for 5 test fans to the standard relay
- Registers each fan pubkey with the content node via `POST /api/users/register`
- Prints verification commands and fan nsec keys for client login testing

### Artist Package Tools

Tools for importing/exporting artist content as `.eqpkg.zip` release packages. See [ARTIST_PACKAGE.md](docs/ARTIST_PACKAGE.md) for format specification.

#### convert-mockup.sh
Convert mockups/content artist folders to `.eqpkg.zip` packages. **Use when preparing test data.**

```bash
./tools/convert-mockup.sh shibuya-crossings    # Convert single artist
./tools/convert-mockup.sh --all                # Convert all mockup artists
./tools/convert-mockup.sh --all --legacy       # Also create legacy .artist-package
```

#### import-artist.sh
Import a package into the content node. **Use when user asks to "import artist", "load test data", or "bulk import".**

Supports both `.eqpkg.zip` (release packages) and legacy `.artist-package` directories.

```bash
./tools/import-artist.sh ./packages/release.eqpkg.zip                    # Fresh import (.eqpkg.zip)
./tools/import-artist.sh ./packages/release.eqpkg.zip --restore backup.json  # Restore identity
./tools/import-artist.sh ./packages/artist.artist-package                # Legacy format
./tools/import-artist.sh ./packages/artist.artist-package --restore      # Legacy restore
```

For `.eqpkg.zip`: generates identity, imports releases via API, saves backup.
For `.artist-package`: generates identity, publishes profile, imports releases as drafts.

#### export-artist.sh
Export releases as signed `.eqpkg.zip` packages. **Use when user asks to "backup artist", "export content", or "create package".**

```bash
./tools/export-artist.sh --npub npub1... --album "Album Name"    # Export specific album
./tools/export-artist.sh --npub npub1... --all-albums             # Export all albums
./tools/export-artist.sh --npub npub1... --all-albums --include-keys  # With identity backup
```

Requires nsec for signing packages. Original audio must be on Blossom (tracks uploaded after Blossom integration).

## TODO

- [ ] **IPFS Resilience**: Implement reliable public content availability
  - Option A: Mutual pinning between artist content nodes (decentralised, no third-party dependency)
  - Option B: Integrate with a pinning service (Pinata, web3.storage) for automatic pinning
  - `announce_to_dht()` exists in `content_node/orchestrator/api/services/ipfs.py` but is never called — wire into track upload and cover art upload as a quick win
  - See [IPFS.md - Content Availability and Public Gateways](docs/IPFS.md#content-availability-and-public-gateways)

- [x] **Track Upload API (Phase 1)**: Basic track upload without encryption
  - `POST /api/tracks/upload` - Accept audio file + metadata
  - HLS encoding with FFmpeg (full track + 30s preview)
  - Upload to IPFS, publish NOSTR Kind 30050 event
  - See [ORCHESTRATOR.md](docs/ORCHESTRATOR.md)

- [x] **Dashboard**: Artist admin home page
  - `/admin` now resolves to `dashboard.html` (requires login)
  - Shows recent releases from NOSTR relay (Kind 30050)
  - Displays artist profile from Kind 0 event
  - Total track count calculated from releases
  - TODO sections: plays, sats earned, followers, activity feed (requires analytics)

- [x] **Backup File Login**: Restore identity from backup files
  - Login page accepts `equaliser-backup-*.json` files
  - Profile page pre-fills form from backup data when no existing profile
  - Enables seamless recovery of previously created identities

- [x] **IPFS Gateway Configuration**: Automatic path-style URL setup
  - `configure-gateway.sh` runs on container startup
  - Sets `UseSubdomains: false` to prevent redirect issues
  - Sets `Addresses.API` to `0.0.0.0:5001` for inter-container communication
  - Fixes avatar/banner images not loading through nginx proxy

- [x] **Draft Workflow**: Hold releases before publishing to NOSTR
  - Uploads automatically save as drafts in SQLite database
  - `/admin/releases.html` shows drafts and released tracks
  - `/admin/edit-release.html` for editing metadata
  - "Release" button signs and publishes to NOSTR
  - Released drafts marked as 'released' with event ID for history
  - See [ORCHESTRATOR.md](docs/ORCHESTRATOR.md) for API documentation

- [x] **Onboarding to Dashboard Flow**: After completing onboarding, show "Go to Dashboard" button
  - User completes onboarding and profile is published to relays
  - Session is already established (keys in memory)
  - "Go to Dashboard" button on success screen
  - Session preserved so user doesn't need to log in again

- [ ] **Track Upload API (Phase 2)**: Add encryption and payment
  - Generate AES-256 encryption key per track
  - Encrypt HLS segments (except 30s preview)
  - Store encryption keys in SQLite
  - Payment webhook to release keys via NIP-44
  - Fiat → sats conversion at invoice time using live exchange rate (Strike API)
  - See original Technical Specification sections 4.3-4.4

- [x] **Pricing Currency**: Artist-preferred currency for stream pricing
  - Currency selector (USD, GBP, EUR, JPY, SAT) in profile editor and track upload UI
  - Track prices stored as `["price", "0.04"]` + `["price_currency", "GBP"]` in Kind 30050
  - SQLite schema, orchestrator APIs, profile editor, and track upload UI all updated
  - Fiat → sats conversion at invoice time deferred to Track Upload Phase 2 (payment system)
  - See [PRICING_CURRENCY.md](docs/implemented/PRICING_CURRENCY.md)

- [x] **Blossom Integration (MVP)**: Blossom server for original audio + images
  - Blossom Docker service with BUD-03 auth (node identity keypair)
  - Original audio preserved on Blossom during track upload
  - Cover art uploaded to Blossom (primary) + IPFS (fallback)
  - NOSTR events include `blossom_audio_hash`, `blossom_cover_hash`, and `blossom_cover_url` tags
  - `blossom_cover_url` contains absolute URL (via `PUBLIC_BASE_URL`) for cross-node cover art display
  - Client-side IPFS fallback: `<img>` onerror tries `/ipfs/{cid}` when Blossom URL fails
  - Package import uploads cover art to both Blossom and IPFS
  - See [BLOSSOM.md](docs/implemented/BLOSSOM.md)

- [x] **Release Package System**: Export/import releases as signed `.eqpkg.zip`
  - Export from admin UI or CLI (`export-artist.sh`)
  - Import via admin UI or CLI (`import-artist.sh`)
  - Packages contain manifest + original audio + signed NOSTR event
  - SHA-256 integrity verification, no private keys in packages
  - See [ARTIST_PACKAGE.md](docs/ARTIST_PACKAGE.md)

- [x] **Release Deletion**: Allow artists to delete released tracks from admin UI
  - Kind 5 (NIP-09) deletion event signed client-side, published to relay
  - Peer syncer propagates deletion to peer relays (existing behaviour)
  - `POST /api/tracks/cleanup` endpoint: unpins IPFS CIDs + deletes Blossom blobs
  - IPFS CIDs always safe to unpin (unique per HLS encode)
  - Blossom audio/cover hashes: client checks for shared references across releases before requesting deletion
  - `unpin_cid()` in IPFS service, `delete_from_blossom()` in Blossom service
  - Delete button in `edit-release.html` for released tracks
  - See [DELETE_RELEASES.md](docs/DELETE_RELEASES.md)

- [x] **Add Existing Track to Release**: Duplicate a draft track into a different release
  - "Add Existing Track" modal in `edit-release.html` shows all artist drafts, filtered by blossom hash to prevent duplicates within a release
  - Adding creates a **new draft** with independent storage — not a reference to the original
  - Server-side `POST /api/tracks/duplicate` endpoint: downloads original audio from Blossom, re-encodes HLS, uploads to IPFS, creates new draft row
  - New draft gets unique IPFS CIDs; shares `blossom_audio_hash` (Blossom deduplicates identical content)
  - Original draft stays untouched in its original release
  - Async with progress bar in modal (HLS encoding takes time)
  - "Upload New Track" button also available for adding fresh audio directly to a release
  - Design rule: each release owns its own IPFS CIDs, Blossom hashes may be shared
  - Future: support adding already-released tracks (compilations, greatest hits)

- [x] **Blossom: Profile Images**: Avatar/banner uploads via Blossom
  - `POST /api/upload/image` endpoint (uploads.py) — uploads to Blossom, returns hash + URL
  - Client settings page and admin profile page both use Blossom for avatar/banner
  - Absolute URLs via `PUBLIC_BASE_URL` for cross-node display
  - Blossom URL in Kind 0 `picture`/`banner` fields, IPFS CID in `equaliser` namespace for fallback
  - See [BLOSSOM.md](docs/implemented/BLOSSOM.md)

- [ ] **Blossom Disaster Recovery**: Rebuild content node from NOSTR + IPFS
  - Authenticate with nsec on fresh node → query relays for artist events
  - Extract IPFS CIDs from event tags → fetch content from IPFS network
  - Re-upload to local Blossom server → platform restored
  - Relies on IPFS cross-pinning (artist community) for content survival
  - Document recovery path first, automate tooling in later phase
  - See [BLOSSOM_INTEGRATION_IDEAS.md](docs/archive/BLOSSOM_INTEGRATION_IDEAS.md)

- [x] **Relay Spam Management**: Tiered event acceptance policy
  - All Equaliser events tagged with `["app", "equaliser"]` before signing
  - Artist Kind 0 profiles additionally tagged with `["user-type", "artist"]` (listeners omit `user-type` — extensible to `"label"`, `"node-admin"`, etc.)
  - Tiered acceptance policy by event kind: strict (music metadata requires app tag), context-aware (social replies accepted if they reference an existing event), known-pubkey (profiles/follows from registered users)
  - Triggered external reply checking: when an Equaliser reply arrives, relay checks standard relays for untagged replies to the same thread; stores count only, full events fetched on demand
  - UI shows "replies from wider Nostr" indicator — clean default experience with full conversation available on click
  - `cleanup-relay.sh` deprecated — no longer needed with ingestion-level filtering
  - This creates an application-level overlay network on standard NOSTR infrastructure

- [ ] **Label Multi-Artist Management**: Support labels managing multiple artist identities
  - Use NIP-06 / BIP-32 hierarchical key derivation from label master seed
  - Derivation path: `m/44'/1237'/{artist_index}'/0/0` (NIP-06 standard with artist as account index)
  - Label holds master seed, can generate/recover all artist keys deterministically
  - Option to export derived keys to artists for independence
  - Orchestrator signs on behalf of artists (custodial) or artists sign directly (non-custodial)
  - Handle artist departure: key export + profile migration documentation
  - Consider PostgreSQL for label nodes (higher concurrency than SQLite)

- [ ] **Security Hardening**: Address findings from security review (see [SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md))
  - **Critical**: Add API authentication (NIP-98 HTTP Auth) for all write endpoints
  - ~~**Critical**: Remove `artist_privkey` form parameter from track upload endpoint~~ (done)
  - ~~**Critical**: Restrict CORS to actual domains~~ (done — `ALLOWED_ORIGINS` env var)
  - ~~**Critical**: Move DB credentials to `.env` file excluded from git~~ (done — `${VAR:-default}` syntax, `.env.example` template)
  - **High**: Add upload rate limiting (`limit_req_zone` in nginx) and server-side file size validation
  - **High**: Add server-side session validation (challenge-response or NIP-98)
  - **High**: Migrate from sessionStorage keys to NIP-07 browser extension auth
  - **Medium**: Add security headers to nginx (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)
  - **Medium**: Restrict IPFS swarm port (4001) to known peers or rate-limit
  - **Medium**: Disable Blossom dashboard in production or add auth
  - **Medium**: Add structured logging for all write operations (uploads, edits, deletes)
  - **Low**: Document and encrypt backups, use SSH config aliases in deploy scripts

- [ ] **Operational Considerations**: Production readiness improvements
  - Backup and restore procedures for IPFS data, NOSTR relay, and SQLite database
  - Monitoring and alerting (container health, disk usage, relay connectivity)
  - Log aggregation and retention policies
  - Failure recovery documentation (what to do when containers crash)
  - Data migration strategy between content node versions
  - See also **Security Hardening** TODO above for rate limiting, input validation, container isolation

- [ ] **Multi-Node Architecture**: Scaling beyond single content node
  - **Equaliser relay network** (done): Two-tier relay architecture — standard NOSTR relays for social interop, Equaliser peer relays for music metadata replication. Two nodes deployed (CPX22 + CX23) with bidirectional peer sync. Self-hosted nostr-rs-relay on each VPS (`relay1.equaliser.app`, `relay2.equaliser.app`) as standard relays for user data caching.
  - **Cross-node cover art** (done): Absolute Blossom URLs (`blossom_cover_url` tag) for cross-node display, IPFS fallback (`cover_art_cid` tag) when origin Blossom is down. No Blossom mirroring — storage is a valuable resource.
  - Artists configure peer relays (other content nodes); Equaliser Relay publishes music events to configured peer relays via its built-in peer syncer
  - `PUBLIC_BASE_URL` env var on orchestrator enables absolute Blossom URLs in NOSTR events
  - TODO: Federation between content nodes (mutual IPFS pinning for audio)
  - TODO: Load balancing for high-traffic artists/labels
  - TODO: Geographic distribution for lower latency
  - TODO: Database scaling (PostgreSQL for labels, read replicas)
  - TODO: CDN integration for mainstream traffic levels
  - See [SCALING.md — Equaliser Relay Network](docs/SCALING.md#equaliser-relay-network)

- [x] **Social Features**: Artist-fan interaction via NOSTR
  - **Feed**: Kind 1 posts with `["content-type", "post"]` tag, reply/like/repost actions, clickable posts to thread view. "Your Feed" tab includes own posts alongside followed users.
  - **Threaded Replies**: `thread.html` page showing root post + chronological replies using NIP-10 `e`/`p` tags
  - **Community Message Boards**: Community tab in `social.html` with board tabs (general/music/production/gigs), thread list + detail views, `["content-type", "thread"]` and `["content-type", "reply"]` tags
  - **Direct Messages**: `messages.html` with NIP-04 encrypted DMs (Kind 4), two-panel conversation list + chat UI, `nostr-dm.js` module
  - **Unified Social Page**: `social.html` combines Feed + Community as full-width tabs ("Timeline" / "Community Threads"). Single "Social" link in sidebar bottom nav (alongside Profile, Settings). Messages accessible from profile page.
  - **Link Previews**: YouTube URLs render as thumbnail cards with play button. Image URLs (including Blossom hash URLs) render inline. Shared `generateLinkPreviews()` in nostr-social.js, used by all feed pages.
  - **Image Attach**: Post composer has image attach button — uploads to Blossom via `/api/upload/image`, appends absolute URL to note content. Images render inline via link preview detection.
  - **Release Announcements**: `["content-type", "release-announcement"]` tag with `["e", eventId]` references to Kind 30050 tracks. Admin modal on releases.html and edit-release.html after releasing. Client renders expandable rich card with cover art, track list, inline player, and "Add to Library" button.
  - **Expandable Playlist Cards**: Playlist share posts (`["content-type", "playlist-share"]`) render as expandable cards with track list, play buttons, and "Add to Library" button.
  - **Follower/Following**: Counts displayed on profile, user, and artist pages. Clickable to open modal with user list (avatar, name, bio snippet, follow/unfollow button). Uses Kind 3 `#p` query for followers count.
  - **Add to Library**: On release announcement cards, creates a new playlist from track event IDs. On playlist share cards, follows the existing playlist. Playlist page "Follow" button renamed to "Add to Library" / "In Library".
  - **Relay Tag Filtering**: Multi-char tag filtering done client-side (Equaliser Relay provides full tag indexing)
  - **Seed Data**: `tools/seed-social.sh` populates relay with test posts, threads, DMs, reactions
  - See [SOCIAL.md](docs/implemented/SOCIAL.md)

- [ ] **User Data Caching (Phase B.1)**: Cache fan/listener NOSTR data on content node
  - **Done**: DB tables (`registered_users`, `cached_users`, `cached_user_follows`, `cached_user_feed`, `cached_user_playlists`), relay internal API, orchestrator proxy, client auto-register on login
  - **Done**: Standard relay infrastructure — self-hosted nostr-rs-relay on each VPS (`relay1.equaliser.app`, `relay2.equaliser.app`), `STANDARD_RELAYS` config points to them, syncer pulls Kind 0/1/3/5 by known pubkeys
  - **Done**: Cache REST API (`/api/cache/`) — profiles (batch + single), follows, feed, artists, tracks (by artist + recent), albums, thread external refs. General-purpose event query (`GET /api/cache/events`) with NIP-01-style filter params replaces WebSocket REQ for reads. Nginx routes `/api/cache/` to relay REST port (8008).
  - **Done**: Client REST-first migration — `cache-api.js` module with `queryEvents()` + denorm functions. `_queryRelay()` in nostr-social.js tries REST cache API for local relay reads; external relay WebSocket queries skipped entirely when cache API is available. All NostrSocial functions (fetchNotes, fetchReactions, fetchReplyCounts, fetchThreadReplies, etc.) automatically use REST. WebSocket retained only for event publishing.
  - **Partial**: artist.js migrated to Cache API (Kind 0 profile + Kind 30050 tracks). home.js and user.js still have direct WebSocket queries for Kind 0/30050 — TODO: migrate to cache API.
  - **Done**: Profile backfill on registration — copies existing Kind 0 from `raw_events` into `cached_users` at registration time (fixes onboarding timing gap)
  - **Done**: Event acceptance policy fix — Kind 1 from known pubkeys (registered users/artists) accepted without app tag, enabling standard relay syncing of fan posts
  - TODO: Admin controls (per-user enable/disable, force resync, remove user)
  - TODO: Outbound publishing to standard relays (feed posts with `["content-type", "post"]` only, not community threads)
  - TODO: Inbound reply/reaction caching — syncer `#e`-based subscription for Equaliser post IDs on standard relays, caching replies (Kind 1), likes (Kind 7), reposts (Kind 6) from wider NOSTR. Rule: complete the interaction tree for any `["app", "equaliser"]` originating post
  - Feed thresholds: `USER_FEED_DAYS` (default 30), `USER_FEED_LIMIT` (default 500)
  - See [DATABASE.md](docs/DATABASE.md) (User Cache Tables), [EQUALISER_RELAY.md](docs/EQUALISER_RELAY.md) (Peer Syncer & User Subscriptions), [ORCHESTRATOR.md](docs/ORCHESTRATOR.md) (User Registration)

- [ ] **Access Control (Phase A)**: Gated onboarding with invite codes
  - **Partial**: `access_requests` and `node_artists` tables exist in relay PostgreSQL migration
  - TODO: `/join` route, invite code validation endpoint, admin approval workflow
  - Public request form at `/join` for artists to apply
  - Admin approval workflow via management console
  - Invite code generation and validation before onboarding
  - See [NODE-MANAGEMENT-SPEC.md](docs/NODE-MANAGEMENT-SPEC.md) Section 5

- [ ] **Equaliser Relay (Phase B)**: Custom NOSTR relay with built-in cache and peer syncing
  - **Phase 1 (done):** NIP-01 WebSocket relay in Go, PostgreSQL storage with full tag indexing, denormalised parsing (Kind 0/30050/30051), tiered event acceptance policy (strict for music metadata, context-aware for social, known-pubkey for profiles), `["user-type", "artist"]` tag for Kind 0 denorm routing, replaces nostr-rs-relay
  - **Phase 2 (done):** Peer syncer — persistent WebSocket connections to configured peer relays, inbound Equaliser event sync, outbound event forwarding, exponential backoff reconnection, peer status tracking in `peer_relays` table
  - **Bug: Peer syncer connection drops every ~30s** — persistent WebSocket to peer relay disconnects with "use of closed network connection" every ~30 seconds. Reconnects fine with 5s backoff and incremental `since` ensures no events are lost, but the constant churn is wasteful. Investigate: could be VPS nginx idle timeout, relay-side read timeout, or the periodic resync (SYNC_INTERVAL) closing connections prematurely
  - **Phase 3 (done):** Cache REST API at `/api/cache/` — profiles (batch + single), follows, feed, artists, tracks (by artist + recent), albums, thread external refs. General event query (`GET /api/cache/events`) with NIP-01 filter params (kinds, authors, ids, #e, #p, limit, since, until) replaces WebSocket REQ for reads. Client `cache-api.js` + REST-first `_queryRelay()` eliminates external relay WebSocket connections. Internal: `POST /api/internal/users/register` with profile backfill
  - **Phase 4 (done):** pgxpool connection pooling (MaxConns=20, MinConns=2), denormalised Kind 0/30050/30051 tables, user feed caching with configurable limits (USER_FEED_DAYS, USER_FEED_LIMIT)
  - See [EQUALISER_RELAY.md](docs/EQUALISER_RELAY.md), [DATABASE.md](docs/DATABASE.md), [NODE-MANAGEMENT-SPEC.md](docs/NODE-MANAGEMENT-SPEC.md) Sections 2-4

- [ ] **Node Management Console (Phase C)**: Admin dashboard at `/admin/console`
  - React SPA for node operators (separate from artist admin)
  - Sections: Overview, Sync Manager, Artist Management, IPFS & Storage, Blossom Mirroring, Settings
  - Admin authentication via `ADMIN_PASSWORD` env var
  - WebSocket for real-time status updates
  - See [NODE-MANAGEMENT-SPEC.md](docs/NODE-MANAGEMENT-SPEC.md) Section 6

- [ ] **IPFS Cluster & Blossom Mirroring (Phase D)**: Cross-node content redundancy
  - IPFS cluster pin request workflow (inbound/outbound)
  - Blossom server configuration and mirroring policies
  - Storage management and auto-approve policies
  - See [NODE-MANAGEMENT-SPEC.md](docs/NODE-MANAGEMENT-SPEC.md) Section 7

- [ ] **Multi-Tenant Hosting (Phase E)**: Fee models and payment splits
  - Fee model configuration (free, percentage, flat_rate) per artist
  - Payment split logic in orchestrator (future, after Strike integration)
  - Artist portability / export tooling
  - Public node directory listing
  - See [NODE-MANAGEMENT-SPEC.md](docs/NODE-MANAGEMENT-SPEC.md) Section 8
