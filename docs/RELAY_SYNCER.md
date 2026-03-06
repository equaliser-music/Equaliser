# Relay Syncer

**Status:** Specification
**Spec Reference:** [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) Sections 2, 3

---

## Overview

A standalone async Python process that maintains persistent WebSocket connections to a configurable list of NOSTR relays, ingests Equaliser-tagged events, and writes them to a shared PostgreSQL database. This follows the same architectural pattern as [Primal's caching server](https://github.com/PrimalHQ/primal-server) — background ingestion with a separate read API.

---

## Architecture

The syncer runs as its own Docker container (`relay-syncer`) alongside the existing stack. It shares the PostgreSQL database with the FastAPI orchestrator but operates independently — either can be restarted without affecting the other.

```
+--------------------------------------------------+
|              Docker Compose Stack                 |
|                                                   |
|  +----------+  +----------+  +--------------+    |
|  |  IPFS    |  |  NOSTR   |  | Orchestrator |    |
|  |  (kubo)  |  |  Relay   |  |  (FastAPI)   |    |
|  +----------+  +----------+  +------+-------+    |
|                                      | reads      |
|  +--------------+  +----------------+--------+   |
|  | Relay Syncer |  |     PostgreSQL          |   |
|  |  (Python)    +--+  (shared database)      |   |
|  |              |  |                         |   |
|  +--------------+  +-------------------------+   |
|        | writes                                   |
|        |                                          |
+--------+------------------------------------------+
         | WebSocket subscriptions
         v
   +----------+  +----------+  +----------+
   |  Local   |  |  Damus   |  |  nos.lol |  ...
   |  Relay   |  |  Relay   |  |  Relay   |
   +----------+  +----------+  +----------+
```

---

## Subscriptions

The syncer connects to each relay in its configured list and subscribes to Equaliser events:

```json
{"kinds": [0, 30050, 30051, 30052, 30053], "#app": ["Equaliser"]}
```

It also subscribes to Kind 10002 (relay list) events from known artist pubkeys to discover new relays organically.

### User Subscriptions

When a fan authenticates through the content node, the orchestrator writes their pubkey to the `registered_users` table. The syncer detects new registrations and subscribes to their data:

```json
{"kinds": [0, 3, 30001], "authors": ["<user_pubkey>"]}
```

For feed events, it subscribes to Kind 1 from the user's follow list:

```json
{"kinds": [1], "authors": ["<followed_1>", "<followed_2>", "..."], "since": <threshold_timestamp>}
```

Follow list subscriptions are updated whenever a new Kind 3 event is ingested for the user.

**Artist auto-discovery:** When a user's Kind 3 follow list is processed, the syncer checks each followed pubkey against the existing artist index. Any Equaliser artists not already indexed are added automatically — their catalogue data then syncs through the normal artist cache pipeline.

**Feed thresholds:** Feed events are cached subject to two node-level limits (whichever is hit first):

| Variable | Default | Description |
|----------|---------|-------------|
| `USER_FEED_DAYS` | `30` | Maximum age of cached feed events in days |
| `USER_FEED_LIMIT` | `500` | Maximum cached feed events per user |

These can be updated at runtime via the admin console without restarting the container.

**Freshness:** The syncer maintains persistent WebSocket subscriptions for all registered user pubkeys. There is no TTL-based expiry — freshness is event-driven via relay subscriptions, with the same reconnection and catch-up mechanisms used for artist data.

---

## Event Processing

| Step | Description |
|------|-------------|
| Signature validation | Validates event signatures before writing to cache |
| Replaceable event handling | For Kind 0 and parameterised replaceable (30000+ range), highest `created_at` wins |
| Deduplication | Deduplicates by event ID across relays |

---

## Resilience

- **Automatic reconnection** with exponential backoff on disconnection
- **Catch-up on reconnect** using `since:` filter from last known event timestamp for that relay
- **Periodic full sync** (configurable, default every 60 minutes) as safety net
- **Logging** of connection status, event counts, and errors for the management console

---

## Relay List Management

- **Initial list** configured via `RELAY_LIST` environment variable
- **Auto-discovery** via Kind 10002 events from indexed artists — new relays added automatically
- **Admin control** via the management console (add/remove/enable/disable relays)
- **Per-relay tracking:** URL, connection status, last event timestamp, event count, error count

---

## Docker Configuration

```yaml
relay-syncer:
  build: ./relay-syncer
  environment:
    - DATABASE_URL=postgresql://equaliser:${DB_PASSWORD}@postgres:5432/equaliser
    - RELAY_LIST=ws://nostr-relay:8008,wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band
    - SYNC_INTERVAL=3600
  depends_on:
    - postgres
    - nostr-relay
  restart: unless-stopped

postgres:
  image: postgres:15
  environment:
    - POSTGRES_USER=equaliser
    - POSTGRES_PASSWORD=${DB_PASSWORD}
    - POSTGRES_DB=equaliser
  volumes:
    - postgres-data:/var/lib/postgresql/data
  ports:
    - "5432:5432"
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| `RELAY_LIST` | (required) | Comma-separated relay WebSocket URLs |
| `SYNC_INTERVAL` | `3600` | Full resync interval in seconds |
| `USER_FEED_DAYS` | `30` | Maximum age of cached feed events in days |
| `USER_FEED_LIMIT` | `500` | Maximum cached feed events per user |

---

## Cache Database Schema

The syncer writes to the following PostgreSQL tables. See [DATABASE.md](DATABASE.md) for the full schema reference.

### cached_artists (Kind 0)

Parsed artist profiles with extracted metadata fields for fast queries.

### cached_tracks (Kind 30050)

Parsed track metadata with artist foreign key, IPFS CIDs, pricing, and album grouping.

### cached_albums (Kind 30051)

Parsed album metadata with cover art references.

### syncer_relays

Relay connection tracking — URL, status, event counts, errors, auto-discovery flag.

### sync_log

Debug and monitoring log — per-event record of relay source, kind, and action taken (inserted, updated, duplicate, invalid).

### User Cache Tables

Written by the syncer for registered fan/listener accounts:

- **registered_users** — pubkeys that have authenticated through the node (written by orchestrator, read by syncer)
- **cached_users** (Kind 0) — parsed fan profiles
- **cached_user_follows** (Kind 3) — follow list per user
- **cached_user_feed** (Kind 1) — notes from followed pubkeys, subject to feed thresholds
- **cached_user_playlists** (Kind 30001) — Equaliser playlists belonging to registered users

---

## Cache API

The orchestrator reads from the cache database and exposes these public endpoints. See [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) Section 4 for full details.

```
GET /api/artists                - List all cached artists
GET /api/artists/{npub}         - Single artist profile with metadata
GET /api/artists/{npub}/tracks  - All tracks for an artist
GET /api/tracks/{event_id}      - Single track metadata
GET /api/tracks                 - Tracks across all artists
GET /api/search                 - Search across artists and tracks
```

These replace direct relay queries from the web client with fast, predictable API responses.

---

## Troubleshooting

### Syncer not connecting to relays
- Check `RELAY_LIST` environment variable for correct WebSocket URLs
- Verify the relay is reachable: `websocat wss://relay.example.com`
- Check syncer logs: `docker compose logs relay-syncer`
- For the local relay, ensure `nostr-relay` container is healthy

### Events not appearing in cache
- Verify events have the `["app", "Equaliser"]` tag (syncer only ingests tagged events)
- Check `sync_log` table for action taken on specific event IDs
- Run a force resync from the management console

### User profile not appearing after login
- Check `registered_users` table — confirm the pubkey was written by the orchestrator
- Verify the user has a Kind 0 event on at least one configured relay
- Check syncer logs: `docker compose logs relay-syncer`

### Feed not populating
- Confirm the user has a Kind 3 (follow list) event on a reachable relay
- Check `USER_FEED_DAYS` and `USER_FEED_LIMIT` — thresholds may be filtering all events
- Check `sync_log` for action taken on relevant event IDs

### Playlists missing
- Verify playlist events have the `["app", "Equaliser"]` tag
- Check `cached_user_playlists` table directly for the user's pubkey

### Database connection issues
- Verify PostgreSQL is running: `docker compose ps postgres`
- Check `DATABASE_URL` format: `postgresql://user:password@host:port/dbname`
- Verify database exists: `docker compose exec postgres psql -U equaliser -l`

---

## References

- [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) — Full specification (Sections 2, 3, 4)
- [DATABASE.md](DATABASE.md) — Full database schema reference
- [NODE_ADMIN.md](NODE_ADMIN.md) — Management console (Sync Manager section)
- [Primal Caching Server](https://github.com/PrimalHQ/primal-server) — Reference architecture
