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
11. contributor email summary.md

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
  - Fixes avatar/banner images not loading through nginx proxy

- [ ] **Track Upload API (Phase 2)**: Add encryption and payment
  - Generate AES-256 encryption key per track
  - Encrypt HLS segments (except 30s preview)
  - Store encryption keys in SQLite
  - Payment webhook to release keys via NIP-44
  - See Technical Specification sections 4.3-4.4

- [ ] **Label Multi-Artist Management**: Support labels managing multiple artist identities
  - Use NIP-06 / BIP-32 hierarchical key derivation from label master seed
  - Derivation path: `m/44'/1237'/{artist_index}'/0/0` (NIP-06 standard with artist as account index)
  - Label holds master seed, can generate/recover all artist keys deterministically
  - Option to export derived keys to artists for independence
  - Orchestrator signs on behalf of artists (custodial) or artists sign directly (non-custodial)
  - Handle artist departure: key export + profile migration documentation
  - Consider PostgreSQL for label nodes (higher concurrency than SQLite)




