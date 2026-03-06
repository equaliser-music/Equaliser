# Community — Message Board Specification

**Version:** 2.0
**Date:** March 2026
**Status:** Implemented

---

## Overview

Community is a Reddit-style message board built on NOSTR, where artists and fans can participate in threaded discussions. Each artist's content node hosts its own community board. Users interact using their existing NOSTR identities (nsec/npub) — no separate accounts needed.

Community is distinct from the Feed feature. Feed is a chronological timeline of updates (Twitter-like). Community is organised, threaded discussions (Reddit-like). They share the same NOSTR infrastructure but are separated by content tagging.

---

## Content Type Separation

All Equaliser social content uses Kind 1 events with the `["app", "equaliser"]` tag. A second tag, `content-type`, distinguishes between features:

| Feature | Tag | Description |
|---------|-----|-------------|
| Feed | `["content-type", "post"]` | Timeline updates, short announcements |
| Community thread | `["content-type", "thread"]` | Thread-starting post with a subject line |
| Community reply | `["content-type", "reply"]` | Reply within a thread |

The Feed page queries for `content-type: post`. The Community page queries for `content-type: thread` (to list threads) and follows NIP-10 `e` tags to load replies within a thread.

This means:
- Feed and Community never show each other's content
- Both are standard Kind 1 events — compatible with any NOSTR client
- The `["app", "equaliser"]` tag keeps both within the Equaliser ecosystem
- `cleanup-relay.sh` protects both equally

---

## NOSTR Event Structure

### Thread (Opening Post)

A new thread is a Kind 1 event with a subject line (NIP-14) and the `thread` content type:

```json
{
  "kind": 1,
  "pubkey": "<author-pubkey>",
  "created_at": 1709136000,
  "content": "I've been experimenting with recording live drums through a single overhead mic. The results are surprisingly good for lo-fi tracks. Anyone else tried minimal mic setups?\n\nHere's what I've found works best...",
  "tags": [
    ["app", "equaliser"],
    ["content-type", "thread"],
    ["subject", "Minimal mic setups for recording drums"],
    ["board", "production"]
  ]
}
```

### Reply

A reply references the thread root and (optionally) a parent reply using NIP-10 conventions:

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

### Nested Reply (Reply to a Reply)

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

### Reaction (Upvote)

Standard Kind 7 reaction events. Used for thread upvoting and reply upvoting:

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

---

## Boards (Categories)

Threads are categorised using a `board` tag. The artist configures which boards are available on their node.

### Default Boards

| Board ID | Display Name | Description |
|----------|-------------|-------------|
| `general` | General | Anything goes |
| `music` | Music | Discuss tracks, albums, recommendations |
| `production` | Production | Recording, mixing, gear, techniques |
| `gigs` | Gigs & Events | Live shows, meetups, tours |

### Custom Boards

