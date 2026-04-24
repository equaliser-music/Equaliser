# Node Management Architecture

## Context

Equaliser currently has a single admin role: **artist**. All logged-in users on the admin pages can manage their own content but nothing else. As the platform grows to support labels hosting multiple artists and node operators managing infrastructure, we need clear role definitions, auth patterns, and UI boundaries.

This document defines the three-tier role architecture. It is a design document — implementation follows in separate phases.

---

## Three Roles

### 1. Artist

**What they do:** Manage their own content — upload tracks, edit releases, publish to NOSTR, manage their profile.

**Auth:** NOSTR keypair (nsec or NIP-07) → NIP-98 HTTP Auth. Existing system, no changes needed.

**Scope:** Own data only. Every query scoped by `WHERE artist_pubkey = {authenticated_pubkey}`.

**Pages:** Dashboard, Releases, Edit Release, Profile, Upload, Settings (all exist today).

### 2. Label ("node operator lite")

**What they do:** Manage multiple artists on the node. They are a NOSTR identity themselves (can have their own artist profile, be followed, publish events).

**Permissions (in addition to artist):**
- View/manage any managed artist's drafts, releases, profile
- Approve/decline access requests, generate invite codes
- Set fee models per artist (free/percentage/flat_rate)
- Suspend/activate artists
- BIP-32 key derivation for custodial artist identities
- Export derived keys to artists for independence

**Cannot:** See infrastructure details (relay health, IPFS storage, Blossom mirroring, sync status).

**Auth:** Same NIP-98 flow. Distinguished by `role = 'label'` in `node_artists` table.

### 3. Node Operator

**What they do:** Infrastructure management. Everything a label can do, plus:
- Relay status, peer connections, sync controls
- IPFS storage management, pin status
- Blossom mirroring configuration
- User cache management (registered listeners)
- Node settings and configuration

**Auth:** Dual-path:
1. **NOSTR-based (preferred):** Pubkey in `node_operators` table, authenticated via NIP-98
2. **Password-based (fallback):** `ADMIN_PASSWORD` env var, sent as `X-Admin-Token` header. For emergency access without a NOSTR extension.

---

## Database Changes

### Modify `node_artists` (existing table in relay PostgreSQL)

```sql
-- New migration: 002_roles.sql
ALTER TABLE node_artists ADD COLUMN role TEXT DEFAULT 'artist';
  -- Values: 'artist', 'label'

ALTER TABLE node_artists ADD COLUMN custody TEXT DEFAULT 'self';
  -- Values: 'self' (artist holds own key), 'label' (label holds derived key)

ALTER TABLE node_artists ADD COLUMN managed_by TEXT;
  -- For label-managed artists: label's pubkey. NULL for self-managed.

ALTER TABLE node_artists ADD COLUMN derivation_index INTEGER;
  -- BIP-32 account index: m/44'/1237'/{index}'/0/0. NULL for self-managed.

CREATE INDEX idx_node_artists_role ON node_artists(role);
CREATE INDEX idx_node_artists_managed_by ON node_artists(managed_by);
```

### New `node_operators` table

```sql
CREATE TABLE node_operators (
    pubkey TEXT PRIMARY KEY,
    name TEXT,
    added_at TIMESTAMPTZ DEFAULT NOW()
);
```

Bootstrapped from `OPERATOR_PUBKEYS` env var (comma-separated hex pubkeys) on relay startup.

### Why roles in `node_artists`, not a separate table

Labels are also artists — they can have their own profile, releases, followers. The `role` column distinguishes permissions. The `managed_by` column creates the label→artist relationship: `SELECT * FROM node_artists WHERE managed_by = {label_pubkey}`.

### Why roles in the database, not NOSTR events

Roles must be authoritative and local to the node. If stored in NOSTR events, any relay could inject a role claim. The node's PostgreSQL database is the single source of truth.

---

## API Permission Model

### New dependency chain (extends existing `require_auth`)

```python
# content_node/orchestrator/api/dependencies.py

@dataclass
class RoleContext:
    pubkey: str
    role: str              # "artist" | "label" | "operator"
    managed_artists: list  # pubkeys this user can manage

async def require_role(request) -> RoleContext:
    pubkey = await require_auth(request)      # existing — returns verified pubkey
    return await resolve_role(pubkey)          # new — looks up role from DB

async def require_label(request) -> RoleContext:
    ctx = await require_role(request)
    if ctx.role not in ("label", "operator"):
        raise HTTPException(403)
    return ctx

async def require_operator(request) -> RoleContext:
    # Try NIP-98 first
    ctx = await require_role(request)
    if ctx.role == "operator": return ctx
    # Fallback to ADMIN_PASSWORD
    if request.headers.get("X-Admin-Token") == os.getenv("ADMIN_PASSWORD"):
        return RoleContext(pubkey="admin", role="operator", managed_artists=[])
    raise HTTPException(403)
```

### Role resolution order

