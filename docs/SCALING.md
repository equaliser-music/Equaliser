# Scaling & Performance

**Version:** 1.0
**Date:** January 2026
**Status:** Future Consideration

---

## Overview

This document covers scaling strategies for Equaliser content nodes as artists grow from indie to mainstream traffic levels. The architecture is designed to start simple and scale incrementally.

---

## Traffic Tiers

| Tier | Monthly Streams | Concurrent Users | Infrastructure |
|------|-----------------|------------------|----------------|
| Indie | < 10,000 | 1-50 | Basic VPS |
| Growing | 10,000 - 100,000 | 50-500 | VPS + Cloudflare |
| Popular | 100,000 - 1M | 500-5,000 | VPS + Cloudflare + tuning |
| Mainstream | 1M+ | 5,000+ | Multiple nodes, dedicated infra |

Most indie artists will never leave the first tier. The architecture supports growth without requiring changes until actually needed.

---

## Cloudflare CDN

### Why Cloudflare

Cloudflare provides global content delivery with an exceptionally generous free tier:

| Feature | Free Tier |
|---------|-----------|
| Bandwidth | Unlimited |
| Requests | Unlimited |
| SSL/HTTPS | Included |
| DDoS protection | Included |
| Global edge locations | 300+ cities |
| WebSocket support | Yes |

### How It Works

```
Without Cloudflare:
Fan in Tokyo → Artist server in London → High latency

With Cloudflare:
Fan in Tokyo → Cloudflare Tokyo edge → Cached content → Low latency
                      ↓
              (First request only)
                      ↓
              Artist server in London
```

### What Gets Cached

**Automatically cached (static file extensions):**
- HLS segments (`.ts`)
- HLS playlists (`.m3u8`)
- Audio files (`.mp3`, `.wav`, `.flac`)
- Images (`.jpg`, `.png`, `.webp`)
- Static assets (`.js`, `.css`)

**Not cached (dynamic):**
- API calls (`/api/*`)
- WebSocket connections (relay)
- HTML pages

### CIDs Are Perfect for CDN

IPFS content-addressed files are ideal for caching:

| Property | CDN Benefit |
|----------|-------------|
| Immutable | Same CID = same content forever |
| Content-addressed | Never needs cache invalidation |
| Unique paths | No version conflicts |

### Setup

**1. Add domain to Cloudflare:**
- Create free Cloudflare account
- Add your domain
- Update nameservers at registrar

**2. Configure DNS:**
- Point A record to your VPS IP
- Enable orange cloud (proxy) icon

**3. Configure nginx cache headers:**

