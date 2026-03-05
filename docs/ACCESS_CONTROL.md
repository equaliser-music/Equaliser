# Access Control & Gated Onboarding

**Status:** Specification
**Spec Reference:** [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) Sections 5, 8

---

## Overview

The content node currently operates as an open system — anyone can access the onboarding page and publish to the local relay. Access control closes this open door by requiring artists to request access and be approved by the node admin before they can onboard.

This enables the evolution from single-artist nodes to multi-tenant hosting where node operators provide managed infrastructure to artists.

---

## Artist Request Flow

```
Artist visits node portal
        |
        v
+------------------+
|  Public Request   |  No authentication needed
|  Form at /join    |
+--------+---------+
         |
         v
+------------------+
|  Request stored   |  Status: pending
|  in database      |
+--------+---------+
         |
         v
+------------------+
|  Admin reviews    |  Via management console
|  in queue         |
+--------+---------+
         |
    +----+-----+
    v          v
+--------+ +--------+
|Approved| |Declined|
+---+----+ +---+----+
    |          |
    v          v
 Invite     Notification
 code       (optional)
 generated
    |
    v
 Artist uses code
 to access onboarding
```

---

## Request Form

A public page at `/join`. No NOSTR keys or authentication needed — this is a public-facing request form.

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| Artist/project name | Yes | Name of the artist or project |
| Description | Yes | Brief description of their music |
| Links | No (encouraged) | Existing work — Bandcamp, SoundCloud, YouTube, personal site |
| Email | No | For notification when request is reviewed |
| Existing npub | No | If they already have a NOSTR identity |

On submission, the form posts to `POST /api/access/request` and displays a confirmation message explaining that the node admin will review their request.

---

## Invite Code Flow

On approval, the system generates a unique invite code (e.g. `EQ-a8f3b2c1`). The admin shares this with the artist however they choose — email, DM, etc.

The existing onboarding page (`/admin/onboarding.html`) is modified to require an invite code at the start. The code is validated against `POST /api/access/validate-code`. If valid, the artist proceeds through the existing onboarding flow (key generation, profile setup, relay publishing).

On successful onboarding, the invite is marked as used and the artist is added to `node_artists`.

---

## Node Info

The public endpoint `GET /api/access/node-info` returns basic information about the node:

- Node name and description
- Number of hosted artists
- Fee model (if applicable)

This allows prospective artists to understand what the node offers before requesting access.

---

## Database Schema

### access_requests

Stores artist access requests and their review status.

```sql
CREATE TABLE access_requests (
    id SERIAL PRIMARY KEY,
    artist_name TEXT NOT NULL,
    email TEXT,
    npub TEXT,                        -- If they already have a NOSTR identity
    description TEXT,                 -- What they do, why they want to join
    links TEXT,                       -- Existing music links, social profiles
    status TEXT DEFAULT 'pending',    -- pending, approved, declined
    admin_notes TEXT,                 -- Internal notes from admin
    invite_code TEXT UNIQUE,          -- Generated on approval
    invite_used BOOLEAN DEFAULT FALSE,
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ
);
```

### node_artists

Tracks approved and onboarded artists on this node.

```sql
CREATE TABLE node_artists (
    pubkey TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,
    request_id INTEGER REFERENCES access_requests(id),
    fee_model TEXT DEFAULT 'free',    -- free, percentage, flat_rate
    fee_value NUMERIC DEFAULT 0,      -- percentage (e.g. 5.0) or sats amount
    status TEXT DEFAULT 'active',     -- active, suspended, migrated
    onboarded_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Fee Models

Node operators can configure how they charge hosted artists. The fee model is set per-artist in `node_artists`, with a node-wide default in settings.

| Model | Description | Example |
|-------|-------------|---------|
| `free` | No charge, community/grant-funded | Community nodes |
| `percentage` | Percentage of streaming revenue | 5-10% of each payment |
| `flat_rate` | Fixed monthly fee in sats | 5,000 sats/month |

Payment splits are a future implementation — for MVP, the fee model is recorded but not yet automated.

---

## API Endpoints

### Public

```
POST /api/access/request         - Submit a join request
POST /api/access/validate-code   - Validate an invite code
GET  /api/access/node-info       - Public node info (name, description, artist count, fee model)
```

### Admin (authenticated)

```
GET    /api/admin/requests              - List all access requests (filterable by status)
GET    /api/admin/requests/{id}         - View single request
POST   /api/admin/requests/{id}/approve - Approve request, generates invite code
POST   /api/admin/requests/{id}/decline - Decline request with optional reason
GET    /api/admin/artists               - List all onboarded artists on this node
PUT    /api/admin/artists/{pubkey}      - Update artist settings (fee model, status)
DELETE /api/admin/artists/{pubkey}      - Remove artist from node
```

---

## Artist Portability

Critical design principle: artists can always leave. Since their identity is their NOSTR keypair and content is on IPFS with publicly known CIDs, migration means:

1. Artist stands up own node or joins another node
2. Republishes their Kind 0 and Kind 30050 events (already signed with their keys)
3. New node pins their IPFS content
4. Old node can optionally unpin to free storage

The tooling should make this exit path explicit — a "migrate" or "export" option in the artist admin panel that packages everything needed. See [ARTIST_PACKAGE.md](ARTIST_PACKAGE.md) for the existing export format.

---

## Integration with Existing Onboarding

The access control system wraps the existing onboarding flow:

1. **Before access control:** Artist visits `/admin/onboarding.html` → proceeds directly to key generation
2. **With access control:** Artist visits `/join` → submits request → receives invite code → enters code at `/admin/onboarding.html` → proceeds to key generation

The existing onboarding steps (key generation, backup download, profile setup, relay publishing) remain unchanged. See [ONBOARDING.md](ONBOARDING.md) for the full onboarding flow.

---

## References

- [NODE-MANAGEMENT-SPEC.md](NODE-MANAGEMENT-SPEC.md) — Full specification (Sections 5, 8)
- [ONBOARDING.md](ONBOARDING.md) — Artist onboarding flow
- [ARTIST_PACKAGE.md](ARTIST_PACKAGE.md) — Release package export for portability
- [NODE_ADMIN.md](NODE_ADMIN.md) — Management console (where requests are reviewed)
- [DATABASE.md](DATABASE.md) — Full database schema reference
