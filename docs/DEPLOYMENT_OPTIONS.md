# Deployment Options & Sustainability

**Version:** 1.0
**Date:** January 2026
**Status:** Future Consideration

---

## Overview

Equaliser is open source software that artists can self-host. However, not all artists are technical, and sustainability requires a viable path forward. This document outlines deployment options that serve different user needs while potentially providing revenue to sustain the project.

The key principle: **hosting is optional infrastructure, not a platform tax.** Artists keep 100% of their music revenue regardless of how they deploy.

---

## The Equaliser Stack

| Level | Product | Target | Revenue Model |
|-------|---------|--------|---------------|
| 1. Software | Open source Docker stack | Developers, technical artists | Free (community) |
| 2. Managed | Hosted content nodes | Most artists, labels | Monthly subscription |
| 3. Hardware | Pre-configured home server | Sovereignty-focused artists | One-time purchase |

---

## Level 1: Self-Hosted (Open Source)

**Target:** Technical artists, developers, DIY enthusiasts

**What they get:**
- Full source code on GitHub
- Docker Compose deployment
- Documentation and community support
- Complete control and customisation

**Requirements:**
- VPS or home server with Docker
- Basic command line knowledge
- Willingness to manage updates and backups

**Cost to artist:** Infrastructure only (VPS ~£5-20/month or home server electricity)

**Revenue to project:** None (but builds community and credibility)

---

## Level 2: Managed Hosting

**Target:** Artists who want the benefits without the technical overhead

**What they get:**
- Hosted content node (relay + IPFS + orchestrator)
- Custom subdomain (artist.equaliser.io) or own domain
- Automatic updates and security patches
- Daily backups with easy restore
- Uptime monitoring and alerts
- Email/chat support

**Tier structure:**

| Tier | Monthly | Storage | Bandwidth | Artists | Support |
|------|---------|---------|-----------|---------|---------|
| Starter | £5-10 | 10GB | 50GB | 1 | Community |
| Artist | £15-25 | 50GB | 200GB | 1 | Email |
| Label | £50-100 | 200GB | 1TB | 10 | Priority |
| Enterprise | Custom | Custom | Custom | Unlimited | Dedicated |

**What's included:**
- Content node infrastructure
- SSL certificates
- DNS management
- Relay configuration
- IPFS pinning on managed cluster

**What's NOT included (artist still owns):**
- NOSTR keys (artist controls identity)
- Music revenue (Lightning goes direct to artist)
- Content rights (artist owns everything)
- Fan relationships (data exportable anytime)

**Exit strategy:** Full data export at any time. Artist can migrate to self-hosted or another provider. No lock-in.

---

## Level 3: Hardware (Plug-and-Play)

**Target:** Artists who want true sovereignty without technical complexity

**Vision:** Buy a box, plug it in, own your music infrastructure forever.

### Product Concept

**Equaliser Home Node:**
- Pre-configured hardware with Equaliser stack
- Plug in, connect to internet, runs automatically
- Web-based setup wizard
- Automatic updates (optional, can disable)
- Physical ownership of all data

### Hardware Options

**Option A: Raspberry Pi Based**
- Raspberry Pi 5 (8GB)
- 500GB-2TB SSD
- Custom case with branding
- Pre-flashed SD card
- Price: £150-250

**Option B: Small x86 Box**
- Intel N100 or similar mini PC
- 500GB-2TB NVMe
- Fanless/quiet operation
- More headroom for growth
- Price: £250-400

### What's Bundled

The home node could include:

| Component | Purpose |
|-----------|---------|
| Equaliser Stack | Music distribution + social |
| Bitcoin/Lightning Node | Direct payments (optional) |
| NOSTR Relay | Optimised for music events |
| IPFS Node | Decentralised storage |
| Backup Battery | Uptime during power cuts |

### Benefits Over Managed

- **True sovereignty** - hardware in your house
- **No ongoing fees** - one-time purchase
- **Works offline** - local network access
- **Survives project** - runs even if Equaliser disappears
- **Educational** - learn about the stack

### Potential Partners

Existing home server ecosystems to integrate with:

| Platform | Integration Type |
|----------|-----------------|
| **Start9** | Equaliser as a service package |
| **Umbrel** | App store listing |
| **RaspiBlitz** | Community integration |
| **MyNode** | Additional package |

These platforms already have audiences interested in self-sovereignty. Equaliser could be a compelling addition for musicians in those communities.

---

## Sustainability Model

### Revenue Streams

| Stream | Description | Alignment |
|--------|-------------|-----------|
| Managed hosting | Monthly subscriptions | Convenience, not extraction |
| Hardware sales | One-time margin | Sovereignty product |
| Support contracts | Priority help for labels | Value-added service |
| Training/consulting | Setup and migration help | Education |

### What We Don't Do

- **No cut of music sales** - 100% goes to artist
- **No advertising** - never
- **No data selling** - artist data is theirs
- **No artificial lock-in** - export anytime

### Alignment with Values

The revenue model is explicitly designed to:

1. **Serve non-technical artists** - they need hosting, we provide it fairly
2. **Sustain development** - ongoing work needs ongoing funding
3. **Avoid platform dynamics** - we sell infrastructure, not access
4. **Maintain trust** - no conflict between our revenue and artist success

---

## Roadmap

### Phase 1: Open Source Only (Current)

- Docker Compose deployment
- Documentation and guides
- Community support via GitHub

### Phase 2: Managed Hosting (Future)

- Hosted infrastructure
- Subscription management
- Support systems
- Automated provisioning

### Phase 3: Hardware (Future)

- Hardware partnerships or custom builds
- Manufacturing and fulfilment
- Firmware/update management
- Start9/Umbrel integration

---

## Open Questions

1. **Pricing research** - what do indie artists actually pay for hosting/tools?
2. **Hardware demand** - is there appetite for a dedicated music node?
3. **Support capacity** - how to scale support without huge overhead?
4. **Legal structure** - non-profit, co-op, or sustainable business?
5. **Geographic distribution** - EU/US/global hosting locations?

---

## References

- [Start9](https://start9.com) - Sovereign computing platform
- [Umbrel](https://umbrel.com) - Home server OS
- [RaspiBlitz](https://raspiblitz.org) - DIY Bitcoin/Lightning node
- [Wavlake](https://wavlake.com) - NOSTR music platform (comparison)
