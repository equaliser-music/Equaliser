# Node Management Console

**Status:** Specification
**Spec Reference:** [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) Section 6

---

## Overview

Web-based admin dashboard for node operators to monitor and control all node operations. Served from `/admin/console` — distinct from artist admin pages at `/admin`.

The management console provides visibility into relay syncing, artist management, storage, and node configuration.

---

## Tech Stack

- React SPA served as static files from `/admin/console`
- Communicates with `/api/admin/*` endpoints
- WebSocket connection to orchestrator for real-time status updates (relay connections, incoming requests)
- Consistent with existing admin pages in style

---

## Authentication

The management console requires admin authentication, separate from artist session management. For MVP this is a simple password or API key set via environment variable (`ADMIN_PASSWORD`).

The admin authenticates and receives a session token or JWT for subsequent requests. All `/api/admin/*` endpoints require this authentication.

---

## Dashboard Sections

### Overview

- Node status: all services health (IPFS, NOSTR relay, orchestrator, syncer, postgres)
- Quick stats: hosted artists count, total tracks, total storage used
- Recent activity: latest requests, new events synced, errors

### Sync Manager

- Relay list with live connection status (connected/disconnected/error)
- Per-relay stats: event count, last event time, error count
- Controls: add relay, remove relay, enable/disable relay, force resync
- Sync log: recent event activity with kind, source relay, action taken

See [RELAY_SYNCER.md](RELAY_SYNCER.md) for syncer architecture and configuration.

### Artist Management

- Pending access requests queue with approve/decline actions
- Onboarded artists list with status, track count, storage usage
- Per-artist detail: fee model, published events, IPFS storage used
- Invite code management: active codes, generate manual codes

See [ACCESS_CONTROL.md](ACCESS_CONTROL.md) for the access request and approval workflow.

### User Management

Manage fan/listener data caching. User caching is purely metadata — NOSTR event data (profiles, follow lists, playlists, feeds). This is distinct from file hosting (IPFS/Blossom) which consumes real storage.

- **Global toggle** — enable/disable user caching entirely if the node is resource-constrained
- **Registered users list** — all authenticated pubkeys with last seen time, event counts, cache size
- **Per-user enable/disable** — suspend syncing for individual users without removing their registration
- **Feed threshold settings** — configure global time window (days) and event count cap
- **Force resync** — trigger an immediate full resync for a specific user
- **Remove user** — deregister a pubkey and purge their cached data

See [RELAY_SYNCER.md](RELAY_SYNCER.md) for how user subscriptions work and [DATABASE.md](DATABASE.md) for user cache tables.

### IPFS & Storage

- Local IPFS node stats: storage used, peer count, pin count
- Cluster requests — outbound: CIDs requested for pinning on other nodes, status per node
- Cluster requests — inbound: requests from other nodes to pin content, approve/decline
- Storage breakdown by artist

### Blossom Mirroring

- Configured Blossom servers with sync status
- Per-server: last sync, content count, error status
- Mirroring policy config: all content, own artists only, by play count threshold
- Manual mirror trigger

### Node Settings

- Node identity: name, description, public-facing info
- Fee model defaults for new artists
- Relay syncer configuration
- Backup and export tools

---

## Admin API Endpoints

### Sync Management

```
GET  /api/admin/sync/status         - Syncer status, relay connections, event counts
GET  /api/admin/sync/relays         - List all tracked relays with status
POST /api/admin/sync/relays         - Add a relay to the sync list
DELETE /api/admin/sync/relays/{url} - Remove a relay
POST /api/admin/sync/force          - Trigger a full resync
GET  /api/admin/sync/log            - Recent sync activity log
```

### Artist Management

```
GET    /api/admin/requests              - List all access requests (filterable by status)
GET    /api/admin/requests/{id}         - View single request
POST   /api/admin/requests/{id}/approve - Approve request, generates invite code
POST   /api/admin/requests/{id}/decline - Decline request with optional reason
GET    /api/admin/artists               - List all onboarded artists on this node
PUT    /api/admin/artists/{pubkey}      - Update artist settings (fee model, status)
DELETE /api/admin/artists/{pubkey}      - Remove artist from node
```

### User Management

```
GET    /api/admin/users                    - List all registered users with cache stats
GET    /api/admin/users/{pubkey}           - View single user's cached data summary
PUT    /api/admin/users/{pubkey}           - Enable/disable syncing for a user
DELETE /api/admin/users/{pubkey}           - Deregister user and purge cached data
POST   /api/admin/users/{pubkey}/resync    - Force resync user data
PUT    /api/admin/settings/user-cache      - Update global user cache settings (enable/disable, feed thresholds)
```

---

## References

- [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) — Full specification (Section 6)
- [RELAY_SYNCER.md](RELAY_SYNCER.md) — Relay syncer architecture
- [ACCESS_CONTROL.md](ACCESS_CONTROL.md) — Access request and approval workflow
- [DATABASE.md](DATABASE.md) — Full database schema reference