Artists can create custom boards relevant to their community. The board list is stored as a configuration in the orchestrator (not as a NOSTR event — it's per-node config, not portable).

### Board Filtering

The community page filters threads by board. Filtering is done **client-side** after fetching all Kind 1 events from the relay (see Relay Query Limitations below).

---

## Relay Queries

### Relay Query Limitations

The current codebase uses client-side filtering for multi-character tags (`app`, `content-type`, `board`) because nostr-rs-relay only indexes single-letter tags. The Equaliser Relay resolves this with full tag indexing — relay-side filtering on these tags works natively. See [EQUALISER_RELAY.md](EQUALISER_RELAY.md).

All queries below show the current relay filter + the client-side filter that must be applied after fetching.

### List Threads (Community Home)

**Relay filter:** `{ "kinds": [1], "limit": 500 }`

**Client-side filter:** Events where `tags` includes `["app", "Equaliser"]` AND `["content-type", "thread"]`

### List Threads by Board

**Relay filter:** Same as above

**Client-side filter:** Same + `["board", "<board-name>"]`

### Load Thread Replies

**Relay filter:** `{ "kinds": [1], "#e": ["<thread-event-id>"], "limit": 500 }`

**Client-side filter:** Events where `tags` includes `["app", "Equaliser"]` AND `["content-type", "reply"]`

### Load Reactions for Thread List

**Relay filter:** `{ "kinds": [7], "#e": ["<thread-id-1>", "<thread-id-2>", "..."] }`

No additional client-side filter needed — Kind 7 reactions are simple enough.

---

## Sorting

Threads can be sorted client-side. The relay returns events, the UI sorts them:

| Sort | Logic |
|------|-------|
| **Newest** | Sort by `created_at` descending (default) |
| **Most Active** | Sort by reply count descending |
| **Most Liked** | Sort by reaction (Kind 7) count descending |
| **Latest Reply** | Sort by most recent reply's `created_at` |

Sorting requires fetching reply counts and reaction counts client-side. For the initial implementation, **Newest** is sufficient — it requires no additional queries.

---

## Scope: Per-Artist Community

Each content node hosts its own community. When a fan visits an artist's page and opens the Community tab, they see threads on that artist's relay.

- Threads are stored on the artist's content node relay
- Fans connect to that relay to read and post
- The artist has moderation control over their own community
- Different artists have different communities with different conversations

This mirrors the content node model — each artist owns their infrastructure, including their community space.

### Cross-Node Discovery (Future)

In a future phase, a fan client could aggregate community threads from multiple artist nodes they follow, similar to how a Reddit homepage aggregates across subreddits. This would be a client-side feature — query multiple relays, merge results, display unified thread list. The NOSTR protocol supports this natively since events have the same structure regardless of which relay they're on.

---

## UI Design

### Community Page (`social.html?tab=community`)

**Layout:**
- Board selector (tabs or dropdown): All | General | Music | Production | Gigs
- "New Thread" button
- Thread list below

**Thread List Item:**
- Thread subject (title) — clickable, links to thread detail
- Author avatar + display name
- Board badge
- Reply count
- Reaction count
- Time since posted (relative)
- Time of last reply

**New Thread Dialog/Page:**
- Board selector (dropdown)
- Subject line (required)
- Content area (markdown)
- Post button

### Thread Detail Page (`social.html?tab=community&thread=<event-id>`)

**Layout:**
- Thread subject as heading
- Opening post (full content, author, timestamp)
- Reply list below, threaded/nested
- Reply composer at bottom

**Reply Item:**
- Author avatar + display name
- Content
- Timestamp
- Reaction button (upvote)
- Reply button (nested reply)

**Reply Composer:**
- Text area
- Post button
- Shows "Replying to [name]" when replying to a specific reply

### Where Does Community Live?

Community is accessible from:
- **Artist public page** (`artist.html`): A "Community" tab alongside Music, About, etc. Fans can browse and participate.
- **Admin dashboard**: Artist can view, participate in, and moderate their community.

---

## Moderation

The artist controls their community through the same mechanisms described in [SOCIAL.md](./SOCIAL.md):

- **Mute/Block**: Hide or block specific pubkeys
- **Delete**: Request deletion of specific events on their relay (NIP-09)
- **Pin**: Mark threads as pinned (could use a custom tag or a list event)
- **Board Management**: Add/remove/rename boards

Since the relay is on the artist's node, they have ultimate control. They can remove any event from their relay's database directly if needed.

---

## Authentication

Community uses the same session system as the rest of Equaliser:

- **Logged-in users** (via nsec, backup file, or NIP-07): Can post threads, reply, and react
- **Logged-out users**: Can read threads but cannot post
- **Artist**: Full moderation capabilities in admin view

No separate registration. If you have a NOSTR identity, you can participate in any Equaliser community.

---

## Implementation Status

### Implemented (March 2026)
- Thread list view with board filter tabs (All | General | Music | Production | Gigs)
- Thread detail view with opening post and chronological replies
- New thread composer (board selector, subject, content)
- Reply composer in thread detail view
- Reply counts on thread list
- Author profiles (avatar, name) on threads and replies
- Board badge colours: general=blue, music=purple, production=green, gigs=amber
- Browser history support (pushState/popstate) for thread navigation
- Accessible via Social link in sidebar bottom nav → Community Threads tab
- Client-side filtering for all multi-character tags
- Seed data script (`tools/seed-social.mjs`) for populating test content

### Files
- `client/social.html` — Unified social page with Feed + Community tabs (community is the Community tab)
- `client/js/nostr-social.js` — `fetchCommunityThreads()`, `fetchCommunityReplies()` functions

### Future
- Upvote/react to threads and replies (Kind 7)
- Sort by most active, most liked, latest reply
- Mute/block pubkeys
- Delete events (NIP-09)
- Pin threads
- Board management UI (add/remove/rename boards)

---

## References

- [NIP-01: Basic Protocol](https://github.com/nostr-protocol/nips/blob/master/01.md) — Event structure, relay queries
- [NIP-10: Reply Conventions](https://github.com/nostr-protocol/nips/blob/master/10.md) — Threading with `e` tag markers
- [NIP-14: Subject Tag](https://github.com/nostr-protocol/nips/blob/master/14.md) — Thread subject lines
- [NIP-25: Reactions](https://github.com/nostr-protocol/nips/blob/master/25.md) — Upvotes/likes
- [NIP-09: Event Deletion](https://github.com/nostr-protocol/nips/blob/master/09.md) — Moderation deletions
- [SOCIAL.md](./SOCIAL.md) — Two-layer architecture, moderation philosophy
