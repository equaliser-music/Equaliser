# Social Features Specification

**Version:** 2.0
**Date:** March 2026
**Status:** Implemented

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
- All events created through Equaliser are tagged with `["app", "Equaliser"]` before signing
- UI feeds filter exclusively on this tag — only tagged events are displayed
- This creates an **application-level overlay network** on top of standard NOSTR infrastructure
- Untagged events (spam, random NOSTR traffic) are stored on the relay but invisible to users
- `cleanup-relay.sh` periodically removes untagged events from non-protected pubkeys for storage hygiene
- The relay remains public — spam defence is at the application layer, not the relay layer

**Relay Tag Filtering:**
- The current codebase filters multi-character tags (`app`, `content-type`, `board`) **client-side** after fetching events broadly
- The Equaliser Relay resolves this with full tag indexing in PostgreSQL — relay-side filtering on `#app`, `#content-type`, `#board` works natively
- See [EQUALISER_RELAY.md](EQUALISER_RELAY.md) for the full specification

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

| Kind | Name | Purpose | Tags |
|------|------|---------|------|
| 0 | Profile | Artist/user metadata (name, bio, avatar) | `["app", "Equaliser"]`, `["user-type", "artist"]` (artists only — listeners omit `user-type`) |
| 1 | Short Text Note | Posts, replies, community threads |
| 3 | Contact List | Following/followers | |
| 4 | Encrypted DM | NIP-04 encrypted direct messages | |
| 6 | Repost | Sharing others' content | |
| 7 | Reaction | Likes, emoji reactions | |
| 10002 | Relay List | NIP-65 relay preferences | |

### Content-Type Tags (Kind 1 Subtypes)

Kind 1 events are differentiated using a `content-type` tag:

| Content Type | Tag | Description |
|-------------|-----|-------------|
| Feed post | `["content-type", "post"]` | Timeline posts (or no tag for backward compat) |
| Community thread | `["content-type", "thread"]` | Thread-starting post with subject + board |
| Community reply | `["content-type", "reply"]` | Reply within a community thread |

Events without a `content-type` tag are treated as feed posts for backward compatibility.

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

## Implemented Social Features

### 1. Feed (Implemented)

The main timeline showing Equaliser-tagged posts from followed users and artists.

