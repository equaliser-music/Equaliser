# Social Features Specification

**Version:** 1.0
**Date:** January 2026
**Status:** Draft

---

## Overview

Equaliser's social features enable artists to engage with fans through NOSTR's decentralised protocol. The design operates on two layers: a curated Equaliser-native experience and integration with the wider NOSTR ecosystem.

This approach gives artists a focused, music-centric social presence while allowing them to participate in and draw audiences from the broader NOSTR network.

---

## Equaliser as a NOSTR Client

Equaliser is a **specialised NOSTR client** focused on music distribution and artist-fan interaction. It sits alongside other purpose-built NOSTR clients:

| Client | Focus |
|--------|-------|
| Damus | General social |
| Primal | General social + caching |
| Wavlake | Music streaming |
| Habla | Long-form blogging |
| Zapstr | Podcasts |
| **Equaliser** | Music distribution + artist social |

### What Makes Equaliser Different

Unlike most NOSTR clients that rely on third-party infrastructure, Equaliser bundles everything into a **self-hosted content node** that artists control:

- **Own relay** - not dependent on public relay availability
- **Own storage** - IPFS on their infrastructure
- **Own orchestration** - API layer they operate

### Interoperability

Because Equaliser uses standard NOSTR protocols, an artist's npub works everywhere:

- Post from Equaliser → visible on Damus, Primal, Amethyst
- Receive a zap on Primal → see it in Equaliser analytics
- Get followed on Amethyst → count it in Equaliser stats
- Share a track link → plays in any NOSTR music client

**One identity, multiple clients, each optimised for different use cases.**

### Benefits

**For Artists:**
- Own your identity (NOSTR keys you control)
- Own your content (IPFS on your node)
- Own your fan relationships (your relay, your data)
- Own your revenue (Lightning direct to your wallet)
- Own your social presence (curated, music-focused feed)
- Participate in wider ecosystem without platform lock-in

**For Fans:**
- One identity across all music and social
- Direct support to artists (no middleman taking a cut)
- Censorship-resistant access to music
- Portable playlists and listening history
- Privacy-preserving payments (Cashu/eCash option)

**For the Ecosystem:**
- Real-world utility for Bitcoin/Lightning
- Proves NOSTR works beyond social media
- Open protocol others can build on
- Blueprint for decentralised creative platforms

---

## Two-Layer Architecture

### Layer 1: Equaliser Network (Internal)

The Equaliser network consists of content stored on artist content node relays and IPFS. Content node relays are **standard public NOSTR relays** — open for both reading and writing — which is essential for decentralisation (cross-node discovery, fan interaction, artist-to-artist publishing). The Equaliser application layer defines what is "inside" the network using app tagging.

**App-Tag Filtering (Implemented):**
- All events created through Equaliser are tagged with `["app", "equaliser"]` before signing
- UI feeds filter exclusively on this tag — only tagged events are displayed
- This creates an **application-level overlay network** on top of standard NOSTR infrastructure
- Untagged events (spam, random NOSTR traffic) are stored on the relay but invisible to users
- `cleanup-relay.sh` periodically removes untagged events from non-protected pubkeys for storage hygiene
- The relay remains public — spam defence is at the application layer, not the relay layer

**Characteristics:**
- Content lives on the artist's content node relay
- Events tagged with `["app", "equaliser"]` for identification and filtering
- Media uploaded to IPFS via the content node
- Tightly integrated with releases, tracks, and artist pages
- Curated, music-focused experience
- Artist has full moderation control via app-tag boundary

**Use Cases:**
- Track and album announcements linking to Kind 30050 events
- Artist updates about upcoming releases, tours, etc.
- Fan comments and reactions on specific releases
- Long-form blog posts about the creative process

**Benefits:**
- Fast, local content delivery
- Artist controls what appears (app-tag filtering)
- Consistent branding and experience
- Direct integration with music content
- Relay stays public for decentralisation while UI stays clean

### Layer 2: Wider NOSTR (External)

The wider NOSTR ecosystem includes public relays and standard NOSTR clients.

**Characteristics:**
- Artists post to public relays (relay.damus.io, nos.lol, etc.)
- Standard NOSTR clients can view and interact with content
- Uses community file hosting (nostr.build, Blossom, etc.)
- Exposes artist to broader NOSTR audience
- Artist cannot moderate external relays

**Use Cases:**
- Cross-promotion with wider NOSTR community
- Fans discover artist via Damus, Primal, Amethyst, etc.
- Artist participates in NOSTR-wide conversations
- Linking to Equaliser content from external posts

**Benefits:**
- Larger potential audience
- Network effects of NOSTR ecosystem
- Interoperability with existing NOSTR tools
- Credibility within NOSTR community

### How The Layers Connect