```nginx
location /ipfs/ {
    proxy_pass http://ipfs:8080;

    # Tell Cloudflare to cache forever (CIDs are immutable)
    add_header Cache-Control "public, max-age=31536000, immutable";

    # Pass through to IPFS gateway
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

**4. Cloudflare settings (optional tuning):**
- Caching > Tiered Cache: Enable (improves cache hit ratio)
- Speed > Auto Minify: Enable for JS/CSS
- SSL/TLS: Full (strict)

### WebSocket for Relay

Cloudflare proxies WebSocket connections for the NOSTR relay:

```nginx
location /relay {
    proxy_pass http://nostr-relay:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

WebSocket connections are proxied but not cached (stateful connections).

### Cost

| Tier | Monthly Cost | When Needed |
|------|--------------|-------------|
| Free | $0 | Most artists forever |
| Pro | $20 | Better analytics, more page rules |
| Business | $200 | SLA, priority support |

Reality: Free tier handles millions of requests. You'd need exceptional traffic to justify paying.

---

## HLS Streaming Benefits

HLS (HTTP Live Streaming) is already implemented and provides scaling benefits:

### Bandwidth Efficiency

```
Single file streaming:
- Fan requests 50MB MP3
- Server sends entire file
- Fan skips after 30 seconds → 45MB wasted

HLS streaming:
- Fan requests 10-second segments
- Server sends ~2MB at a time
- Fan skips after 30 seconds → only 6MB sent
```

### Concurrent User Scaling

| Approach | 100 Concurrent Users | Server Load |
|----------|---------------------|-------------|
| Single file | 100 × 50MB = 5GB active | High |
| HLS segments | 100 × 2MB = 200MB active | Low |

### CDN Synergy

HLS segments are small, static files - perfect for CDN caching:

```
Track: 4 minutes = ~24 segments
First play: Cloudflare fetches 24 segments from origin
Subsequent plays: All served from edge cache
```

---

## Relay Scaling

### Equaliser Relay

The custom Equaliser Relay uses PostgreSQL from the start, eliminating SQLite bottlenecks. Key scaling advantages:

- **Full tag indexing** — no client-side filtering workarounds at scale
- **Denormalised tables** — pre-parsed data for fast REST API queries
- **Single transaction ingestion** — events parsed into cache on arrival, no sync lag
- **Built-in peer syncer** — no separate Python process managing WebSocket connections
- **Go/Rust implementation** — better throughput than a Python-based syncer

The web client queries the relay's REST API for artist/track listings rather than making direct WebSocket queries. This provides fast, predictable responses from PostgreSQL.

### Scaling Path

1. **Connection pooling** — tune PostgreSQL connection pool for concurrent REST + WebSocket load
2. **Query optimisation** — indexes on hot paths, materialised views for common queries
3. **Read replicas** — PostgreSQL replication for read-heavy workloads
4. **Horizontal scaling** — multiple relay instances behind load balancer with shared database (only for mainstream traffic)

See [EQUALISER_RELAY.md](EQUALISER_RELAY.md) for the full relay specification and [DATABASE.md](DATABASE.md) for the cache schema.

### Realistic Assessment

For indie artists, relay scaling is unlikely to be the bottleneck. The relay handles lightweight metadata (track info, profiles, social events). Streaming bandwidth is the real scaling challenge, and that's solved by Cloudflare + HLS. The Equaliser Relay further reduces concern by combining relay, cache, and syncer into a single optimised service.

---

## IPFS Considerations

### Local Node Performance

The content node runs a local IPFS daemon. Performance considerations:

| Factor | Impact | Mitigation |
|--------|--------|------------|
| DHT lookups | Can be slow | Content is local, no DHT needed for own content |
| Peer connections | Memory/CPU | Limit peer count in config |
| Garbage collection | Disk I/O | Schedule during low traffic |

### Gateway Configuration

The nginx gateway proxies to local IPFS:

```nginx
location /ipfs/ {
    proxy_pass http://ipfs:8080;
    proxy_read_timeout 300s;
    proxy_buffering on;
    proxy_buffer_size 128k;
    proxy_buffers 4 256k;
}
```

### When IPFS Becomes a Bottleneck

If IPFS gateway can't keep up:

1. **Add Cloudflare first** - caches content at edge
2. **Increase IPFS resources** - more memory/CPU for daemon
3. **Add Blossom** - fast HTTP serving alongside IPFS storage
4. **Multiple IPFS nodes** - load balance across instances

---

## Blossom Hybrid Architecture

For high-traffic scenarios, combine IPFS storage with Blossom delivery:

```
Upload flow:
Artist uploads → IPFS (canonical storage) → Also push to Blossom

Playback flow:
Fan requests → Blossom (fast HTTP) → Fallback to IPFS if down
```

### Benefits

| IPFS | Blossom |
|------|---------|
| Content-addressed | Fast HTTP delivery |
| P2P resilience | CDN-friendly |
| Long-term storage | Low latency streaming |
| Decentralised | Simple server |

### Implementation

Content node could run both:

```yaml
services:
  ipfs:
    image: ipfs/kubo
    # Storage and resilience

  blossom:
    image: blossom-server
    # Fast delivery

  orchestrator:
    # Push to both on upload
```

---

## Equaliser Relay Network

### Two-Tier Relay Architecture

Equaliser uses two distinct sets of relays for different purposes:

**Standard NOSTR relays** (damus, nos.lol, primal, etc.)
- Social events: Kind 1 posts, Kind 6 reposts, Kind 7 likes
- Profile metadata: Kind 0
- Contact lists: Kind 3, Kind 10002
- Interoperability with the wider NOSTR ecosystem (Damus, Primal, etc.)

**Equaliser relay network** (other Equaliser content nodes)
- Music metadata: Kind 30050 track/release events
- Album data, pricing, cover art references
- Equaliser-specific application data

This separation ensures social interactions broadcast widely for NOSTR interop, while music catalogue data replicates only across Equaliser nodes that need it.

### Why a Separate Music Relay Network?

Standard NOSTR relays are optimised for social events (short text, reactions, profiles). Music metadata has different characteristics:

- **Larger events** — track events contain IPFS CIDs, pricing, HLS manifests, Blossom hashes
- **Targeted audience** — only Equaliser clients need this data
- **Redundancy requirements** — if an artist's node goes down, their catalogue must remain discoverable
- **Cross-node discovery** — fans on one Equaliser node should find artists on another

### How It Works

Artists configure a list of Equaliser relays (other content nodes they trust):

```
Artist's content node relay:  ws://my-node.example.com/relay
Equaliser peer relays:        ws://label-node.example.com/relay
                              ws://collab-node.example.com/relay
```

The orchestrator publishes music events to the local relay AND the configured Equaliser peer relays. This gives:

1. **Redundancy** — catalogue survives if one node goes offline
2. **Discovery** — clients query multiple Equaliser relays for music content
3. **Federation** — artists on different nodes can appear in each other's catalogues

### Complementary to IPFS Pinning

This relay network handles **metadata** replication. Combined with IPFS cross-pinning between nodes, you get full redundancy:

| Layer | What It Replicates | Technology |
|-------|--------------------|------------|
| Metadata | Track info, pricing, profiles | NOSTR relay network |
| Audio content | HLS segments, original files | IPFS mutual pinning |
| Original masters | Lossless audio files | Blossom cross-server |

### Implementation Notes

- Could use a dedicated tag (e.g. `["equaliser-relay", "wss://..."]`) on the artist's Kind 0 profile
- Or a custom event kind for Equaliser relay lists (similar to Kind 10002 for standard relays)
- The `["app", "Equaliser"]` tag on events ensures only Equaliser content is replicated
- Peer relay lists could be managed in the admin settings UI

### Status

Future phase. Depends on having multiple active content nodes to federate between. Current single-node deployments publish music events to local relay only, with social events going to standard NOSTR relays.

---

## VPS Sizing

### Recommended Specs by Tier

With the Equaliser Relay and PostgreSQL added to the stack, minimum RAM requirements increase slightly:

| Tier | CPU | RAM | Storage | Bandwidth | Monthly Cost |
|------|-----|-----|---------|-----------|--------------|
| Indie | 1 vCPU | 2GB | 50GB | 2TB | $10-15 |
| Growing | 2 vCPU | 4GB | 100GB | 4TB | $20-30 |
| Popular | 4 vCPU | 8GB | 200GB | 8TB | $40-60 |

The Equaliser Relay combines relay, syncer, and REST API in a single process. PostgreSQL adds ~200MB RAM overhead. Both fit comfortably within the indie tier but should be monitored as event volume grows.

### Provider Recommendations

| Provider | Strengths | Starting Price |
|----------|-----------|----------------|
| Hetzner | Best value, EU locations | €4/mo |
| DigitalOcean | Simple, good docs | $6/mo |
| Vultr | Many locations | $5/mo |
| Linode | Reliable, good support | $5/mo |

### Storage Considerations

Audio files add up:
- HLS encoded track: ~30-50MB (full + preview)
- 100 tracks: 3-5GB
- 1000 tracks: 30-50GB

Plan storage based on catalog size.

---

## Monitoring

### Key Metrics

| Metric | What It Tells You |
|--------|-------------------|
| Cloudflare cache hit ratio | Are segments being cached? |
| Origin bandwidth | How much is bypassing cache? |
| Relay connections | Concurrent users |
| IPFS gateway latency | Content delivery speed |
| Disk usage | Storage capacity |

### Tools

**Cloudflare Analytics (free):**
- Request volume
- Bandwidth saved
- Cache hit ratio
- Threat blocking

**VPS monitoring:**
- htop / top - CPU/memory usage
- iotop - disk I/O
- nethogs - bandwidth by process

**Application logging:**
- nginx access logs
- Orchestrator logs
- Relay connection counts

---

## Scaling Checklist

### Starting Out (Indie)
- [ ] Basic VPS ($10-15/month)
- [ ] Docker Compose deployment
- [ ] Let's Encrypt SSL
- [ ] Default configuration

### First Growth Spurt
- [ ] Add Cloudflare (free)
- [ ] Configure cache headers for IPFS
- [ ] Enable Cloudflare analytics
- [ ] Monitor cache hit ratio

### Continued Growth
- [ ] Tune nginx buffering
- [ ] Increase VPS resources if needed
- [ ] Consider PostgreSQL for relay
- [ ] Evaluate Blossom for streaming

### Mainstream (if ever)
- [ ] Multiple VPS/nodes
- [ ] Dedicated database server
- [ ] Load balancing
- [ ] CDN on paid tier for SLA
- [ ] Professional monitoring

---

## Summary

The scaling path:

```
Start simple (VPS + Docker)
       ↓
Add Cloudflare when convenient (free, huge benefit)
       ↓
Tune as needed (cache headers, resources)
       ↓
Advanced options only if truly needed (Blossom, multi-node)
```

Most artists will never need anything beyond Cloudflare on the free tier. The architecture is designed for graceful scaling without requiring changes until actually necessary.

The real insight: HLS + CIDs + Cloudflare = effectively unlimited streaming on a free CDN tier. This combination makes indie music distribution viable at any scale.
