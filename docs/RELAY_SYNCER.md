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
