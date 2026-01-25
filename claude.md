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

Development tools are available in the `tools/` folder:

### nostr-browse.sh
Browse and query the local NOSTR relay database.

```bash
./tools/nostr-browse.sh              # Show summary of all events
./tools/nostr-browse.sh kinds        # List event kinds with counts
./tools/nostr-browse.sh authors      # List authors with event counts
./tools/nostr-browse.sh kind 0       # Show events of specific kind
./tools/nostr-browse.sh profile <hex> # Show parsed profile (Kind 0)
./tools/nostr-browse.sh recent 20    # Show last 20 events
```

### ipfs-browse.sh
Browse and inspect the Equaliser IPFS node.

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




