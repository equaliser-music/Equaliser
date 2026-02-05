# IPFS CID Compatibility Strategy

**Date:** January 2026  
**Context:** Addressing single point of failure concerns with IPFS gateway URLs in NOSTR events

---

## The Problem

When NOSTR events store IPFS content references as full gateway URLs (e.g., `http://localhost/ipfs/QmAvatar...`), the content becomes dependent on that specific gateway's availability. If the artist's nginx or IPFS daemon goes down, the content breaks for anyone fetching the profile—even though the underlying data may still exist on the IPFS network.

This creates an unnecessary single point of failure that undermines the decentralised architecture.

---

## The Solution

Store **both** a public gateway URL for compatibility and the **raw CID** for resilience.

### Principle

- **Standard NOSTR fields** (`picture`, `banner`) use public gateway URLs for compatibility with existing clients
- **Equaliser-specific fields** store raw CIDs for future-proofing and client flexibility
- **Track metadata tags** store raw CIDs (Equaliser clients control resolution)

---

## Implementation

### Kind 0 Profile Events

```json
{
  "name": "Artist Name",
  "about": "Bio text",
  "picture": "https://ipfs.io/ipfs/QmAvatarCID...",
  "banner": "https://ipfs.io/ipfs/QmBannerCID...",
  "website": "https://artist.com",
  "equaliser": {
    "picture_cid": "QmAvatarCID...",
    "banner_cid": "QmBannerCID...",
    "genres": ["Electronic", "Ambient"],
    "location": "Tokyo"
  }
}
```

**Rationale:**
- Standard NOSTR clients (Damus, Primal, etc.) render images via the public gateway URL
- Equaliser-aware clients can use the raw CIDs and route through any available gateway
- If `ipfs.io` is unavailable, clients with CID access can try alternative gateways

### Kind 30050 Track Events

```json
{
  "kind": 30050,
  "tags": [
    ["d", "unique-track-id"],
    ["app", "Equaliser"],
    ["title", "Track Name"],
    ["ipfs_manifest_cid", "QmManifest..."],
    ["ipfs_preview_cid", "QmPreview..."],
    ["cover_art_cid", "QmCover..."],
    ["price", "0.05"],
    ["price_currency", "USD"]
  ]
}
```

**Rationale:**
- Track events are consumed exclusively by Equaliser clients
- Clients control gateway resolution based on availability and user preferences
- No need for compatibility URLs in tags

---

## Gateway Resolution Strategy

Equaliser clients should implement fallback gateway resolution:

```typescript
const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/'
];

async function resolveContent(cid: string): Promise<string> {
  for (const gateway of IPFS_GATEWAYS) {
    try {
      const response = await fetch(`${gateway}${cid}`, { method: 'HEAD' });
      if (response.ok) {
        return `${gateway}${cid}`;
      }
    } catch {
      continue;
    }
  }
  throw new Error(`Could not resolve CID: ${cid}`);
}
```

### Artist Node Priority

When the artist's node URL is known (from profile metadata or relay hints), clients should try that first:

```typescript
async function resolveContentWithArtistNode(cid: string, artistNodeUrl?: string): Promise<string> {
  const gateways = artistNodeUrl 
    ? [`${artistNodeUrl}/ipfs/`, ...IPFS_GATEWAYS]
    : IPFS_GATEWAYS;
  
  // ... resolution logic
}
```

This prioritises the artist's infrastructure while maintaining resilience.

---

## Public Gateway Considerations

### Recommended Public Gateways

| Gateway | Notes |
|---------|-------|
| `https://ipfs.io/ipfs/` | Protocol Labs, reliable but rate-limited |
| `https://dweb.link/ipfs/` | Protocol Labs alternative |
| `https://cloudflare-ipfs.com/ipfs/` | Cloudflare, good performance |
| `https://gateway.pinata.cloud/ipfs/` | Pinata, requires content to be pinned there |

### Risks

- **Rate limiting:** Public gateways may throttle high-traffic content
- **Availability:** No SLA guarantees
- **Censorship:** Gateways can block specific CIDs

### Mitigation

- Encourage artists to pin content with multiple pinning services
- Implement client-side gateway rotation
- Long-term: artists run their own IPFS nodes with proper uptime

---

## Migration Path

### Phase 1: MVP

- Profile editor stores public gateway URLs in standard fields
- Raw CIDs stored in `equaliser` namespace
- Track events use raw CIDs in tags

### Phase 2: Enhanced Client

- Equaliser client implements gateway fallback resolution
- Client preferences for preferred gateways
- Artist node URL hints in profiles

### Phase 3: Full Decentralisation

- Artists encouraged to run persistent IPFS nodes
- Content pinned across multiple providers
- Client-side IPFS node integration (js-ipfs) for direct P2P resolution

---

## Code Changes Required

### Profile Editor (`profile.html`)

When uploading images to IPFS:

1. Upload to local IPFS node, receive CID
2. Store public gateway URL in `picture`/`banner` fields
3. Store raw CID in `equaliser.picture_cid`/`equaliser.banner_cid`

```javascript
async function uploadAndStoreImage(file, field) {
  const cid = await uploadToIPFS(file);
  
  // Standard field uses public gateway
  profile[field] = `https://ipfs.io/ipfs/${cid}`;
  
  // Equaliser field stores raw CID
  profile.equaliser[`${field}_cid`] = cid;
}
```

### Track Upload (Orchestrator)

Already using raw CIDs in tags—no changes needed.

### Equaliser Client

Implement `resolveContent()` function for all IPFS content fetching.

---

## Related Documentation

- [CONTENT_NODE.md](./content_node/CONTENT_NODE.md) - Content node architecture
- [PROFILE.md](./content_node/orchestrator/PROFILE.md) - Profile editor documentation
- [Technical Specification](./equaliser-technical-specification.md) - Full system specification
