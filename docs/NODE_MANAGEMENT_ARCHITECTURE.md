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

### Phase C: UI Role-Aware Sidebar ✅

**Done:**

| File | What was done |
|------|---------------|
| `content_node/orchestrator/js/session.js` | Added `fetchRole()` (calls `/api/auth/whoami` via NIP-98), `getRole()`, `getManagedArtists()`, `getSelectedArtistPubkey()`, `setSelectedArtistPubkey()`. Persists `role`, `managedArtists`, `selectedArtistPubkey` in sessionStorage. Cross-tab `artist-switch` BroadcastChannel message + `equaliser:artist-switched` window event. Falls back to `role='artist'` with self-only access if whoami fails. |
| `content_node/orchestrator/js/admin-sidebar.js` | Two-pass render: synchronous skeleton from cached role, async re-render after `fetchRole()`. Role-conditional subtitle (Artist Admin / Label Admin / Node Operator), colored role badge (purple/blue/green), artist selector dropdown for labels and operators with > 1 managed artist. Three nav section groups (`nav-manage`, `nav-label-admin`, `nav-node-admin`) with `data-testid` hooks. Preserves `sidebar-name`/`sidebar-avatar` IDs so `updateArtistDisplay()` still works after re-render. |

**Behavior by role:**

| Role | Subtitle | Badge | Artist selector | Nav sections |
|------|----------|-------|-----------------|--------------|
| artist | Artist Admin | purple | hidden | Manage |
| label | Label Admin | blue | shown (managed artists + self) | Manage Artist + Label Admin |
| operator | Node Operator | green | shown (all artists on node) | Manage Artist + Label Admin + Node Admin |

**Verified with Playwright** against the local node — all three roles render correctly, role badge updates after `whoami` resolves, artist selector switches propagate to `SessionManager.getSelectedArtistPubkey()` and dispatch `equaliser:artist-switched` for downstream pages.

