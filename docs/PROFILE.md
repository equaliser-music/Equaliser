# Artist Profile Editor

The profile editor allows artists to login with their NOSTR identity and update their profile, including uploading avatar and banner images to IPFS.

## Access

**URL:** http://localhost/admin/profile.html

## Features

### Login
- Requires active session from login page (see SESSION_MANAGEMENT_FUNCTIONAL.md)
- Automatically fetches existing profile from NOSTR relays
- If logged in via backup file, form fields pre-fill from backup data
- Pre-fill only applies when no existing NOSTR profile is found

### Profile Images
- **Avatar:** Circular profile image
- **Banner:** Wide background image (recommended: 1024x768)
- Images uploaded directly to IPFS
- Accessible via gateway at `/ipfs/{CID}`

### Profile Fields

| Field | Standard | Description |
|-------|----------|-------------|
| Name | NIP-01 | Artist/project name (required) |
| Bio | NIP-01 | Short description |
| Picture | NIP-01 | Avatar URL (from IPFS upload) |
| Banner | NIP-24 | Banner URL (from IPFS upload) |
| Website | NIP-24 | Artist website |
| NIP-05 | NIP-05 | Identity verification address |
| Lightning Address | NIP-57 | For receiving zaps/tips (lud16) |
| Location | Equaliser | Artist location |
| Genres | Equaliser | Music genres (array) |

Equaliser-specific fields are stored under the `equaliser` namespace in the Kind 0 content.

### Publishing
- Select which relays to publish to
- Real-time status per relay (connecting/success/error)
- Preserves existing profile fields not explicitly edited

## Technical Details

### IPFS Upload Flow

```
User selects image
    ↓
Show local preview (blob URL)
    ↓
POST to /api/tracks/cover-art (orchestrator endpoint)
    ↓
Orchestrator uploads to IPFS and returns CID
    ↓
Display via /ipfs/{CID} (nginx gateway proxy)
    ↓
Store CID for Kind 0 event
```

Note: The orchestrator `/api/tracks/cover-art` endpoint handles IPFS uploads. This avoids exposing the IPFS API port (5001) publicly.

### Kind 0 Event Structure

```json
{
  "kind": 0,
  "pubkey": "<artist-hex-pubkey>",
  "content": "{\"name\":\"Artist Name\",\"about\":\"Bio\",\"picture\":\"http://localhost/ipfs/QmAvatar...\",\"banner\":\"http://localhost/ipfs/QmBanner...\",\"website\":\"https://example.com\",\"nip05\":\"artist@domain.com\",\"lud16\":\"artist@getalby.com\",\"equaliser\":{\"location\":\"Tokyo\",\"genres\":[\"Electronic\",\"Ambient\"],\"joinedDate\":\"2026-01-22\"}}",
  "created_at": 1737561600,
  "tags": [],
  "id": "<event-hash>",
  "sig": "<signature>"
}
```

### Security

- **Session-based authentication:** Uses centralized SessionManager
- **Keys in memory only:** nsec/privateKey never stored in localStorage
- **Cleared on logout:** All sensitive data wiped from memory
- **Idle timeout:** Session expires after 30 minutes of inactivity
- **Client-side signing:** Events signed in browser, nsec never sent to any server

### Relay Configuration

**Development (localhost):**
- Local relay only: `ws://localhost/relay`

**Production:**
- Local relay (optional)
- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.nostr.band`

## Dependencies

- **nostr-tools@2.1.4** - NOSTR protocol library (via CDN)
- **SessionManager** - Centralized session management (js/session.js)
- **AdminSidebar** - Navigation sidebar (js/admin-sidebar.js)
- **Orchestrator API** - `/api/tracks/cover-art` for IPFS uploads
- **IPFS Gateway** - Via nginx at `/ipfs`

## Related Files

- [onboarding.html](./onboarding.html) - Create new NOSTR identity
- [ONBOARDING.md](./ONBOARDING.md) - Onboarding documentation
- [CONTENT_NODE.md](../CONTENT_NODE.md) - Content node overview
