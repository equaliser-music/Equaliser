Documentation exists in the 'docs' folder. Please read in the following order at the start of each session

1. Base documentation before any code was written:
    - Functional Specification.md
    - Technical Specification.md

2. PROJECT_RULES.md
3. CONTENT_NODE.md
4. ORCHESTRATOR.md
5. IPFS.md
6. NOSTR.md
7. IPFS_CID_COMPATIBILITY.md
8. ONBOARDING.md
9. SESSION_MANAGEMENT_FUNCTIONAL.md
10. PROFILE.md
11. SOCIAL.md
12. DEPLOYMENT_OPTIONS.md
13. SCALING.md
14. ARTIST_PACKAGE.md
15. BLOSSOM.md
16. contributor email summary.md
17. PRICING_CURRENCY.md
18. COMMUNITY.md

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

### cleanup-relay.sh
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
  - Add `ipfs dht provide` call after uploads to announce content to DHT
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
  - See Technical Specification sections 4.3-4.4

- [x] **Pricing Currency**: Artist-preferred currency for stream pricing
  - Currency selector (USD, GBP, EUR, JPY, SAT) in profile editor and track upload UI
  - Track prices stored as `["price", "0.04"]` + `["price_currency", "GBP"]` in Kind 30050
  - SQLite schema, orchestrator APIs, profile editor, and track upload UI all updated
  - Fiat → sats conversion at invoice time deferred to Track Upload Phase 2 (payment system)
  - See [PRICING_CURRENCY.md](docs/PRICING_CURRENCY.md)

- [x] **Blossom Integration (MVP)**: Blossom server for original audio + images
  - Blossom Docker service with BUD-03 auth (node identity keypair)
  - Original audio preserved on Blossom during track upload
  - Cover art uploaded to Blossom (primary) + IPFS (fallback)
  - NOSTR events include `blossom_audio_hash` and `blossom_cover_hash` tags
  - See [BLOSSOM.md](docs/BLOSSOM.md)

- [x] **Release Package System**: Export/import releases as signed `.eqpkg.zip`
  - Export from admin UI or CLI (`export-artist.sh`)
  - Import via admin UI or CLI (`import-artist.sh`)
  - Packages contain manifest + original audio + signed NOSTR event
  - SHA-256 integrity verification, no private keys in packages
  - See [ARTIST_PACKAGE.md](docs/ARTIST_PACKAGE.md)

- [ ] **Blossom: Profile Images**: Migrate avatar/banner uploads to Blossom primary
  - Update profile editor image upload to use Blossom first
  - Store both Blossom URL and IPFS CID in Kind 0 events
  - Client fallback: Blossom URL first, IPFS gateway fallback

- [ ] **Blossom Disaster Recovery**: Rebuild content node from NOSTR + IPFS
  - Authenticate with nsec on fresh node → query relays for artist events
  - Extract IPFS CIDs from event tags → fetch content from IPFS network
  - Re-upload to local Blossom server → platform restored
  - Relies on IPFS cross-pinning (artist community) for content survival
  - Document recovery path first, automate tooling in later phase
  - See [BLOSSOM_INTEGRATION_IDEAS.md](docs/BLOSSOM_INTEGRATION_IDEAS.md)

- [x] **Relay Spam Management**: App-tag filtering + periodic cleanup
  - All Equaliser events tagged with `["app", "equaliser"]` before signing
  - UI feeds filter exclusively on this tag — untagged events are invisible to users
  - Content node relays remain **public** (open read + write) to support decentralisation
  - `cleanup-relay.sh` removes untagged events from non-protected pubkeys (storage hygiene)
  - This creates an application-level overlay network on standard NOSTR relays
  - Future: consider `event_kind_allowlist`, rate limiting, or NIP-42 AUTH if spam volume warrants relay-level restrictions

- [ ] **Label Multi-Artist Management**: Support labels managing multiple artist identities
  - Use NIP-06 / BIP-32 hierarchical key derivation from label master seed
  - Derivation path: `m/44'/1237'/{artist_index}'/0/0` (NIP-06 standard with artist as account index)
  - Label holds master seed, can generate/recover all artist keys deterministically
  - Option to export derived keys to artists for independence
  - Orchestrator signs on behalf of artists (custodial) or artists sign directly (non-custodial)
  - Handle artist departure: key export + profile migration documentation
  - Consider PostgreSQL for label nodes (higher concurrency than SQLite)

- [ ] **Operational Considerations**: Production readiness improvements
  - Backup and restore procedures for IPFS data, NOSTR relay, and SQLite database
  - Monitoring and alerting (container health, disk usage, relay connectivity)
  - Log aggregation and retention policies
  - Failure recovery documentation (what to do when containers crash)
  - Data migration strategy between content node versions
  - Security hardening (rate limiting, input validation, container isolation)

- [ ] **Multi-Node Architecture**: Scaling beyond single content node
  - **Equaliser relay network**: Two-tier relay architecture — standard NOSTR relays for social interop, Equaliser peer relays for music metadata replication
  - Artists configure peer relays (other content nodes); orchestrator publishes music events to local + peer relays
  - NOSTR relay replication for metadata + IPFS cross-pinning for audio = full redundancy
  - Federation between content nodes (mutual content pinning)
  - Load balancing for high-traffic artists/labels
  - Geographic distribution for lower latency
  - Database scaling (PostgreSQL for labels, read replicas)
  - CDN integration for mainstream traffic levels
  - See [SCALING.md — Equaliser Relay Network](docs/SCALING.md#equaliser-relay-network)

- [x] **Social Features**: Artist-fan interaction via NOSTR
  - **Feed**: Kind 1 posts with `["content-type", "post"]` tag, reply/like/repost actions, clickable posts to thread view
  - **Threaded Replies**: `thread.html` page showing root post + chronological replies using NIP-10 `e`/`p` tags
  - **Community Message Boards**: Community tab in `social.html` with board tabs (general/music/production/gigs), thread list + detail views, `["content-type", "thread"]` and `["content-type", "reply"]` tags
  - **Direct Messages**: `messages.html` with NIP-04 encrypted DMs (Kind 4), two-panel conversation list + chat UI, `nostr-dm.js` module
  - **Unified Social Page**: `social.html` combines Feed + Community as full-width tabs ("Timeline" / "Community Threads"). Single "Social" link in sidebar bottom nav (alongside Profile, Settings). Messages accessible from profile page.
  - **Relay Tag Filtering**: All multi-char tag filtering done client-side (relay only indexes single-letter tags)
  - **Seed Data**: `tools/seed-social.sh` populates relay with test posts, threads, DMs, reactions
  - See [SOCIAL.md](docs/SOCIAL.md), [COMMUNITY.md](docs/COMMUNITY.md)