```
resolve_role(pubkey):
  1. Check node_operators → role = "operator", managed_artists = ALL
  2. Check node_artists WHERE role = 'label' → managed_artists = WHERE managed_by = pubkey
  3. Check node_artists WHERE role = 'artist' → managed_artists = [self]
  4. Not found → 403
```

### Endpoint authorization patterns

**Existing artist endpoints** — gradual migration from `require_auth` to `require_role`:
```python
# Artist: can only query own pubkey
# Label: can query any managed artist
# Operator: can query any artist
```

**New label endpoints** — `Depends(require_label)`: artist management, access requests, fee models.

**New operator endpoints** — `Depends(require_operator)`: infrastructure (relay, IPFS, Blossom, sync).

**New endpoint** — `GET /api/auth/whoami`: returns `{ pubkey, role, managed_artists }` for sidebar rendering.

### Backward compatibility

Existing `require_auth` endpoints continue working. Migration is per-endpoint: swap `require_auth` for `require_role` and add role checks. Until migrated, endpoints behave as today (artist-only).

---

## UI Strategy

### Shared admin UI with role-conditional navigation

Same HTML pages at `/admin/*`. The sidebar (`admin-sidebar.js`) renders different nav sections based on role.

```
ARTIST:               LABEL:                    OPERATOR:
  MANAGE                ARTISTS                   ARTISTS
    Dashboard             [artist selector]         [artist selector]
    Releases            MANAGE                    MANAGE  
    Analytics             Dashboard                 Dashboard
  ──────────              Releases                  Releases
  Profile                 Analytics                 Analytics
  Settings             ──────────                 ──────────
                        LABEL                     LABEL
                          Artist Management         Artist Management
                          Access Requests           Access Requests
                        ──────────                ──────────
                        Profile                   INFRASTRUCTURE
                        Settings                    Relay & Sync
                                                    IPFS Storage
                                                    Blossom Config
                                                    User Cache
                                                  ──────────
                                                  Node Settings
                                                  Profile
                                                  Settings
```

### Artist selector (labels/operators)

Dropdown at top of sidebar listing managed artists. Selecting an artist sets `sessionStorage.selectedArtistPubkey` — all pages scope their API calls to that pubkey. "All Artists" option for aggregate views.

### Subtitle

Sidebar subtitle changes by role: "Artist Admin" / "Label Admin" / "Node Admin".

### New pages

**Label pages:**
- `artist-management.html` — list artists, status, fee models, suspend/activate
- `access-requests.html` — pending requests queue, approve/decline

**Operator pages:**
- `node-overview.html` — service health, quick stats
- `sync-manager.html` — relay list, connections, sync controls
- `ipfs-storage.html` — pins, storage breakdown by artist
- `blossom-config.html` — mirror servers, sync status
- `user-cache.html` — registered listeners, cache management
- `node-settings.html` — node configuration

---

## Label → Artist: BIP-32 Key Derivation

### Custodial mode

Label holds master seed → derives artist keypair at `m/44'/1237'/{derivation_index}'/0/0` (NIP-06). The derived public key becomes the artist's NOSTR identity. Private key stored encrypted on data volume (never in database). `node_artists` row: `custody='label'`, `managed_by={label_pubkey}`, `derivation_index={n}`.

### Non-custodial mode

Artist holds their own key, signed up independently. Label can manage metadata (drafts, fees) but cannot sign events. `custody='self'`, `managed_by={label_pubkey}`.

### Artist independence path

1. Label exports derived nsec to artist
2. Update `custody = 'self'`
3. Artist now signs independently
4. Full exit: export `.eqpkg.zip` + take nsec + remove from node

---

## Upgrade Paths

**Solo artist → Label:** Update own row to `role = 'label'`. Generate master seed. Onboard new artists.

**Label → Add operator:** Add operator pubkey to `node_operators` table. Or set `OPERATOR_PUBKEYS` env var.

**Open node → Gated:** Enable access control. Existing artists unaffected. New artists go through request/approve/invite flow.

---

## Design Decisions

1. **Labels have their own artist profile** — Yes. A label is a NOSTR identity that can publish, be followed, release compilations.

2. **Operator ≠ Label** — Separate concerns. An operator manages infrastructure; a label manages content. Same person can have both roles (pubkey in both tables).

3. **Per-label master seeds** — If a node hosts multiple labels, each has its own BIP-32 seed for key isolation.

4. **ADMIN_PASSWORD as fallback** — Primary auth is NOSTR-based. Password ensures operators are never locked out.

---

## Implementation Status

### Phase A: Database + Role Resolution ✅

**Done:**

