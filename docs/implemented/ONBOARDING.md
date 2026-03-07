# Artist Onboarding

This document explains the artist onboarding process for Equaliser, including how NOSTR identity works and why it matters for a decentralized music platform.

## Overview

Artist onboarding creates a **NOSTR identity** - a cryptographic key pair that serves as the artist's portable, self-sovereign identity across the decentralized network.

## Why NOSTR Identity?

### The Problem with Traditional Platforms

On Spotify, SoundCloud, or Bandcamp:
- The platform owns your account
- They can suspend or delete you at any time
- Your followers belong to them, not you
- You can't take your identity elsewhere

### The NOSTR Solution

With NOSTR:
- **You own your identity** - it's just a key pair you control
- **Portable** - works across any NOSTR-compatible app
- **Censorship-resistant** - no one can delete your account
- **Decentralized** - data replicated across multiple relays
- **Recoverable** - if a node dies, your identity persists on the network

## Key Concepts

### Key Pair

Every NOSTR identity consists of two keys:

| Key | Format | Purpose | Share? |
|-----|--------|---------|--------|
| **Private Key** | `nsec1...` | Signs events, proves identity | NEVER |
| **Public Key** | `npub1...` | Identifies you to others | Yes |

The private key (nsec) is like a password that can never be changed. Anyone with it can act as you. The public key (npub) is your public identifier, like a username.

### Kind 0 Event (Profile)

Your artist profile is stored as a **Kind 0** NOSTR event:

```json
{
  "kind": 0,
  "pubkey": "your-hex-pubkey",
  "content": "{\"name\":\"Artist Name\",\"about\":\"Bio...\",\"picture\":\"url\",\"equaliser\":{\"genres\":[\"Electronic\"],\"location\":\"Tokyo\"}}",
  "created_at": 1705782400,
  "tags": [],
  "id": "event-hash",
  "sig": "signature"
}
```

