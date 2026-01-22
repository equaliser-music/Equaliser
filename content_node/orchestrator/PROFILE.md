# Artist Profile Editor

The profile editor allows artists to login with their NOSTR identity and update their profile, including uploading avatar and banner images to IPFS.

## Access

**URL:** http://localhost/admin/profile.html

## Features

### Login
- Enter nsec (private key) to authenticate
- Keys stored in memory only (never persisted to localStorage)
- Automatically fetches existing profile from NOSTR relays

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
POST to http://localhost:5001/api/v0/add
    ↓
Receive CID (e.g., QmXxx...)
    ↓
Display via http://localhost/ipfs/{CID}
    ↓
Store CID for Kind 0 event
```

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

- **Keys in memory only:** nsec/privateKey never stored in localStorage or sessionStorage
- **Cleared on logout:** All sensitive data wiped from memory
- **Cleared on page unload:** Keys cleared when navigating away
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
- **IPFS API** - Port 5001 for uploads
- **IPFS Gateway** - Via nginx at `/ipfs`

## Related Files

- [onboarding.html](./onboarding.html) - Create new NOSTR identity
- [ONBOARDING.md](./ONBOARDING.md) - Onboarding documentation
- [CONTENT_NODE.md](../CONTENT_NODE.md) - Content node overview
