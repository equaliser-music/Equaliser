# Content Node (Artist Admin + Backend)

Docker Compose stack: orchestrator (FastAPI), Equaliser Relay (Go), IPFS (Kubo), Blossom, nostr-rs-relay (standard relay), PostgreSQL, nginx.

## First-time setup (Phase A — gated onboarding)

After `docker compose up`, the relay generates a one-time **setup token** (because no operator exists yet) and prints a banner like:

```
============================================================
 NO OPERATOR CONFIGURED. To claim this node:
   1. Visit /admin/setup.html in your browser
   2. Enter setup token: <64-char hex>
   3. Sign in with your nsec or NIP-07 extension
 Token is also at /data/setup-token.txt inside the relay container.
============================================================
```

Two ways to find the token:
- `docker logs equaliser-relay 2>&1 | grep "Enter setup token"`
- `docker exec equaliser-relay cat /data/setup-token.txt`

Visit `/admin/setup.html` (or just `/admin/login.html` — it auto-redirects) to claim. Token rotates on every restart until claimed; cleared once the first operator exists.

**Headless / automated alternative**: set `OPERATOR_PUBKEYS=<hex>,<hex>` env var on the relay container. `BootstrapOperators` inserts on startup, skipping the setup-token flow.

After the first operator exists, all further onboarding is invite-only:
- Subsequent operators: existing operator generates an `operator` invite via `/admin/invite-codes.html`
- Labels: existing operator generates a `label` invite (or approves a `/join` application as a label)
- Artists: anyone applies via `/join`, an operator/label approves and shares the invite code

**Recovery**: every onboarding flow forces a backup-file download (`equaliser-operator-backup-*.json` / `equaliser-backup-*.json`). Restore via the existing backup-file path on `/admin/login.html`. **Lose both nsec AND backup → only path is psql or another operator's invite** (email recovery is deferred — see [docs/LOGIN_CONSOLIDATION_PLEASE_REVIEW.md](../docs/LOGIN_CONSOLIDATION_PLEASE_REVIEW.md)).

## Docker Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| orchestrator | FastAPI (Python) | 8000 | Track upload, HLS encoding, IPFS/Blossom coordination, draft management |
| equaliser-relay | Custom Go binary | 8080 (WS), 8008 (REST) | NOSTR relay with PostgreSQL storage, full tag indexing, peer syncer, cache REST API |
| ipfs | ipfs/kubo | 5001 (API), 8080 (gateway) | Content-addressed storage for HLS streams and cover art |
| blossom | hzrd149/blossom-server | 3000 | Original audio + image storage by SHA-256 hash. BUD-03 auth |
| nostr-rs-relay | scsibug/nostr-rs-relay | 7700→8080 | Open standard NOSTR relay for user data caching (syncer pulls from this) |
| postgres | postgres:15-alpine | 5432 | PostgreSQL database owned by Equaliser Relay |
| web | nginx:alpine | 80 | Reverse proxy routing to all services + static file serving |

## Orchestrator API (orchestrator/api/)

### Core (`main.py`)
FastAPI app. CORS allow-all (dev). Initialises database + node identity on startup. Mounts 3 routers: tracks, drafts, packages.

### Services (orchestrator/api/services/)

| Module | Purpose | Integrations |
|--------|---------|--------------|
| `node_identity.py` | Persistent secp256k1 keypair for BUD-03 auth. Loads/generates from `/data/node_identity.json` | Blossom (signs Kind 24242 upload auth events) |
| `database.py` | SQLite CRUD for `draft_tracks` table. Fields: metadata, IPFS CIDs, Blossom hashes, NOSTR event status | Local SQLite file |
| `ipfs.py` | IPFS HTTP API client. `upload_file`, `upload_directory`, `pin_cid`, `unpin_cid`, `announce_to_dht` | IPFS API (port 5001) |
| `nostr.py` | Event creation + WebSocket publishing. Kind 30050 (tracks), Kind 30051 (releases). `create_track_event()`, `sign_event()`, `publish_event()`, `fetch_track_events()` | NOSTR relay (WebSocket) |
| `hls.py` | FFmpeg/ffprobe wrapper. `encode_to_hls()` produces full + 30s preview manifests. `get_audio_duration()` | FFmpeg binary in container |
| `blossom.py` | Blossom client with BUD-03 auth. `upload_to_blossom()`, `check_blob_exists()`, `download_from_blossom()`, `delete_from_blossom()`. Deduplication via HEAD check before upload | Blossom (port 3000) |
| `blossom_cleanup.py` | Periodic orphan blob cleanup. Scans Blossom SQLite for blobs with no owners, deletes files + DB records. Runs every 5 min (configurable via `BLOSSOM_CLEANUP_INTERVAL`) | Blossom data volume (`/blossom-data`) |