This event is:
- **Signed** with your private key (proving it's from you)
- **Published** to multiple relays (redundancy)
- **Replaceable** - publishing a new Kind 0 updates your profile

### Relays

Relays are servers that store and forward NOSTR events. The onboarding tool publishes to:

| Relay | Purpose |
|-------|---------|
| `ws://localhost:8080` | Local Equaliser relay (for our node to index) |
| `wss://relay.damus.io` | Popular public relay (wide distribution) |
| `wss://nos.lol` | Another public relay (redundancy) |
| `wss://relay.nostr.band` | Discovery-focused relay |

More relays = better redundancy and discoverability.

## Access Control (Gated Onboarding)

When access control is enabled on a node, artists must request access before they can onboard:

1. **Request access** at `/join` — a public form requiring artist name, description, and optional links/email/npub
2. **Admin reviews** the request via the node management console
3. **Invite code issued** on approval (e.g. `EQ-a8f3b2c1`) — shared with the artist via email or DM
4. **Enter invite code** at the start of the onboarding wizard — validated before proceeding

Once the invite code is accepted, the artist proceeds through the standard onboarding flow described below. On successful onboarding, the invite is marked as used and the artist is registered in the node's artist list.

See [NODE-MANAGEMENT-SPEC.md](../NODE-MANAGEMENT-SPEC.md) Section 5 for the full request form, approval workflow, and API endpoints.

## The Onboarding Flow

### Step 1: Generate Keys

The tool generates a random key pair **in your browser**:
- Uses `nostr-tools` library with Web Crypto API
- Keys never leave your device
- Cryptographically secure random generation

### Step 2: Save Keys

**Critical step.** The artist must securely save their private key (nsec).

Recommended storage:
- Password manager (1Password, Bitwarden, etc.)
- Written on paper in a safe
- Encrypted backup file

**If the nsec is lost, the identity is lost forever.** There is no "forgot password" flow.

### Step 3: Enter Profile

Collect artist metadata:
- Name (required)
- Bio
- Location
- Genres

This maps to the Kind 0 content structure.

### Step 4: Choose Relays

Select which relays to publish to:
- Local relay (default, for development)
- Public relays (for production distribution)
- Custom relays (artist's preference)

### Step 5: Publish

The tool:
1. Creates a Kind 0 event with profile data
2. Signs it with the private key
3. Publishes to each selected relay via WebSocket
4. Reports success/failure for each relay

### Backup File

After publishing, the artist can download a backup JSON file containing:
- Keys (nsec, npub, hex formats)
- Profile data
- Timestamp

This file should be stored securely as an additional backup.

## Running the Onboarding Tool

### Prerequisites

- Modern browser (Chrome 90+, Firefox 88+, Safari 14+)
- For local relay: Docker container running (see `../nostr-relay/`)

### Development Mode (Local Only)

1. Start the local relay:
   ```bash
   cd ../nostr-relay
   docker-compose up -d
   ```

2. Open the onboarding page:
   ```bash
   open onboarding.html
   # Or serve via HTTP:
   python3 -m http.server 8000
   # Then visit http://localhost:8000/onboarding.html
   ```

3. Generate keys and complete onboarding
4. Profile publishes to local relay only

### Production Mode

1. Ensure the local relay is running
2. Open onboarding.html
3. Enable additional public relays in Step 4
4. Profile publishes to local + public relays

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Artist's Browser                          │
│                                                              │
│  1. Generate Keys (client-side)                             │
│     └─→ nsec (private) + npub (public)                      │
│                                                              │
│  2. Enter Profile Data                                       │
│     └─→ name, bio, genres, location                         │
│                                                              │
│  3. Create Kind 0 Event                                      │
│     └─→ { kind: 0, content: JSON.stringify(profile), ... }  │
│                                                              │
│  4. Sign Event with Private Key                              │
│     └─→ event.sig = sign(event, nsec)                       │
│                                                              │
│  5. Publish to Relays                                        │
│     └─→ WebSocket: ["EVENT", signedEvent]                   │
│                                                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │  Local   │    │  Damus   │    │  nos.lol │
    │  Relay   │    │  Relay   │    │  Relay   │
    │ :8080    │    │  (pub)   │    │  (pub)   │
    └──────────┘    └──────────┘    └──────────┘
           │
           ▼
    ┌──────────────┐
    │ Orchestrator │
    │  (indexes    │
    │   events)    │
    └──────────────┘
```

## Security Considerations

### Private Key Handling

- Generated in browser using `crypto.getRandomValues()`
- Never transmitted to any server
- User must manually save it
- No recovery mechanism exists

### Event Signing

- Events signed client-side before publishing
- Relays verify signatures before accepting
- Impossible to forge events without private key

### Relay Trust

- Relays can refuse to store events (censorship at relay level)
- Mitigation: publish to multiple relays
- Artist can always spin up their own relay

## Extending the Profile

### Standard Fields (NIP-01/NIP-24)

```json
{
  "name": "Display name",
  "about": "Bio text",
  "picture": "Avatar URL",
  "banner": "Banner image URL",
  "website": "Website URL",
  "nip05": "user@domain.com",
  "lud16": "lightning@address.com"
}
```

### Equaliser-Specific Fields

Nested under `equaliser` to avoid namespace pollution:

```json
{
  "equaliser": {
    "genres": ["Electronic", "House"],
    "location": "Tokyo, Japan",
    "joinedDate": "2025-01-20",
    "nodeUrl": "https://artist-node.example.com"
  }
}
```

## Integration with Orchestrator

The orchestrator layer (Python/FastAPI) will:

1. **Subscribe** to the local relay for artist events
2. **Index** Kind 0 events in local database (cache)
3. **Verify** artist identity via pubkey for uploads
4. **Publish** track events (Kind 30050) on behalf of artists

The Kind 0 profile published during onboarding establishes the artist's identity that the orchestrator will later reference.

## Troubleshooting

### "Failed to connect to relay"

- Check if local relay is running: `docker-compose ps`
- Verify port 8080 is not blocked
- For public relays, check internet connection

### "Keys not generated"

- Ensure JavaScript is enabled
- Try a different browser
- Check browser console for errors

### "Event rejected by relay"

- Relay may be full or have restrictions
- Try different relays
- Check relay's NIP-11 info for policies

## Next Steps After Onboarding

1. **Save backup file** securely
2. **Start local relay** if not running
3. **Upload content** via orchestrator dashboard (coming soon)
4. **Share npub** with fans for discoverability

## References

- [NIP-01: Basic Protocol](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-19: bech32-encoded entities](https://github.com/nostr-protocol/nips/blob/master/19.md)
- [nostr-tools library](https://github.com/nbd-wtf/nostr-tools)
- [Equaliser Technical Specification](../../Technical%20Specification.md)
- [Node Management Spec](../NODE-MANAGEMENT-SPEC.md) — Full node management specification (access control in Section 5)
