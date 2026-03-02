# Blossom Integration Ideas

**Date:** January 2026  
**Status:** Exploration / Future Consideration

---

## Overview

This document captures ideas around integrating Blossom (Binary Large Object Storage Mechanism) into the Equaliser content node architecture, potentially as a complement to IPFS for media storage.

---

## The Problem

Current IPFS integration for images (avatars, banners, album art) has friction points:

- Slow retrieval times via gateways
- Gateway rate limits and inconsistency
- Propagation delays before content is reliably available
- Multiple potential failure points (API upload → gateway serving)

These issues are particularly painful for images that need to load quickly on page render.

---

## What is Blossom?

Blossom is a protocol for storing and serving binary data in the NOSTR ecosystem. Key characteristics:

- **Hash-addressed**: Files are addressed by their SHA-256 hash (`https://server.example/<sha256>.jpg`)
- **Simple HTTP**: Standard upload (POST) and retrieval (GET) operations
- **NOSTR authentication**: Uploads signed with NOSTR keypairs (BUD-03)
- **Verification**: Hash in URL allows clients to verify content integrity

Relevant specs:
- **BUD-01**: Base server protocol
- **BUD-02**: Blob retrieval
- **BUD-03**: User uploads with NOSTR auth

---

## Proposed Hybrid Architecture

Use Blossom for fast primary serving, IPFS for resilient backup.

### Upload Flow

```
Artist uploads image
    ↓
Content node uploads to local Blossom server
    ↓
Return Blossom URL immediately (fast UX)
    ↓
Background job pins same file to IPFS
    ↓
Store both references in NOSTR event
```

### Retrieval Flow

```
Client requests image
    ↓
Try Blossom URL (primary)
    ↓
If Blossom fails → fall back to IPFS gateway
```

### Event Structure

```json
{
  "picture": "https://blossom.node.example/abc123def456.jpg",
  "picture_ipfs": "ipfs://QmXxx..."
}
```

---

## CDN Integration

Blossom works naturally with traditional CDN patterns:

```
Client request
    ↓
CDN edge (Cloudflare, Bunny, etc.)
    ↓ (cache miss)
Blossom origin server
```

Benefits:
- Hash-based URLs are perfectly cache-friendly (immutable content)
- Can set aggressive cache headers: `Cache-Control: public, max-age=31536000`
- Standard HTTP means no special gateway translation needed

This is simpler than trying to CDN-front IPFS gateways, where the IPFS-to-HTTP bridge adds unpredictability.

---

## Comparison: Blossom vs IPFS Clustering

| Aspect | IPFS Clustering | Blossom |
|--------|-----------------|---------|
| **Replication** | Automatic via protocol | Manual (upload to multiple servers) |
| **Discovery** | Built-in DHT | Custom coordination needed |
| **Peer assistance** | Nodes naturally help serve content | Would need to build federation layer |
| **CDN compatibility** | Awkward | Natural fit |
| **Serving speed** | Variable (gateway dependent) | Fast (standard HTTP) |

### IPFS Clustering Advantage

The appeal of IPFS clustering for Equaliser:
- Artists and labels naturally form a resilient mesh
- Cross-pinning means community hosts each other's content
- No central coordination required - it's baked into the protocol

### Blossom Limitation

A Blossom equivalent to IPFS clustering would require building:
- Federation/mutual hosting agreements
- Sync layer between servers
- Discovery mechanism (which servers have what)
- Trust and reciprocity rules

This would essentially be reimplementing what IPFS provides natively.

---

## Future Vision: Redundancy & Disaster Recovery

The hybrid model enables a powerful disaster recovery pattern.

### The Resilience Stack

1. **NOSTR relays**: Store all metadata and content references (distributed by design)
2. **IPFS network**: Store binary content with cross-pinning across artist community
3. **Blossom servers**: Fast serving layer, can be rebuilt from above

### Disaster Recovery Flow

If an artist's content node is completely lost:

```
Fresh content node
    ↓
Artist authenticates with nsec
    ↓
Query NOSTR relays for artist's events
(Kind 0 profile, Kind 30050 tracks, Kind 30051 albums)
    ↓
Extract IPFS CIDs from event tags
    ↓
Fetch content from IPFS
(via public gateways or other nodes in artist cluster)
    ↓
Re-upload to local Blossom server
    ↓
Platform fully restored
```

### Why This Works

- **NOSTR events are the manifest**: Already contain all metadata and content references
- **IPFS is the backup pool**: Artist community cross-pinning means content survives individual node failures
- **Blossom is rebuildable**: Just a serving layer that can be repopulated from IPFS

### Community Resilience

Artists participating in mutual IPFS pinning aren't just helping with day-to-day serving - they're collectively maintaining a disaster recovery pool. Content survives because multiple nodes in the community have it pinned.

---

## MVP Approach

For the initial MVP, a pragmatic path:

1. **Implement Blossom** for profile images and album art (fast, reliable serving)
2. **Continue IPFS** for encrypted HLS audio segments (content-addressing matters, latency less critical)
3. **Store both references** in NOSTR events where applicable
4. **Document the recovery path** even if not fully automated yet

Full automated disaster recovery tooling can come in later phases.

---

## Implementation Considerations

### Adding Blossom to Content Node

The Blossom server would be another service in the Docker Compose stack:

```yaml
services:
  blossom:
    image: <blossom-server-image>
    ports:
      - "3000:3000"
    volumes:
      - ./blossom-data:/data
    environment:
      - NOSTR_PRIVATE_KEY=${ARTIST_PRIVATE_KEY}
```

### Profile Editor Changes

Update the image upload flow:
- POST to Blossom server instead of IPFS API
- Receive Blossom URL immediately
- Background pin to IPFS for redundancy
- Store both URLs in Kind 0 event

### Client Fallback Logic

```javascript
async function loadImage(blobUrl, ipfsCid) {
  try {
    // Try Blossom first
    const response = await fetch(blobUrl);
    if (response.ok) return blobUrl;
  } catch (e) {
    // Fall back to IPFS
    return `https://ipfs.io/ipfs/${ipfsCid}`;
  }
}
```

---

## Open Questions

- Which Blossom server implementation to use? (or build custom?)
- Storage limits and cleanup policies for Blossom?
- How to handle the dual-reference pattern in existing NOSTR event kinds?
- Automated IPFS pinning strategy (which nodes, how many copies?)

---

## References

- [Blossom GitHub](https://github.com/hzrd149/blossom)
- [BUD Specifications](https://github.com/hzrd149/blossom/tree/master/buds)
- [NIP-96: HTTP File Storage Integration](https://github.com/nostr-protocol/nips/blob/master/96.md)
- [IPFS Clustering](https://cluster.ipfs.io/)
- [Equaliser Technical Specification](./equaliser-technical-specification.md)
