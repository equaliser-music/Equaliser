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

### nostr-rs-relay Limits

The default relay (nostr-rs-relay with SQLite) handles:
- Thousands of events
- Hundreds of concurrent connections
- Typical indie artist traffic easily

### When to Upgrade

Signs you're outgrowing SQLite:
- Connection timeouts during peak traffic
- Slow queries on large event sets
- Database lock contention

### Upgrade Path

**Option 1: PostgreSQL backend**

nostr-rs-relay supports PostgreSQL:

```toml
[database]
engine = "postgres"
connection = "postgres://user:pass@localhost/nostr"
```

Benefits:
- Better concurrency
- Connection pooling
- No single-writer bottleneck

**Option 2: strfry relay**

Higher-performance relay implementation:
- LMDB backend (faster than SQLite)
- Better memory efficiency
- Handles more concurrent connections

**Option 3: Horizontal scaling**

Multiple relay instances behind load balancer:
- Each instance handles subset of connections
- Shared database or event sync between instances
- Complex, only for mainstream traffic

### Realistic Assessment

For indie artists, relay scaling is unlikely to be the bottleneck. The relay handles lightweight metadata (track info, profiles, social events). Streaming bandwidth is the real scaling challenge, and that's solved by Cloudflare + HLS.

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

## VPS Sizing

### Recommended Specs by Tier

| Tier | CPU | RAM | Storage | Bandwidth | Monthly Cost |
|------|-----|-----|---------|-----------|--------------|
| Indie | 1 vCPU | 2GB | 50GB | 2TB | $10-15 |
| Growing | 2 vCPU | 4GB | 100GB | 4TB | $20-30 |
| Popular | 4 vCPU | 8GB | 200GB | 8TB | $40-60 |

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