### API Endpoints (orchestrator/api/routers/)

**tracks.py** — Upload and publish:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/tracks/upload` | Upload audio → background: Blossom original → HLS encode → IPFS → draft |
| POST | `/api/tracks/duplicate` | Duplicate draft with independent IPFS CIDs (shared Blossom hash). Background: Blossom download → HLS encode → IPFS → new draft |
| GET | `/api/tracks/status/{track_id}` | Poll upload/duplicate progress |
| GET | `/api/tracks/` | List completed uploads |
| POST | `/api/tracks/publish` | Publish pre-signed Kind 30050 to relay, delete draft |
| POST | `/api/tracks/cover-art` | Upload cover to Blossom (primary) + IPFS (fallback). Absolute Blossom URL via `PUBLIC_BASE_URL` |
| POST | `/api/tracks/cleanup` | Unpin IPFS CIDs + delete Blossom blobs for deleted releases. Best-effort, client determines shared-reference safety |

**drafts.py** — Draft management:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/drafts` | List drafts (filter by pubkey, status, album) |
| GET | `/api/drafts/{id}` | Get single draft |
| PATCH | `/api/drafts/{id}` | Update metadata |
| DELETE | `/api/drafts/{id}` | Delete draft |
| POST | `/api/drafts/{id}/release` | Get unsigned Kind 30050 for client signing |
| POST | `/api/drafts/release-album` | Batch: unsigned events for all album tracks |
| POST | `/api/drafts/{id}/mark-released` | Delete draft after NOSTR publication |

**packages.py** — `.eqpkg.zip` export/import:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/releases/export-prepare` | Build manifest, return unsigned event for signing |
| POST | `/api/releases/export-download` | Download ZIP (manifest + signature + audio from Blossom) |
| POST | `/api/releases/import` | Import ZIP → Blossom upload → HLS encode → IPFS → drafts |

**uploads.py** — Image uploads:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/upload/image` | Upload image to Blossom. Returns `{ blossom_hash, blossom_url }`. Absolute URL when `PUBLIC_BASE_URL` is set. Used by client settings (avatar/banner) and social feed image attach. |

**auth.py** — Role resolution:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/auth/whoami` | Returns authenticated user's role and managed artists. NIP-98 auth required. Response: `{ pubkey, role, managed_artists }` |

**access.py** — Public access control + invite redemption (Phase A). No role-gating; NIP-98 where indicated:

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/api/access/request` | none | Public — create an `access_requests` row from `/join` form. Body: `{requested_role, artist_name, email, npub, description, links, target_relationship_type?}`. `requested_role ∈ {artist, label}`; `operator` rejected (cannot self-apply). `target_relationship_type` (Phase G) defaults to `managed`; coerced to `self` for label applications. |
| GET | `/api/access/check-invite?code=...` | none | Public preview — returns `{valid, target_role, target_managed_by, target_relationship_type, issuer_name}` or 404. Used by `redeem.html`/`onboarding.html` Step 0. |
| POST | `/api/access/redeem` | NIP-98 | Body: `{code, display_name}`. Verified pubkey + code → atomic redeem in relay. Returns RedeemResult with `node_artist` or `node_operator`. |
| GET | `/api/access/setup-status` | none | `{needs_setup: bool}` — used by login/dashboard/setup pages to detect fresh-deploy state. |
| POST | `/api/access/claim-operator` | NIP-98 | Body: `{token, name}`. Token from `/data/setup-token.txt` or relay logs. Claims first operator slot. |