| File | What was done |
|------|---------------|
| `content_node/equaliser-relay/migrations/003_roles.sql` | Migration: `role`, `custody`, `managed_by`, `derivation_index` columns on `node_artists` + `node_operators` table |
| `content_node/equaliser-relay/internal/config/config.go` | Parses `OPERATOR_PUBKEYS` env var (comma-separated hex pubkeys) |
| `content_node/equaliser-relay/cmd/relay/main.go` | Bootstraps operator pubkeys into `node_operators` on startup (idempotent) |
| `content_node/equaliser-relay/internal/storage/users.go` | `BootstrapOperators()`, `ResolveRole()`, `getAllArtistPubkeys()`, `getManagedArtists()` |
| `content_node/equaliser-relay/internal/api/api.go` | `GET /api/internal/auth/role?pubkey=` — returns `{ pubkey, role, managed_artists }` |
| `content_node/orchestrator/api/dependencies.py` | `RoleContext` dataclass with `can_manage()`, `require_role`, `require_label`, `require_operator` dependencies |
| `content_node/orchestrator/api/routers/auth.py` | `GET /api/auth/whoami` — NIP-98 authenticated, returns role context |
| `content_node/orchestrator/api/main.py` | Registered auth router at `/api/auth` |

**Tested locally:**
- Migration applies cleanly (003_roles.sql)
- Artist role: returns `managed_artists: [self]`
- Label role: returns `managed_artists: [managed artists + self]`
- Operator role: returns `managed_artists: [all artists on node]`
- Unknown pubkey: 404
- Orchestrator `/api/auth/whoami`: returns 401 without auth (correct)

### Phase B: API Permission Model ✅

**Done:**

| File | What was done |
|------|---------------|
| `content_node/equaliser-relay/internal/storage/admin.go` | `AdminStore` with all artist/access-request/invite-code/registered-user/stats queries |
| `content_node/equaliser-relay/internal/api/api.go` | 12 new `/api/internal/*` endpoints for artists, access-requests, invite-codes, registered-users, stats |
| `content_node/equaliser-relay/cmd/relay/main.go` | Wires up `AdminStore` |
| `content_node/orchestrator/api/services/relay_admin.py` | HTTP client wrapping all relay internal admin endpoints |
| `content_node/orchestrator/api/routers/label.py` | `/api/label/*` — artists CRUD, access-requests approve/decline, invite-codes |
| `content_node/orchestrator/api/routers/operator.py` | `/api/operator/*` — overview, registered-users, sync/status |
| `content_node/orchestrator/api/routers/drafts.py` | Migrated all endpoints to `require_role` with `ctx.can_manage()` checks |
| `content_node/orchestrator/api/routers/tracks.py` | Migrated upload, publish, duplicate; supports `target_artist_pubkey` for label uploads |
| `content_node/orchestrator/api/routers/packages.py` | Migrated export-prepare, export-download, import; supports `target_pubkey` |
| `content_node/orchestrator/api/main.py` | Registered label + operator routers |

**Permission model:**
- Artist endpoints check `ctx.can_manage(target_pubkey)` where target is either explicit (query/body field) or derived from the resource (e.g. draft.artist_pubkey)
- `can_manage()` returns true if `ctx.role == "operator"` OR `target_pubkey in ctx.managed_artists`
- Label endpoints require `Depends(require_label)` — accepts label or operator role
- Operator endpoints require `Depends(require_operator)` — NIP-98 (operator role) or `X-Admin-Token` header

**Tested locally:**
- Label sees managed artists via `/api/label/artists` (1 artist returned)
- Approving access request generates 12-char hex invite code
- Operator endpoints reject label callers (403)
- After promoting label to operator, all operator endpoints return data
- `whoami` correctly reflects role transitions

**Backward compatibility preserved:** Unknown pubkeys default to artist role with self-only access — existing user flows work without changes.

### Phase C: UI Role-Aware Sidebar (TODO)

| File | Change needed |
|------|---------------|
| `content_node/orchestrator/js/admin-sidebar.js` | Fetch role via `/api/auth/whoami`, render role-appropriate nav, artist selector dropdown |
| `content_node/orchestrator/js/session.js` | Store role + `selectedArtistPubkey` in session state |

### Phase D: Label Admin Pages (TODO)

| Page | Purpose |
|------|---------|
| `artist-management.html` | List artists, status, fee models, suspend/activate |
| `access-requests.html` | Pending requests queue, approve/decline |

### Phase E: Operator Admin Pages (TODO)

| Page | Purpose |
|------|---------|
| `node-overview.html` | Service health, quick stats |
| `sync-manager.html` | Relay list, connections, sync controls |
| `ipfs-storage.html` | Pins, storage breakdown by artist |
| `blossom-config.html` | Mirror servers, sync status |
| `user-cache.html` | Registered listeners, cache management |
| `node-settings.html` | Node configuration |

## Verification

1. ~~Architecture doc reviewed and approved before any implementation~~ ✅
2. ~~Phase A: DB migration + role resolution~~ ✅ Tested locally
3. ~~Phase B: API permission model~~ ✅ Tested locally with NIP-98 auth
4. Phase C: UI role-aware sidebar — visual verification
5. Phase D: Label pages — end-to-end artist management workflow
6. Phase E: Operator pages — infrastructure visibility
