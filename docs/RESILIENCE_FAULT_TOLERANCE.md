# Equaliser – Resilience & Fault Tolerance

This document describes how Equaliser maintains decentralisation, availability, and graceful degradation around content access, payments, and decryption keys.

---

## 1. Architectural Principles

- **Protocol-first:** All coordination happens via open protocols (IPFS, NOSTR, Lightning/Cashu); there is no mandatory central Equaliser backend.  
- **Node-based:** Each artist operates a Content Provider Node (orchestrator + IPFS + relay + DB), retaining control over content keys and revenue.  
- **Best-effort availability:** The system assumes individual nodes and relays will fail; resilience comes from redundancy, helper nodes, and optionally cooperating clients.

---

## 2. Content Availability (IPFS & Clusters)

- Content is stored as encrypted HLS segments on IPFS; CIDs are referenced from NOSTR track metadata events (kind 30050).  
- Artists and helpers can form IPFS clusters to pin each other's CIDs, improving durability and geographic reach.  

### 2.1 Key Rotation & CIDs

When rotating a track's encryption key:

1. Generate a new AES key for the track.  
2. Re-encrypt HLS segments with the new key.  
3. Upload the new manifest and segments to IPFS → obtain new CIDs.  
4. Publish an updated track metadata event (kind 30050) with the latest `ipfs_manifest_cid` and (optionally) a `["version","n"]` tag.  
5. Unpin old CIDs from the artist's IPFS node and any cooperating helpers.  

Notes:

- IPFS is content-addressed; old CIDs may still exist on third-party nodes, but they are no longer seeded by the artist's infrastructure.  
- Since old segments are encrypted and no fresh keys are issued for them after rotation, their usefulness is limited to parties who already obtained the old key.

---

## 3. NOSTR Relays & Event Redundancy

Equaliser uses NOSTR for:

- Track metadata (kind 30050).  
- Encrypted decryption keys (kind 30052).  
- Payment receipts (kind 30053).  

To avoid relay-level single points of failure:

- Multi-relay publishing: artists publish events to several relays by default, including at least one self-hosted relay.  
- Multi-relay subscriptions: clients subscribe to multiple relays in parallel for relevant filters (e.g. `kind: 30052`, `["p", user_pubkey]`, `["e", track_id]`) and accept the first valid key event.  
- Helper relays: optional high-uptime relays in the ecosystem can specialise in Equaliser events and re-gossip them, but they are not trusted with content keys nor required for correctness.  

Even if some relays censor or fail, redundancy ensures that paying users can still discover track metadata, key events, and receipts.

---

## 4. Artist Nodes & Helper Nodes

### 4.1 Artist Node Responsibilities

Each Content Provider Node (artist node) is responsible for:

- Generating per-track AES‑256 keys, storing them encrypted-at-rest, and encrypting all non-preview HLS segments.  
- Integrating with Strike/Cashu to issue invoices and validate webhooks.  
- Publishing artist-signed decryption key events:

```json
{
  "kind": 30052,
  "pubkey": "<artist-pubkey>",
  "content": "<nip44-encrypted-aes-key-for-user>",
  "tags": [
    ["d", "<unique-key-id>"],
    ["app", "Equaliser"],
    ["p", "<user-pubkey>"],
    ["e", "<track-event-id>"],
    ["payment_hash", "<strike-invoice-id>"]
  ]
}
```

- Maintaining local DB state (track metadata, invoice ↔ user mappings, analytics, node health).

### 4.2 Helper Nodes ("Triple Handshake")

Helpers are opt-in nodes that increase availability without becoming key custodians.

- **IPFS layer:** Join IPFS clusters and pin the same encrypted CIDs as artists to improve content durability and locality.  
- **NOSTR layer:** Run high-uptime relays that:
  - Subscribe to Equaliser events (e.g. kinds 30050, 30052, 30053 with `["app","Equaliser"]`).  
  - Re-gossip these events to other relays and clients.  
- **State layer:** Mirror non-sensitive orchestrator state (e.g. invoice status, track ↔ invoice mappings) sufficient to answer status queries and drive retries, but never store raw AES track keys.  