**Important caveats for Phase D/E builders:**
- The label/operator nav links point at pages that don't exist yet (`artist-management.html`, `access-requests.html`, `invite-codes.html`, `node-overview.html`, `sync-manager.html`, `ipfs-storage.html`, `blossom-config.html`, `user-cache.html`, `node-settings.html`). Clicking them 404s until those phases land — intentional.
- Pages that need to scope data by selected artist (Phase D's artist-management views, eventually dashboard/releases for labels) should read `SessionManager.getSelectedArtistPubkey()` and listen for `window.addEventListener('equaliser:artist-switched', ...)` to refresh on switch.
- The first paint uses cached role from sessionStorage if present, otherwise defaults to `'artist'` until `fetchRole()` resolves. Don't render role-gated UI without checking `SessionManager.getRole()` is non-null, or you may briefly flash artist-only UI to a label/operator.

### Phase D: Label Admin Pages ✅

**Done:**

| File | What was done |
|------|---------------|
| `content_node/orchestrator/css/admin-base.css` | New shared stylesheet for new admin pages — body/container/main-content layout, buttons (`.btn-primary`, `.btn-success`, `.btn-danger`, `.btn-small`), forms, `.data-table`, status/role badges, tabs, modals, `.code-display`, notices, loading spinner. Existing admin pages keep their inline styles; only new pages reference this file. |
| `content_node/orchestrator/artist-management.html` | List managed artists. Label sees `managed_by = self`; operator sees all artists with extra Managed By column. Per-row Edit modal (status: active/suspended; fee_model: free/percentage/flat_rate; fee_value with model-aware label/hint) and quick Suspend/Activate button. Calls `GET /api/label/artists` and `PATCH /api/label/artists/{pubkey}`. |
| `content_node/orchestrator/access-requests.html` | Tabs: Pending / Approved / Declined with live counts. Pending cards show all submitted fields (email, npub, description, links) with Approve/Decline action buttons. Approve modal accepts admin notes → on success a second modal displays the generated invite code with Copy button. Decline modal captures notes. Approved cards display the existing invite code inline. Calls `GET /api/label/access-requests?status=`, `POST /api/label/access-requests/{id}/approve`, `POST /api/label/access-requests/{id}/decline`. |
| `content_node/orchestrator/invite-codes.html` | Table of unused invite codes with source provenance (orphan codes labeled "Standalone (no request)" — relay marks them with `artist_name='(direct invite)'`). Per-row Copy and Generate New button → modal with Copy. Calls `GET /api/label/invite-codes` and `POST /api/label/invite-codes`. |

All pages: gate access on `SessionManager.getRole() in ('label', 'operator')` after `fetchRole()` resolves; use `SessionManager.authFetch` for NIP-98 auth; show inline `.notice` toasts for success/error; preserve admin-sidebar.js role-aware nav (Artists/Access Requests/Invite Codes appear under "Label Admin").

**Verified with Playwright:**
- Label sees only `managed_by = self` artists (2 of 3 seeded); operator sees all 3 plus Managed By column.
- All 3 access-request tabs render with correct counts; approve flow generates a new 12-char hex code and refreshes counts in real time.
- Invite codes page shows codes from approved requests with attribution + standalone-generated codes labeled correctly.

**Important caveats:**
- The relay's `CreateOrphanInviteCode` writes `artist_name='(direct invite)'` into `access_requests` to keep the table single-shape. The invite-codes UI special-cases this string (and `'__orphan__'`) to display "Standalone (no request)". If the relay ever changes that sentinel, update [content_node/orchestrator/invite-codes.html](../content_node/orchestrator/invite-codes.html).
- The "Add new artist directly" workflow isn't part of Phase D — Phase D only manages artists onboarded via access requests + invite codes. If labels need to provision artists outside the request flow, that goes with Phase E (label-managed key derivation, NIP-06 paths).

### Phase E: Operator Admin Pages ✅

**Done (backend additions):**

| File | What was done |
|------|---------------|
| `content_node/equaliser-relay/internal/storage/peers.go` | New `PeerRelayInfo` struct + `ListPeers()` method returning full peer_relays state |
| `content_node/equaliser-relay/internal/api/api.go` | `Server` now takes `*PeerStore`; new `GET /api/internal/peer-relays` handler |
| `content_node/equaliser-relay/cmd/relay/main.go` | Threads peerStore into `api.NewServer` |
| `content_node/orchestrator/api/services/relay_admin.py` | `list_peer_relays()` wraps the relay endpoint |
| `content_node/orchestrator/api/routers/operator.py` | Replaced `/sync/status` stub with `/sync/peers` (peers + standard relays + local). Added `/ipfs/stats` (proxies IPFS HTTP API: repo/stat, pin/ls, swarm/peers, id), `/blossom/status` (reachability check), `/settings` (read-only env dump). `/overview` now also returns `services` health for orchestrator/relay/IPFS/Blossom |

**Done (pages):**

| File | What was done |
|------|---------------|
| `content_node/orchestrator/node-overview.html` | Node name + public URL meta, 7 stat tiles (artists/labels/operators/listeners/events/releases/pending), service-health rows with pulsing dots and HTTP status badges |
| `content_node/orchestrator/sync-manager.html` | Equaliser peer relay table (URL, status badge, event count, error count, last connected, last event timestamp); standard NOSTR relay list; local relay row |
| `content_node/orchestrator/ipfs-storage.html` | Peer ID + agent header, 5 stat tiles (repo size with human bytes, storage max, object count, pinned count, swarm peers), sample of pinned CIDs with gateway "View" links |
| `content_node/orchestrator/blossom-config.html` | Server URL / public URL / status info rows; future-card flagging Phase D mirroring as deferred (links to NODE-MANAGEMENT-SPEC.md Section 7) |
| `content_node/orchestrator/user-cache.html` | Paginated table of registered listeners (npub, pubkey, registered, last seen, cache enabled flag) with prev/next pagination and `PAGE_SIZE=25` |
| `content_node/orchestrator/node-settings.html` | Read-only banner + 4 sections (Node, Service URLs, Standard NOSTR Relays, Allowed CORS Origins) listing env vars and current values; explicitly hides any sensitive values |

All pages: gate on `SessionManager.getRole() === 'operator'` after `await fetchRole()`; use `SessionManager.authFetch` for NIP-98; reference `css/admin-base.css`; no role-aware mutations (read-only by design — node config changes go through env + container restart).

**Verified with Playwright as operator:**
- node-overview shows 7 stat tiles + 4 service-health rows all "ok (200)"
- sync-manager renders peer-relays table from DB and standard-relays list from `STANDARD_RELAYS` env
- ipfs-storage shows real numbers (62 MB repo, 9 GB max, 775 objects, 3 pins, 21 swarm peers in dev) + IPFS peer ID
- blossom-config status badge reads "ok (200)" with future-card visible
- user-cache returns paginated rows from `registered_users` table
- node-settings renders 4 sections with env-var labels next to current values

**Important caveats / scope limits:**
- The Blossom mirroring config UI is intentionally a placeholder — the cluster/blossom backend (Section 7 of the spec) hasn't been built. The `blossom_servers` and `blossom_mirrors` tables exist but are unused.
- Node settings are display-only. The path to mutating settings is editing env vars and restarting containers; building a write API would mean writing back to env or a config file plus a graceful service reload, which is out of scope.
- `/api/operator/ipfs/stats` calls IPFS API directly with a 10s timeout. On heavily loaded nodes the `pin/ls` call may be slow — sample is capped at first 20 CIDs to avoid massive payloads.
- The IPFS service health check uses `POST /api/v0/version` (the only stable IPFS API verb that's idempotent and lightweight). Don't switch to `GET` — Kubo only accepts `POST` on these endpoints.

## Verification

1. ~~Architecture doc reviewed and approved before any implementation~~ ✅
2. ~~Phase A: DB migration + role resolution~~ ✅ Tested locally
3. ~~Phase B: API permission model~~ ✅ Tested locally with NIP-98 auth
4. ~~Phase C: UI role-aware sidebar~~ ✅ Verified with Playwright across all 3 roles
5. ~~Phase D: Label pages~~ ✅ Verified with Playwright as both label and operator
6. ~~Phase E: Operator pages~~ ✅ Verified with Playwright across all 6 operator pages