**label.py** — Label admin (requires label or operator role):

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/label/artists` | List managed artists. Operator sees all; label sees those where `managed_by` = caller pubkey |
| GET | `/api/label/artists/{pubkey}` | Get single artist details (includes `relationship_type`) |
| PATCH | `/api/label/artists/{pubkey}` | Update status (active/suspended), fee_model (free/percentage/flat_rate), fee_value, `relationship_type` (self/managed/signed). Operator-only: `managed_by` transfer (empty string clears, hex sets) — used for label switches (Magic→Sony). |
| GET | `/api/label/access-requests?status=` | List access requests (filter: pending/approved/declined) |
| GET | `/api/label/access-requests/{id}` | Get single request |
| POST | `/api/label/access-requests/{id}/approve` | Approve, generate 12-char hex invite code. Body: `{admin_notes, target_role, target_managed_by, target_relationship_type}`. `target_role` defaults to `requested_role`; `label`/`operator` require operator caller. `target_relationship_type` defaults to the request's value (Phase G), normalised to `self` for operator/standalone-label codes. Records `issued_by` = caller pubkey. |
| POST | `/api/label/access-requests/{id}/decline` | Decline with optional admin_notes |
| GET | `/api/label/invite-codes` | List unused invite codes (includes target_role, target_managed_by, target_relationship_type, issued_by) |
| POST | `/api/label/invite-codes` | Generate orphan invite code. Body: `{target_role, target_managed_by, target_relationship_type}`. Operator-only constraint: `target_role ∈ {label, operator}` rejected for non-operator callers. Operator codes never carry `target_managed_by` and are always `relationship_type=self`. |
| POST | `/api/label/add-existing-artist` | (Phase A) Generate roster invite code with `target_managed_by = caller pubkey`. Body: `{artist_name, npub?, relationship_type}` — `relationship_type ∈ {managed, signed}` (Phase G picker: managed = NIP-26 delegation, signed = label owns recording). Label shares code OOB; existing-pubkey artist redeems via `/admin/redeem.html`. |

**operator.py** — Operator admin (requires operator role or `X-Admin-Token`):

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/operator/overview` | Node name, public URL, stats (artist/label/operator/user counts, events, releases) + service health pings (orchestrator/relay/IPFS/Blossom) |
| GET | `/api/operator/registered-users` | Paginated list of registered listeners |
| GET | `/api/operator/sync/peers` | Peer relay state from `peer_relays` table + configured standard relays + local relay URL |
| GET | `/api/operator/ipfs/stats` | IPFS repo/stat, pin count + sample, swarm peer count, peer ID — proxies IPFS HTTP API |
| GET | `/api/operator/blossom/status` | Blossom server reachability check (URL, public URL, http_status) |
| GET | `/api/operator/settings` | Read-only env config (node name, service URLs, standard relays, CORS origins). No sensitive values exposed |