Helpers may expose APIs such as:

- `GET /status/invoice/:id` – invoice/track/user status (no keys).  
- `POST /key-status` – allow clients to check whether a corresponding key event should exist and trigger re-gossip if needed.  

Artist nodes remain the only authorities that generate and NIP‑44 encrypt AES keys.

---

## 5. Key Management & Rotation

### 5.1 Baseline Key Handling

- Each track has a unique random AES‑256 key for encrypting HLS segments (except the preview window).  
- The orchestrator:
  - Stores keys encrypted with a master key on disk.  
  - Uses them to encrypt segments at upload time.  
  - Uses them to produce NIP‑44 encrypted key events per user (kind 30052).  

### 5.2 Rotation Workflow

Rotation limits the useful lifetime of compromised or over-distributed keys:

1. Generate a new AES key for the track.  
2. Re-encrypt HLS segments and upload to IPFS → new CIDs.  
3. Publish a new 30050 with updated `ipfs_manifest_cid` and version tag.  
4. Stop issuing new key events for the old version (no more 30052 or peer-assisted keys based on the old AES key).  
5. Unpin old manifest and segment CIDs from artist and helper IPFS nodes.  

Old NOSTR events and CIDs remain discoverable, but:

- New users only see the latest metadata.  
- The protocol no longer distributes decryption keys for outdated CIDs.

### 5.3 Optional Threshold Secret Sharing

For high-availability recovery without trusting a single helper:

- Use threshold secret sharing (e.g. Shamir's Secret Sharing) to split each track's AES key into n shares with threshold t.  
- Distribute encrypted shares to n independent helper nodes or recovery partners.  
- Under normal operation, the artist node uses its local copy; helpers are idle.  
- If the artist node is down long-term, a designated recovery node (artist-controlled) collects at least t shares, reconstructs the key in memory, and republishes any missing 30052 events.  
- No single helper ever holds a full key; fewer than t colluding helpers learn nothing about the AES key.  

---

## 6. Peer-Assisted Availability (Optional Extension)

To further decentralise recovery, Equaliser can optionally allow peer-assisted key delivery with strict constraints.

### 6.1 Event Kinds

#### 6.1.1 30052 – Artist key event (existing)

Artist-issued canonical key event (as in the main spec).

#### 6.1.2 30054 – Peer-assisted key event (new)

Issued by a helper client that already has the AES key in RAM (from its own playback) and re-wraps it for another user, then deletes the key from memory.

```json
{
  "kind": 30054,
  "pubkey": "<helper-pubkey>",
  "content": "<nip44-encrypted-aes-key-for-recipient>",
  "tags": [
    ["app", "Equaliser"],
    ["artist", "<artist-pubkey>"],
    ["e", "<track-event-id>"],
    ["p", "<recipient-user-pubkey>"],
    ["receipt", "<payment-receipt-id-or-event-id>"],
    ["reason", "peer_key_assist"],
    ["expires_at", "<unix-seconds-optional>"]
  ]
}
```

#### 6.1.3 30055 – Peer assist report (new)

Notifies the artist that a peer assisted key delivery for a specific user and track.

```json
{
  "kind": 30055,
  "pubkey": "<helper-pubkey>",
  "content": "",
  "tags": [
    ["app", "Equaliser"],
    ["artist", "<artist-pubkey>"],
    ["e", "<track-event-id>"],
    ["p", "<recipient-user-pubkey>"],
    ["receipt", "<payment-receipt-id-or-event-id>"],
    ["reason", "peer_key_assist"],
    ["timestamp", "<unix-seconds>"]
  ]
}
```

### 6.2 Helper Client Behaviour

When running in opt-in helper mode:

1. **Normal playback**  
   - Receive 30052 from the artist.  
   - Decrypt the AES key in memory and play the track.  
   - Do not persist the key to disk or long-term storage.

2. **On a valid assist request (policy-controlled)**  
   - Verify the requester's proof of payment (e.g. a validated receipt event referencing the track).  
   - Use the in-memory AES key to produce a 30054 key event for the requester's pubkey.  
   - Immediately overwrite and discard the AES key from memory after publishing 30054.  
   - Emit a 30055 assist report to inform the artist of the peer assist.

3. **No persistent key storage**  
   - Keys are kept only in RAM for the lifetime of the playback/session and are explicitly erased after use.

### 6.3 Recipient Client Behaviour

- Normal path: wait for artist-issued 30052.  
- Fallback path (when artist or relays are unavailable and payment is proven):
  - Accept a 30054 that matches:
    - `["artist", artist_pubkey]`  
    - `["e", track_event_id]`  
    - `["p", my_pubkey]`  
  - Decrypt the NIP‑44 content and proceed exactly as with 30052.

### 6.4 Artist Node Reaction

- Subscribe to 30055 events tagged with `["artist", <own-pubkey>]`.  
- Use aggregated reports to:
  - Detect availability problems (frequent peer assists for specific tracks).  
  - Decide when to rotate AES keys for impacted tracks.  
  - Adjust policies (e.g. enabling/disabling peer assist or adding more helper infra).

Peer assistance is strictly optional and configurable per artist/track, preserving artist sovereignty over key policy.

---

## 7. Security & Decentralisation Considerations

- **Artist sovereignty:** Only artist-controlled infrastructure generates AES keys and issues canonical key events by default; helpers and peers operate under explicit opt-in policies.  
- **No central chokepoint:** Availability is improved by multiple relays, helper nodes, and optional peer-assisted clients; there is no mandatory Equaliser-operated central service.  
- **Immutable history:** Old NOSTR events and IPFS CIDs remain discoverable. Mitigations focus on rotating keys, ceasing issuance of old keys, unpinning outdated CIDs, and ensuring new users only follow the latest metadata and key paths.

---

## 8. Resilience Modes by Phase

This section aligns resilience and fault-tolerance features with the development roadmap phases.

### 8.1 Phase 1 (MVP – Q1–Q2 2026)

Goals: simple, robust baseline without complex coordination.  

- **Artist nodes**
  - Single orchestrator instance per artist, with encrypted-at-rest AES keys and local DB.  
  - IPFS daemon pins the artist's encrypted HLS segments.  
- **NOSTR**
  - Artists publish 30050/30052/30053 to multiple relays (artist's own + several public relays).  
  - Clients subscribe to multiple relays in parallel and accept the first valid key event.  
- **Resilience**
  - Manual key rotation (re-encrypt segments, update CIDs, new 30050, unpin old CIDs).  
  - No helper nodes, no peer-assisted keys in the baseline.

### 8.2 Phase 2 (Growth – Q3–Q4 2026)

Goals: better availability and scalability as node and user counts grow.  

- **Helper nodes**
  - Join IPFS clusters and pin popular artists' content.  
  - Run high-uptime NOSTR relays focused on Equaliser events.  
  - Mirror non-sensitive orchestrator DB state for status/retry APIs (no AES keys).  
- **Advanced options**
  - Optional threshold secret sharing (t-of-n) for high-value artists, enabling recovery without trusting a single helper.  
- **Resilience**
  - Stronger multi-relay defaults (preconfigured recommended relays, still user-editable).  
  - Operational playbooks for coordinated key rotation and CID deprecation at scale.

### 8.3 Phase 3 (Advanced – 2027+)

Goals: maximal decentralisation and graceful degradation, even under prolonged outages.  

- **Peer-assisted availability (opt-in)**
  - Introduce 30054 (peer-assisted key event) and 30055 (assist report).  
  - Helper clients can:
    - Pin IPFS content.  
    - Re-gossip artist 30052 events.  
    - Optionally perform in-memory NIP‑44 re-wrapping for other paid users, then erase keys.  
- **Advanced recovery**
  - Wider use of threshold secret sharing for automatic recovery when artist infra is down long-term.  
- **Resilience**
  - System continues to function even with some artist nodes offline and some relays censoring or lagging.  
  - Paying users can still obtain keys via alternative relays, helper nodes, and peer-assisted 30054 events (where enabled).

---

**End of Resilience & Fault Tolerance Document**
