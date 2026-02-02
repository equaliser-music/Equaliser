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
15. contributor email summary.md

## Important Rules

- **Never commit without explicit permission**: Do not run `git commit` or use the commit tool unless the user specifically asks you to commit changes. Always wait for explicit instructions like "commit this", "please commit", or "push the changes".

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

### Artist Package Tools

Tools for bulk importing/exporting artist content. See [ARTIST_PACKAGE.md](docs/ARTIST_PACKAGE.md) for format specification.

#### convert-mockup.sh
Convert mockups/content artist folders to Artist Package format. **Use when preparing test data.**

```bash
./tools/convert-mockup.sh shibuya-crossings    # Convert single artist
./tools/convert-mockup.sh --all                # Convert all mockup artists
./tools/convert-mockup.sh --all --output ./backups/  # Custom output dir
```

#### import-artist.sh
Import an Artist Package into the content node. **Use when user asks to "import artist", "load test data", or "bulk import".**

```bash
./tools/import-artist.sh ./packages/shibuya-crossings.artist-package           # Fresh import (new identity)
./tools/import-artist.sh ./packages/shibuya-crossings.artist-package --restore # Use existing keys
./tools/import-artist.sh ./packages/shibuya-crossings.artist-package --dry-run # Preview only
```

This script:
- Generates new NOSTR identity (or restores from backup)
- Uploads avatar/banner to IPFS
- Publishes Kind 0 profile to relay
- Imports all releases as drafts
- Saves identity backup for dashboard login

#### export-artist.sh
Export an existing artist from the content node. **Use when user asks to "backup artist", "export content", or "create package".**

```bash
./tools/export-artist.sh --npub npub1...                  # Export profile + releases
./tools/export-artist.sh --npub npub1... --include-keys   # Include identity (prompts for nsec)
./tools/export-artist.sh --npub npub1... --releases-only  # Releases only
```

Note: Audio files are not included in exports (content is HLS-encoded on IPFS).

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

- [ ] **Onboarding to Dashboard Flow**: After completing onboarding, show "Go to Dashboard" button
  - User completes onboarding and profile is published to relays
  - Session is already established (keys in memory)
  - Add "Go to Dashboard" button on success screen
  - Preserve session so user doesn't need to log in again

- [ ] **Track Upload API (Phase 2)**: Add encryption and payment
  - Generate AES-256 encryption key per track
  - Encrypt HLS segments (except 30s preview)
  - Store encryption keys in SQLite
  - Payment webhook to release keys via NIP-44
  - See Technical Specification sections 4.3-4.4

- [ ] **Explore Blossom for Streaming**: Evaluate hybrid IPFS + Blossom architecture
  - NOSTR-native media hosting protocol using BUD servers
  - Content addressed by SHA-256 hash, tied to npub
  - Growing adoption in NOSTR music apps (Wavlake)
  - **Hybrid approach:** IPFS for storage/resilience, Blossom for streaming delivery
    - Upload stores on IPFS (canonical, content-addressed, resilient)
    - Content also pushed to Blossom server (fast HTTP delivery)
    - Player fetches from Blossom (low latency, CDN-friendly)
    - Fallback to IPFS gateway if Blossom unavailable
  - Blossom advantages for streaming: direct HTTP, no DHT lookup, predictable latency
  - Content node could run both IPFS daemon and Blossom server
  - See https://github.com/hzrd149/blossom

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
  - Federation between content nodes (mutual content pinning)
  - Load balancing for high-traffic artists/labels
  - Geographic distribution for lower latency
  - Shared relay infrastructure vs dedicated relays
  - Database scaling (PostgreSQL for labels, read replicas)
  - CDN integration for mainstream traffic levels

- [ ] **Social Features**: Artist-fan interaction via NOSTR
  - **Feed**: Standard NOSTR feed showing mentions, comments on tracks, reactions (Kind 1, 7, 6)
  - **Message Board**: Threaded discussions using Kind 1 replies with topic/hashtag filtering
  - **Blogging**: Long-form content using Kind 30023 (NIP-23) for artist updates, announcements
  - Admin UI to view mentions, reply to fans, post updates
  - Moderation tools (mute, block lists)
  - See NIP-01, NIP-23 for protocol details