**delegations.py** — NIP-26 label-on-behalf-of-artist delegation lifecycle (Phase F):

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/api/delegations/request` | NIP-98 (label/operator) | Body `{artist_pubkey, requested_kinds?, duration_days?, note?}`. Creates a pending request. `ctx.can_manage(artist)` enforced. |
| GET | `/api/delegations/incoming?status=pending` | NIP-98 (any pubkey) | Caller-as-artist: list requests aimed at them. |
| GET | `/api/delegations/outgoing` | NIP-98 (label/operator) | Caller-as-label: list requests they've issued. |
| POST | `/api/delegations/{id}/grant` | NIP-98 (artist) | Body `{conditions, signature}`. Server verifies delegation signature, marks request granted, upserts `artist_delegations`. |
| POST | `/api/delegations/{id}/decline` | NIP-98 (artist) | |
| GET | `/api/delegations/active` | NIP-98 (label/operator) | Caller's active delegations — used when constructing publishable events. |
| GET | `/api/delegations/active/{artist_pubkey}` | NIP-98 (label/operator) | Specific active delegation for one artist. 404 if none. |
| POST | `/api/delegations/{artist_pubkey}/revoke?label_pubkey=...` | NIP-98 (artist) | Artist revokes (caller pubkey must equal `artist_pubkey`). |

`tracks.publish` is a 3-way router covering self-publish + the two label-on-behalf flows:

1. **Self-publish** (`event.pubkey == ctx.pubkey`, no delegation/performer tag): caller publishes under their own identity. `ctx.can_manage(event.pubkey)` enforced.
2. **Phase F — Managed (NIP-26 delegation)**: event signed by caller (the label) with a `["delegation", artist_pubkey, conditions, signature]` tag. Verified via `services/nip26.py:verify_event_delegation` AND cross-checked against the active server-side record (revoked delegations rejected).
3. **Phase G — Signed (performer tag)**: event signed by caller (the label) with a `["p", artist_pubkey, "", "performer"]` tag and NO delegation tag. Strict-mode gate: `node_artists[performer].managed_by == ctx.pubkey` — only the artist's current label can publish. Other labels get 403 `not_current_label`.

Delegation and performer tags are mutually exclusive (publish returns 400 if both are present). The relay's denorm parser independently honours either tag and routes the track to the artist's `cached_tracks` row (with `event.pubkey` recorded as both `published_by` and `label_pubkey` — the latter is the consistent who-signed column across F + G).

**Authorization dependencies** (`dependencies.py`):
- `require_auth` — NIP-98 only, returns pubkey (existing)
- `require_role` — NIP-98 + role resolution from relay DB. Returns `RoleContext(pubkey, role, managed_artists)`
- `require_label` — Requires `role` = `label` or `operator`
- `require_operator` — Requires `role` = `operator`, or `X-Admin-Token` header matching `ADMIN_PASSWORD` env var

**Permission pattern** for existing endpoints (drafts, tracks, packages): each endpoint takes `ctx: RoleContext = Depends(require_role)` and calls `ctx.can_manage(target_pubkey)` before allowing access. Target pubkey is either passed explicitly (query/body) or derived from the resource (e.g. `draft.artist_pubkey`). Operator can manage any artist; label can manage their artists; artist can only manage themselves.

**Relay internal admin API** (`/api/internal/*` — Docker network only):
- `/api/internal/artists`, `/api/internal/artists/{pubkey}` (GET, PATCH)
- `/api/internal/access-requests`, `/api/internal/access-requests/{id}`, `/{id}/approve`, `/{id}/decline`
- `/api/internal/invite-codes` (GET, POST)
- `/api/internal/registered-users`
- `/api/internal/stats`
- `/api/internal/auth/role`

The orchestrator's `services/relay_admin.py` wraps these with httpx; orchestrator routers add NIP-98 auth + role checks before calling them.

**users.py** — User registration:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/users/register` | Proxy user pubkey registration to relay internal API (for data caching) |

**main.py** — Config and health:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Health check for container orchestration |
| GET | `/api/config` | Client-facing config: returns `{ standard_relays, public_base_url }` from env vars. Client uses `standard_relays` as default outbound publishing relays. Must match `STANDARD_RELAYS` on the Equaliser relay service. |

## Admin Pages (orchestrator/*.html)

All pages use shared `/common/js/session.js` and `/common/js/admin-sidebar.js` (mounted at `/common/` by nginx — see top-level [common/](../common/) directory). Admin pages opt-in to admin behaviours by setting `window.EQ_SURFACE = 'admin'` before the session.js script tag (skips listener-cache auto-registration).

| Page | Purpose |
|------|---------|
| `login.html` | nsec / NIP-07 / backup-file login. **Phase A**: redirects to `/admin/setup.html` if no operators yet, or to `/admin/redeem.html` if logged-in pubkey has no role on this node. |
| `setup.html` | (Phase A) First-run claim. Visible when `node_operators` is empty. Token from relay logs / `/data/setup-token.txt` + nsec → first operator. Mandatory backup-file download before continuing. |
| `redeem.html` | (Phase A) Existing-pubkey invite-code redemption. Used for listener→artist promotion, label-roster joins, operator-invite redemption. Shows code metadata preview before commit; mandatory backup-file step. |
| `onboarding.html` | First-time setup: **Step 0 invite-code gate**, generate identity, upload avatar/banner, publish Kind 0, then `/api/access/redeem` to create `node_artists` row. Strict — no code = no onboarding. |
| `dashboard.html` | Home: recent releases (Kind 30050), profile (Kind 0), track count |
| `releases.html` | Drafts + released tracks. Upload, edit, release, export. Release announcement modal (post Kind 1 to social feed after releasing) |
| `edit-release.html` | Edit metadata for draft or released track. Cover art upload. Add existing tracks (duplicated with independent IPFS CIDs) or upload new tracks directly into a release. Delete released tracks (Kind 5 + storage cleanup). Release announcement modal |
| `profile.html` | Edit Kind 0 profile (name, bio, avatar, banner via Blossom, socials). `ensureAbsoluteBlossomUrl()` converts relative Blossom URLs to absolute on save |
| `upload.html` | Standalone track upload form |
| `settings.html` | Placeholder for future settings (artist settings — listeners use client `/settings.html`) |
| `artist-management.html` | (Label/operator) Manage artists with role/status/fee badges, edit modal (status, fee_model, fee_value), quick suspend/activate. Operator view shows Managed By column + all artists. |
| `access-requests.html` | (Label/operator) Pending/Approved/Declined tabs. Approve modal generates invite code (shown in second modal); decline modal captures admin notes. Approved cards display existing invite code inline. |
| `invite-codes.html` | (Label/operator) Lists unused invite codes with provenance (approved request name or "Standalone"). Generate New button creates a standalone (orphan) code. Copy buttons throughout. |
| `node-overview.html` | (Operator) Stat tiles + service health pings for orchestrator/relay/IPFS/Blossom. |
| `sync-manager.html` | (Operator) Peer relay table from `peer_relays` (status, event count, errors, last connect/event), standard NOSTR relay list from `STANDARD_RELAYS` env, local relay info. |
| `ipfs-storage.html` | (Operator) IPFS repo size/storage max/object count/pin count/swarm peers, peer ID, sample of pinned CIDs with gateway view links. |
| `blossom-config.html` | (Operator) Blossom server status. Mirroring config is deferred (placeholder card linking to NODE-MANAGEMENT-SPEC.md Section 7). |
| `user-cache.html` | (Operator) Paginated table of registered listeners (npub, pubkey, registered, last seen, enabled). |
| `node-settings.html` | (Operator) Read-only env config: Node, Service URLs, Standard Relays, CORS Origins. No write API — change env vars and restart containers. |
| `delegations.html` | (Phase F — artist) NIP-26 delegation inbox, surfaced as "Manager Authorizations" in the sidebar (renamed in Phase G to distinguish from signed-to-label relationships). Lists pending requests from labels (with kinds/duration/note), artist clicks Grant → signs locally with `signDelegation` → POSTs to /api/delegations/{id}/grant. Active delegations also listed with Revoke button. Loads `@noble/curves` schnorr from esm.sh as an ES module to enable client-side BIP-340 signing of the canonical NIP-26 message (nostr-tools' bundle doesn't expose schnorr). File name kept (`delegations.html`); UI copy uses "Manager Authorization". |

## Shared JS — top-level [common/js/](../common/) directory

Mounted at `/common/` by nginx, used by **both** admin and client surfaces. The directory lives at the repo root (sibling of `client/`, `content_node/`, `tools/`, `docs/`) so neither side "owns" it.

| Module | Purpose | Used By |
|--------|---------|---------|
| `/common/js/session.js` | Session management. nsec / NIP-07 / backup-file login. 30-min idle timeout, multi-tab logout sync. `signEvent()` auto-adds `["app", "Equaliser"]` tag. `authFetch()` adds NIP-98 auth header — also computes SHA256 of body and adds it as a `payload` tag for POST/PUT/PATCH (anti-MITM body-swap; server verifies if present). `fetchRole()` calls `/api/auth/whoami` and exposes `getRole()`/`getManagedArtists()`/`getSelectedArtistPubkey()`/`setSelectedArtistPubkey()`. Persists role + selected artist in sessionStorage and broadcasts artist switches across tabs via BroadcastChannel + `equaliser:artist-switched` window event. Surface-aware: when `window.EQ_SURFACE !== 'admin'`, auto-registers pubkey with the listener cache via `POST /api/users/register` after login. | All admin AND client pages |
| `/common/js/admin-sidebar.js` | Role-aware navigation sidebar. Two-pass render: synchronous skeleton with cached role, async re-render after `fetchRole()`. Subtitle/badge/nav sections vary by role: artist sees `Manage`; label adds `Label Admin`; operator adds `Node Admin`. Artist selector dropdown shown when label/operator manages >1 artist. Bottom nav has a "Listener View" link to `/`. | All admin pages |

### Admin page conventions (Phase D/E pattern)

Phase D and E admin pages all follow the same pattern — start any new admin page from one of these:

- Label pages (Phase D): `artist-management.html`, `access-requests.html`, `invite-codes.html`
- Operator pages (Phase E): `node-overview.html`, `sync-manager.html`, `ipfs-storage.html`, `blossom-config.html`, `user-cache.html`, `node-settings.html`

Conventions to preserve:
- `SessionManager.init()` → `requireSession()` → `AdminSidebar.init()` → `await SessionManager.fetchRole()` → role gate → load data
- Role gate displays an error `.notice` and bails (don't render data UI for the wrong role)
- Use `SessionManager.authFetch` for all API calls — it adds NIP-98 auth automatically
- Pages that scope by artist read `SessionManager.getSelectedArtistPubkey()` and listen for `window.addEventListener('equaliser:artist-switched', ...)` to refresh on switch
- The first paint may briefly show `role='artist'` (the sessionStorage fallback) before `fetchRole()` resolves — gate role-sensitive UI on `SessionManager.getRole()` being non-null and the awaited fetchRole
- Reference `css/admin-base.css` for shared styles; add page-specific CSS in a per-page `<style>` block

### Shared admin CSS

`content_node/orchestrator/css/admin-base.css` is referenced by Phase D pages (and any new admin page going forward). Existing admin pages keep their inline `<style>` blocks for historical reasons — don't refactor them as part of unrelated work. Page-specific styles still go in a per-page `<style>` block; only common patterns (buttons, tables, modals, badges, layout) belong in the shared sheet.

## Config Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Service definitions, volumes, networking |
| `config/blossom/config.yml` | Blossom rules: audio/* + image/* allowed, BUD-03 auth, local file storage |
| `ipfs/configure-gateway.sh` | Startup script: path-style URLs, API on 0.0.0.0 |
| `web/nginx.conf` | Proxy routes: `/api/cache/` → relay REST API, `/api/` → orchestrator, `/relay` → relay WebSocket, `/ipfs/` → IPFS gateway, `/blossom/` → Blossom, `/admin/` → orchestrator static, `/` → client |

## Key Data Flows

**Upload → Draft**: Audio file → Blossom (original) → FFmpeg (HLS) → IPFS (streaming) → SQLite (draft)

**Draft → Release**: Draft metadata → unsigned Kind 30050 → browser signs → publish to relay → delete draft

**Export**: Manifest + Blossom audio → signed `.eqpkg.zip`

**Import**: `.eqpkg.zip` → validate → Blossom upload → HLS encode → IPFS → drafts

**Delete**: Browser signs Kind 5 → publish to relay → `POST /api/tracks/cleanup` (unpin IPFS, delete Blossom) → orphan cleanup removes files from disk

## NOSTR Event Kinds

| Kind | Purpose | Tags |
|------|---------|------|
| 0 | Artist profile | `app`, `user-type` (`"artist"` for artists, omitted for listeners) |
| 1 | Post / reply / quote | `app`, `content-type` (`post`, `reply`, `release-announcement`, `playlist-share`), `e` (NIP-10 root/reply), `p`, `q` (NIP-18 quote reference) |
| 6 | Repost | `app`, `e` (reposted event ID), `p`. Content = JSON of original event |
| 7 | Like / reaction | `app`, `e` (liked event ID), `p`. Content = `+` |
| 30050 | Track metadata (replaceable) | `d`, `app`, `title`, `artist`, `duration`, `ipfs_manifest_cid`, `ipfs_preview_cid`, `price`, `price_currency`, `album`, `genre`, `cover_art_cid`, `blossom_audio_hash`, `blossom_cover_hash`, `blossom_cover_url`, `track_number` |
| 30051 | Release metadata (album grouping) | `d`, `app`, `title`, `artist`, `release_type` |
| 5 | Deletion (NIP-09) | `app`, `e` (event IDs to delete) |
| 24242 | Blossom auth (BUD-03) | `t` (upload/delete), `x` (file hash), `expiration` |

## Key Design Patterns

- **Client-side signing**: Server returns unsigned events; browser signs (non-custodial)
- **Draft → Release workflow**: SQLite for drafts, NOSTR relay becomes source of truth after publish
- **Dual storage**: Blossom for originals (disaster recovery), IPFS for streaming (content-addressed)
- **Storage ownership**: Each release owns its own IPFS CIDs (unique HLS encode). Blossom hashes may be shared across releases (content-addressed dedup). Deletion checks for shared Blossom references before removing.
- **Node identity**: Persistent keypair for server-side Blossom auth (artists don't sign Blossom uploads)
