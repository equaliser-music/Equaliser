# Competitor Comparison

This document compares Equaliser with other platforms in the decentralised music space.

## Quick Summary

| Feature | Equaliser | Wavlake | Fountain |
|---------|-----------|---------|----------|
| **Primary Focus** | Music distribution | Music streaming | Podcasts (+ music) |
| **Architecture** | Self-hosted content nodes | Centralised platform | Centralised app |
| **Identity** | NOSTR (artist-owned keys) | NOSTR (platform-managed) | Lightning + NOSTR |
| **Content Storage** | IPFS (self-hosted) | Blossom/CDN | Centralised CDN |
| **Payment Model** | Per-track unlock | Streaming sats | Value4Value streaming |
| **Artist Control** | Full (own infrastructure) | Partial (platform rules) | Minimal |
| **Discovery** | Federated relays | Platform-curated | App-curated |

## Detailed Comparison

### Wavlake

**What they do well:**
- Polished user experience with professional design
- Integrated Lightning payments that work
- Growing artist catalogue with real music
- Mobile app available
- Uses NOSTR for identity and Blossom for media

**How Equaliser differs:**
- **True self-hosting**: Wavlake hosts your content on their infrastructure. Equaliser artists run their own content nodes, meaning no platform can remove your music or change terms
- **No platform dependency**: Wavlake is a company with terms of service. Equaliser is infrastructure you control
- **IPFS vs Blossom**: Different storage approaches - IPFS is more mature but complex; Blossom is NOSTR-native but newer
- **Payment model**: Wavlake does streaming sats (micropayments per second). Equaliser plans per-track unlock (pay once, access forever)

**Wavlake's advantages:**
- Already working with real users and payments
- Lower barrier to entry (no technical setup)
- Mobile apps
- Established artist relationships

### Fountain

**What they do:**
- Podcast app with Value4Value payments
- Recently added music support
- Streaming sats model (pay per minute)
- Large existing user base from podcasts

**How Equaliser differs:**
- **Music-first**: Fountain is podcasts with music bolted on. Equaliser is built for music from the ground up
- **Artist infrastructure**: Fountain is a consumer app. Equaliser provides artist-owned infrastructure
- **Payment model**: Fountain's streaming sats works well for podcasts (long-form content) but arguably less suited for music where you might replay a 3-minute song 100 times
- **Identity ownership**: Fountain uses Lightning addresses primarily. Equaliser uses NOSTR keys that artists fully control

**Fountain's advantages:**
- Millions of existing users
- Proven payment infrastructure
- Cross-platform mobile apps
- Podcast + music in one place

## Equaliser's Unique Position

### True Decentralisation

Most "decentralised" platforms are really "decentralised-ish":
- They use decentralised protocols but host everything centrally
- Artists still depend on a company's infrastructure
- Platform can still enforce terms, take cuts, or shut down

Equaliser inverts this:
- Artist runs their own content node (Docker containers)
- NOSTR relays federate metadata (not controlled by any single party)
- IPFS stores content (content-addressed, portable)
- No single point of failure or control

### The Label Use Case

Most platforms focus on independent artists. Equaliser's architecture works well for **labels**:
- Run one content node for multiple artists
- Use hierarchical key derivation (NIP-06/BIP-32) for artist management
- Artists can take their keys and leave (true portability)
- Label infrastructure, artist ownership

### Trade-offs

Equaliser requires more technical capacity than alternatives:
- Must run Docker containers
- Need to understand NOSTR/IPFS basics
- No mobile app yet
- Payments not yet implemented

This is a deliberate trade-off: more control requires more capability.

## What's Working vs What's Missing

### Currently Working
- NOSTR identity creation and management
- Profile publishing to relays
- Track upload with HLS encoding
- Draft workflow (review before release)
- 30-second previews (free streaming)
- Self-hosted content node infrastructure

### Missing for MVP
- **Content encryption**: Full tracks accessible without payment
- **Payment integration**: No Lightning/Strike webhook yet
- **Key distribution**: No NIP-44 encrypted key delivery
- **Fan-facing player**: No public streaming interface

### Missing for Production
- Content resilience (pinning services or mutual pinning)
- Mobile applications
- Analytics and reporting
- Operational monitoring

## Market Positioning

Equaliser is not trying to compete with Spotify or even Wavlake on user experience. The target is:

1. **Artists/labels who want infrastructure ownership** - Not just "decentralised vibes" but actual control
2. **Technical early adopters** - People comfortable with Docker who understand the trade-offs
3. **NOSTR ecosystem** - Building on an identity layer that's gaining traction

The bet is that some artists care enough about ownership to accept the complexity, and that complexity will decrease over time as tooling improves.

## References

- [Wavlake](https://wavlake.com)
- [Fountain](https://fountain.fm)
- [NOSTR Protocol](https://github.com/nostr-protocol/nostr)
- [Blossom Media Protocol](https://github.com/hzrd149/blossom)
- [Technical Specification](./Technical%20Specification.md)