- Artist's npub is identical in both layers
- Content created in Equaliser can optionally broadcast to public relays
- External mentions can be "pulled in" to the local relay
- The content node relay is the artist's "home base"

---

## NOSTR Event Kinds

### Standard Events (Used in Both Layers)

| Kind | Name | Purpose |
|------|------|---------|
| 0 | Profile | Artist metadata (name, bio, avatar) |
| 1 | Short Text Note | Posts, replies, comments |
| 3 | Contact List | Following/followers |
| 6 | Repost | Sharing others' content |
| 7 | Reaction | Likes, emoji reactions |
| 10002 | Relay List | NIP-65 relay preferences |

### Long-Form Content (NIP-23)

| Kind | Name | Purpose |
|------|------|---------|
| 30023 | Long-form Content | Blog posts, articles, announcements |

**Structure:**
```json
{
  "kind": 30023,
  "pubkey": "<artist-pubkey>",
  "created_at": 1706000000,
  "content": "# Blog Post Title\n\nMarkdown content here...",
  "tags": [
    ["d", "unique-post-slug"],
    ["title", "My Blog Post Title"],
    ["summary", "A brief summary of the post"],
    ["published_at", "1706000000"],
    ["app", "Equaliser"]
  ]
}
```

### Equaliser-Specific Events

| Kind | Name | Purpose |
|------|------|---------|
| 30050 | Track Metadata | Music releases (existing) |
| 30051 | Album Metadata | Album groupings (existing) |

### Zaps (Payments)

| Kind | Name | Purpose |
|------|------|---------|
| 9734 | Zap Request | Request for Lightning payment |
| 9735 | Zap Receipt | Confirmation of payment |

---

## Feed Types

The artist admin interface should provide multiple feed views:

### 1. Equaliser Feed

Shows content from the local content node relay, filtered to Equaliser-tagged events only.

**Includes:**
- Artist's own Equaliser-tagged posts
- Fan comments tagged with `["app", "equaliser"]`
- Reactions to tracks and releases (tagged)
- Content explicitly imported from external relays

**Filter (Implemented):** Only events with `["app", "equaliser"]` tag are displayed. This is the primary spam defence — the relay is public but the UI only shows Equaliser ecosystem content.

### 2. Mentions Feed

Shows where the artist is mentioned across NOSTR.

**Sources:**
- Local relay
- Configured public relays

**Query:**
```json
{
  "kinds": [1, 7, 6, 9735],
  "#p": ["<artist-pubkey>"]
}
```

**Includes:**
- Direct mentions in posts
- Reactions to artist's content
- Reposts of artist's content
- Zaps received

### 3. All NOSTR Feed

Shows the artist's complete NOSTR presence across all relays.

**Sources:**
- Local relay
- All configured public relays

**Includes:**
- Everything from Equaliser Feed
- Everything from Mentions Feed
- Artist's posts on external relays
- Replies and threads

---

## Content Creation

### Posting from Equaliser

When an artist creates a post in the Equaliser admin:

1. **Compose**: Text editor with markdown support
2. **Media**: Optional image upload to IPFS
3. **Destination**: Choose where to publish
   - Local relay only (Equaliser network)
   - Local + public relays (both layers)
4. **Sign**: Event signed with artist's private key
5. **Publish**: Broadcast to selected relays

### Media Handling

**Equaliser Network (Layer 1):**
- Images uploaded to IPFS via content node
- URL format: `https://ipfs.io/ipfs/{CID}` (public gateway)
- CID stored in Equaliser-specific tag for resilience
- Fast local access via content node gateway

**Wider NOSTR (Layer 2):**
- Artists can use any NOSTR-compatible hosting:
  - nostr.build
  - Blossom (BUD servers)
  - Any NIP-96 compatible server
- URLs embedded in note content as usual
- Equaliser doesn't manage external media

### Post Structure

**Short Post (Kind 1):**
```json
{
  "kind": 1,
  "pubkey": "<artist-pubkey>",
  "created_at": 1706000000,
  "content": "New track dropping next week! 🎵\n\nhttps://ipfs.io/ipfs/QmCoverArt...",
  "tags": [
    ["app", "Equaliser"],
    ["t", "newmusic"],
    ["image_cid", "QmCoverArt..."]
  ]
}
```

**Blog Post (Kind 30023):**
```json
{
  "kind": 30023,
  "pubkey": "<artist-pubkey>",
  "created_at": 1706000000,
  "content": "# Behind the Scenes\n\nThe story of how we recorded our latest album...",
  "tags": [
    ["d", "behind-the-scenes-album-recording"],
    ["title", "Behind the Scenes"],
    ["summary", "The story of recording our latest album"],
    ["image", "https://ipfs.io/ipfs/QmBlogImage..."],
    ["published_at", "1706000000"],
    ["app", "Equaliser"]
  ]
}
```