**Pages:** `social.html` (Feed tab, default), `home.html` (sidebar feed), `user.html` (user's posts), `profile.html` (own posts + reposts with green indicator)

**Behaviour:**
- Fetches Kind 1 events from relay, filtered client-side for `["app", "Equaliser"]` tag
- `isTopLevelPost()` excludes replies (NIP-10 `e` tags with `root`/`reply` markers) and community content (`content-type: thread` or `content-type: reply`)
- New posts are tagged with `["content-type", "post"]`
- Posts without a `content-type` tag are treated as feed posts (backward compatibility)
- Each post shows reply count, like button, repost button
- Clicking a post navigates to `thread.html?id=<eventId>`

### 2. Threaded Replies (Implemented)

Twitter/X-style threaded view of a post and its replies.

**Page:** `thread.html?id=<eventId>`

**Behaviour:**
- Fetches root post by event ID
- Fetches all replies referencing it via `#e` tag (relay-side filter), then filters client-side for Equaliser events
- Replies displayed chronologically (flat, no nesting in v1)
- Reply composer for logged-in users
- Reply events use NIP-10 tags: `["e", rootEventId, "", "root"]`, `["p", rootAuthorPubkey]`

### 3. Community Message Boards (Implemented)

Reddit-style threaded discussions where artists and fans participate in organised, categorised conversations. Each artist's content node hosts its own community board. Users interact using their existing NOSTR identities (nsec/npub) -- no separate accounts needed.

Community is distinct from the Feed. Feed is a chronological timeline of updates (Twitter-like). Community is organised, threaded discussions (Reddit-like). They share the same NOSTR infrastructure but are separated by content tagging: the Feed page queries for `content-type: post`, the Community page queries for `content-type: thread` and follows NIP-10 `e` tags to load replies.

**Page:** `social.html?tab=community` (thread list) / `social.html?tab=community&thread=<eventId>` (thread detail)

The social page has two full-width top-level tabs ("Timeline" and "Community Threads") with purple underline active state. Sub-tabs (Your Feed / Global Feed, board filters) use white text highlight only.

#### Event Structure

**Thread (Opening Post):**

A new thread is a Kind 1 event with a subject line (NIP-14) and the `thread` content type:

```json
{
  "kind": 1,
  "pubkey": "<author-pubkey>",
  "created_at": 1709136000,
  "content": "I've been experimenting with recording live drums through a single overhead mic. The results are surprisingly good for lo-fi tracks. Anyone else tried minimal mic setups?",
  "tags": [
    ["app", "equaliser"],
    ["content-type", "thread"],
    ["subject", "Minimal mic setups for recording drums"],
    ["board", "production"]
  ]
}
```

**Reply:**

A reply references the thread root using NIP-10 conventions:

```json
{
  "kind": 1,
  "pubkey": "<replier-pubkey>",
  "created_at": 1709137000,
  "content": "I do this all the time! A single Coles 4038 about 3 feet above the kit, slightly forward. Works brilliantly for anything with a Bonham vibe.",
  "tags": [
    ["app", "equaliser"],
    ["content-type", "reply"],
    ["e", "<thread-event-id>", "", "root"],
    ["p", "<thread-author-pubkey>"]
  ]
}
```

**Nested Reply (Reply to a Reply):**

```json
{
  "kind": 1,
  "pubkey": "<another-pubkey>",
  "created_at": 1709138000,
  "content": "The 4038 is a great choice. I've had similar results with an AEA R84 in the same position.",
  "tags": [
    ["app", "equaliser"],
    ["content-type", "reply"],
    ["e", "<thread-event-id>", "", "root"],
    ["e", "<parent-reply-id>", "", "reply"],
    ["p", "<thread-author-pubkey>"],
    ["p", "<parent-reply-pubkey>"]
  ]
}
```

**Reaction (Upvote):**

Standard Kind 7 reaction events, used for thread and reply upvoting:

```json
{
  "kind": 7,
  "pubkey": "<reactor-pubkey>",
  "created_at": 1709139000,
  "content": "+",
  "tags": [
    ["app", "equaliser"],
    ["e", "<target-event-id>"],
    ["p", "<target-author-pubkey>"]
  ]
}
```

#### Boards (Categories)

Threads are categorised using a `board` tag. The artist configures which boards are available on their node.

| Board ID | Display Name | Description |
|----------|-------------|-------------|
| `general` | General | Anything goes |
| `music` | Music | Discuss tracks, albums, recommendations |
| `production` | Production | Recording, mixing, gear, techniques |
| `gigs` | Gigs & Events | Live shows, meetups, tours |

Artists can create custom boards relevant to their community. The board list is stored as a configuration in the orchestrator (not as a NOSTR event -- it is per-node config, not portable).

Board badge colours: general=blue, music=purple, production=green, gigs=amber.

#### Relay Query Patterns

All queries use client-side filtering for multi-character tags (`app`, `content-type`, `board`) because nostr-rs-relay only indexes single-letter tags. The Equaliser Relay resolves this with full tag indexing -- relay-side filtering on these tags works natively. See [EQUALISER_RELAY.md](EQUALISER_RELAY.md).

**List Threads (Community Home):**
- Relay filter: `{ "kinds": [1], "limit": 500 }`
- Client-side filter: Events where tags include `["app", "Equaliser"]` AND `["content-type", "thread"]`

**List Threads by Board:**
- Relay filter: Same as above
- Client-side filter: Same + `["board", "<board-name>"]`

**Load Thread Replies:**
- Relay filter: `{ "kinds": [1], "#e": ["<thread-event-id>"], "limit": 500 }`
- Client-side filter: Events where tags include `["app", "Equaliser"]` AND `["content-type", "reply"]`

**Load Reactions for Thread List:**
- Relay filter: `{ "kinds": [7], "#e": ["<thread-id-1>", "<thread-id-2>", "..."] }`
- No additional client-side filter needed

#### Sorting

Threads are sorted client-side:

| Sort | Logic |
|------|-------|
| **Newest** | Sort by `created_at` descending (default) |
| **Most Active** | Sort by reply count descending |
| **Most Liked** | Sort by reaction (Kind 7) count descending |
| **Latest Reply** | Sort by most recent reply's `created_at` |

For the current implementation, **Newest** is used -- it requires no additional queries.

#### Scope: Per-Artist Community

Each content node hosts its own community. When a fan visits an artist's page and opens the Community tab, they see threads on that artist's relay. The artist has moderation control over their own community. Different artists have different communities with different conversations. This mirrors the content node model -- each artist owns their infrastructure, including their community space.

In a future phase, a fan client could aggregate community threads from multiple artist nodes they follow, similar to how a Reddit homepage aggregates across subreddits. This would be a client-side feature -- query multiple relays, merge results, display unified thread list. The NOSTR protocol supports this natively since events have the same structure regardless of which relay they are on.

#### UI Design

**Community Page (`social.html?tab=community`):**
- Board selector tabs: All | General | Music | Production | Gigs
- "New Thread" button
- Thread list showing: subject (clickable), author avatar + name, board badge, reply count, reaction count, time since posted, time of last reply

**Thread Detail Page (`social.html?tab=community&thread=<event-id>`):**
- Thread subject as heading
- Opening post (full content, author, timestamp)
- Reply list below (threaded/nested)
- Reply composer at bottom with "Replying to [name]" context for nested replies

**Accessibility:**
- Community is accessible from the artist public page (`artist.html`) as a "Community" tab alongside Music, About, etc.
- Also accessible from the admin dashboard for artist moderation and participation

#### Authentication

Community uses the same session system as the rest of Equaliser:
- **Logged-in users** (via nsec, backup file, or NIP-07): Can post threads, reply, and react
- **Logged-out users**: Can read threads but cannot post
- **Artist**: Full moderation capabilities in admin view

#### Implementation Files

- `client/social.html` -- Unified social page with Feed + Community tabs
- `client/js/nostr-social.js` -- `fetchCommunityThreads()`, `fetchCommunityReplies()` functions
- `tools/seed-social.mjs` -- Seed data for populating test community content

#### Future Community Items

- Upvote/react to threads and replies (Kind 7)
- Sort by most active, most liked, latest reply
- Mute/block pubkeys
- Delete events (NIP-09)
- Pin threads
- Board management UI (add/remove/rename boards)
- Cross-node community aggregation (fan client queries multiple relays)

### External Replies — "Replies from wider Nostr"

Conversations on NOSTR cross application boundaries. An artist posts from Equaliser (with `["app", "Equaliser"]` tag), but fans may reply from Damus, Primal, or Amethyst — those replies lack the app tag. Without handling this, threads appear incomplete on Equaliser and important replies are invisible.

**Solution: triggered checking + on-demand fetch.**

The Equaliser Relay does NOT permanently cache untagged external replies. Instead:

1. **Triggered check:** When an Equaliser-tagged reply arrives on a thread, the relay queries standard relays in the background for other replies to the same root event. It counts untagged replies and stores just the count in `thread_external_refs`.

2. **UI indicator:** The client shows the count below the Equaliser thread — e.g. "4 replies from the wider Nostr network". The default thread view remains clean, showing only Equaliser-tagged content.

3. **On-demand fetch:** When the user clicks the indicator, the client calls `GET /api/catalogue/threads/{event_id}/external`, which fetches external replies live from standard relays (with short-lived caching). These are displayed inline but not permanently stored.

**UX benefits:**
- Default experience stays curated — only Equaliser content in threads
- Users are aware that external conversation exists (not silently hidden)
- Full conversation available on demand — no censorship of non-Equaliser replies
- Storage stays lean — only counts cached, not full events

**Context-aware acceptance:** The relay's tiered event acceptance policy also accepts untagged Kind 1 events if they reply to an existing event in `raw_events`. This means direct replies from Damus users are accepted and visible in threads alongside Equaliser replies. The external reply indicator covers replies that are further out in the network (not yet ingested). See [EQUALISER_RELAY.md](../EQUALISER_RELAY.md) for the full tiered acceptance policy.

---

### 4. Direct Messages (Implemented)

NIP-04 encrypted private messaging with two-panel inbox UI.

**Page:** `messages.html` / `messages.html?npub=<npub>`
**Module:** `client/js/nostr-dm.js`

**Behaviour:**
- Uses Kind 4 events with NIP-04 encryption (`NostrTools.nip04.encrypt/decrypt`)
- Falls back to NIP-07 browser extension (`window.nostr.nip04`) when available
- Two-panel layout: conversation list (left) + chat view (right)
- Message bubbles: incoming (dark bg, left), outgoing (purple gradient, right)
- URL parameter `?npub=<npub>` auto-opens a conversation with that user
- "Message" button on `user.html` profiles (not shown for own profile)
- `canDM()` check — requires either nsec login or NIP-07 extension with nip04 support

### 5. Sidebar Navigation (Implemented)

Single "Social" link in the sidebar bottom nav section (`client/js/sidebar.js`), alongside Profile and Settings. Appears only when logged in. The main Menu section contains Home, Discover (disabled), and Library (disabled). Messages is accessible from the profile page rather than the sidebar.

### 6. Seed Data (Implemented)

`tools/seed-social.sh` / `tools/seed-social.mjs` populates the relay with test content:
- 19 feed posts from users and artists
- 15 threaded replies on popular posts
- 8 community threads across all boards
- 27 community replies
- 34 NIP-04 encrypted DMs (conversations between all users/artists and Decky)
- 36 reactions (likes)

---

## Feed Types (Future)

Beyond the implemented Equaliser feed, future phases may add:

### Mentions Feed

Shows where the artist is mentioned across NOSTR.

**Query:** `{ kinds: [1, 7, 6, 9735], "#p": ["<artist-pubkey>"] }`

### All NOSTR Feed

Shows the artist's complete NOSTR presence across all relays, including external relay content.

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

The Equaliser Relay supports:
- Event acceptance policy (`equaliser_only`, `open`, `hybrid`) for ingestion-level filtering
- NIP-42 authentication for admin operations
- Full tag indexing for efficient event filtering

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
- [NIP-04: Encrypted Direct Messages](https://github.com/nostr-protocol/nips/blob/master/04.md)
- [NIP-07: Browser Extension](https://github.com/nostr-protocol/nips/blob/master/07.md) — `window.nostr` for signing and nip04 encryption
- [NIP-10: Reply Conventions](https://github.com/nostr-protocol/nips/blob/master/10.md)
- [NIP-14: Subject Tag](https://github.com/nostr-protocol/nips/blob/master/14.md) — Thread subject lines
- [NIP-23: Long-form Content](https://github.com/nostr-protocol/nips/blob/master/23.md)
- [NIP-25: Reactions](https://github.com/nostr-protocol/nips/blob/master/25.md)
- [NIP-09: Event Deletion](https://github.com/nostr-protocol/nips/blob/master/09.md) — Moderation deletions
- [NIP-51: Lists](https://github.com/nostr-protocol/nips/blob/master/51.md)
- [NIP-57: Zaps](https://github.com/nostr-protocol/nips/blob/master/57.md)
- [NIP-65: Relay List Metadata](https://github.com/nostr-protocol/nips/blob/master/65.md)
- [Blossom Protocol](https://github.com/hzrd149/blossom)