---

## Moderation

### Philosophy

Equaliser enables artist-controlled moderation within their content node while respecting NOSTR's decentralised, uncensorable nature.

**What artists CAN do:**
- Filter content on their own relay
- Block/mute specific pubkeys
- Choose what external content to import
- Curate the experience on their node

**What artists CANNOT do:**
- Delete content from public relays
- Prevent fans from discussing them elsewhere
- Censor legitimate criticism on the wider network

**This is intentional:**
- Artists get a curated, safe space on their node
- Public NOSTR remains open and uncensorable
- The artist's node is the "official" channel
- Fans know where to go for authentic content

### Moderation Tools

**Mute List (NIP-51 Kind 10000):**
- List of pubkeys to hide from feeds
- Stored as NOSTR event, portable across clients
- Applied when rendering feeds

**Block List:**
- Pubkeys blocked from posting to local relay
- Configured at relay level
- More aggressive than muting

**Keyword Filters:**
- Hide posts containing specific words/phrases
- Client-side filtering
- Configurable per artist

**Import Rules:**
- Control what external content gets pulled into local relay
- Whitelist specific pubkeys
- Require manual approval for mentions

### Implementation

The content node relay (nostr-rs-relay) supports:
- Pubkey whitelists/blacklists via `config.toml`
- NIP-42 authentication for write access
- Event filtering by kind and tags

Additional moderation can be implemented at the UI layer:
- Filter events before display
- Apply mute lists client-side
- Queue external content for approval

---

## Sync Between Layers

### Outbound Sync (Equaliser → Public)

When artist chooses to broadcast to public relays:

1. Event created and signed
2. Published to local relay first
3. Then published to each configured public relay
4. Status tracked per relay (success/failure)

### Inbound Sync (Public → Equaliser)

Pulling external content into local relay:

**Automatic:**
- Subscribe to mentions on public relays
- Import based on configured rules
- Store locally for fast access

**Manual:**
- Artist browses external content
- Clicks "Import" on specific events
- Event copied to local relay

**Considerations:**
- Don't duplicate events (check by ID)
- Respect rate limits on public relays
- Consider storage implications

---

## Admin UI Requirements

### Feed Page (`/admin/feed.html`)

**Layout:**
- Tabbed interface: Equaliser | Mentions | All NOSTR
- Compose box at top
- Chronological feed below
- Sidebar for filters/settings

**Compose Box:**
- Text area with markdown preview
- Image upload button (→ IPFS)
- Destination selector (local only / local + public)
- Post button

**Feed Items:**
- Author avatar and name
- Content with media previews
- Timestamp (relative)
- Reply/React/Repost buttons
- Moderation actions (mute, hide)

**Threading:**
- Show reply context
- Expand to view full conversation
- Inline reply composition

### Blog Page (`/admin/blog.html`)

**Layout:**
- List of published posts
- "New Post" button
- Draft management

**Editor:**
- Title field
- Markdown editor with preview
- Featured image upload
- Publish/Save Draft buttons
- Slug/URL configuration

### Settings Integration

**Moderation Settings:**
- Mute list management
- Keyword filters
- Import rules for external content

**Relay Settings:**
- Configure which public relays to sync with
- Per-relay read/write preferences
- Sync status and health

---

## Future Considerations

### Community (Message Board) — Specified

See [COMMUNITY.md](./COMMUNITY.md) for the full specification. Reddit-style threaded discussions using Kind 1 events with `["content-type", "thread"]` tags, organised into boards. Per-artist scope — each content node hosts its own community.

### Notifications

- Real-time WebSocket subscriptions
- Push notifications (requires service worker)
- Unread counts and badges
- Email digest option

### Analytics

- Engagement metrics per post
- Follower growth tracking
- Popular content identification
- Integration with broader analytics feature

### Verified Fans

- NIP-05 verification for trusted commenters
- Badge system for active community members
- Tiered access (e.g., supporters see exclusive content)

---

## References

- [NIP-01: Basic Protocol](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-10: Reply Conventions](https://github.com/nostr-protocol/nips/blob/master/10.md)
- [NIP-23: Long-form Content](https://github.com/nostr-protocol/nips/blob/master/23.md)
- [NIP-25: Reactions](https://github.com/nostr-protocol/nips/blob/master/25.md)
- [NIP-51: Lists](https://github.com/nostr-protocol/nips/blob/master/51.md)
- [NIP-57: Zaps](https://github.com/nostr-protocol/nips/blob/master/57.md)
- [NIP-65: Relay List Metadata](https://github.com/nostr-protocol/nips/blob/master/65.md)
- [Blossom Protocol](https://github.com/hzrd149/blossom)
