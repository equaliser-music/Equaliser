# Plan: In-app roster invite (Issue 20)

> Status: **approved, implementation pending** (planned 2026-06-14). Tracks Issue 20 in
> [ARTIST_LABEL_CHANGES.md](ARTIST_LABEL_CHANGES.md). Issue 19 (roster invite stores/displays the
> artist name) is already shipped; this plan covers only the in-app notification banner.

## Context

When a label uses "Add Existing Artist", it generates a roster invite **code** that today must be shared **out-of-band** — the targeted artist gets no in-app signal. UAT (2026-06-14): "Typically Magic Records" added "Shibuya Crossings"; Shibuya, logged in as an artist on the same node, saw nothing. User chose the **in-app roster invite**: when a label adds an existing artist *by npub*, that artist sees a "*\<Label\> invited you to their roster — Accept*" banner on login and accepts in one click.

Scope note (important): the banner is for an **already-onboarded** artist (has a `node_artists` row, role=`artist`, so they can reach admin pages) who gets invited into a label's roster — exactly the UAT case (Shibuya onboarded self, then Magic invites her; accepting flips her `managed_by` to Magic). An artist with **no** role on this node can't see admin pages at all (strict gate → redeem.html), so for them the out-of-band code remains the path. The label must enter the artist's **npub** for the in-app invite to target them; without it, behaviour is unchanged (OOB code).

Matching is done on the artist's **hex pubkey** (their NIP-98-verified identity), not bech32 — so no backend bech32 decoding and no trust of a client-supplied identity. The label's browser (which has nostr-tools) decodes the entered npub → hex at add time.

## Schema

**New migration `content_node/equaliser-relay/migrations/007_roster_invite_target.sql`:**
```sql
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS target_pubkey TEXT;
```
Auto-applied on relay startup (`RunMigrations`, `postgres.go:43`). Non-destructive — existing onboarded data preserved. `target_pubkey` holds the hex pubkey a roster invite is aimed at (NULL for standalone/`/join` invites). The bech32 `npub` column (added in Issue 19) stays for display.

## Backend — relay (Go)

**`internal/storage/admin.go`**
- `CreateOrphanInviteCode`: add a `targetPubkey string` param; include `target_pubkey` in the INSERT (alongside the Issue-19 `artist_name`/`npub`). Empty → store NULL via `nullableString`.
- New `ListRosterInvitesForPubkey(ctx, pubkey string) ([]map[string]interface{}, error)` mirroring `ListInviteCodes`'s style (admin.go:440):
  ```sql
  SELECT id, artist_name, npub, invite_code, reviewed_at, target_managed_by,
         COALESCE(target_relationship_type,'managed'), issued_by
  FROM access_requests
  WHERE status='approved' AND invite_used=FALSE AND target_role='artist'
        AND target_managed_by IS NOT NULL AND target_pubkey = $1
  ORDER BY reviewed_at DESC
  ```

**`internal/api/api.go`**
- `handleCreateInviteCode`: decode `target_pubkey` from the body struct; pass to `CreateOrphanInviteCode`.
- New `handleListRosterInvites` (GET `/api/internal/roster-invites?target_pubkey=<hex>`) → `ListRosterInvitesForPubkey` → `{invites: [...]}`. Register in the mux next to the other invite-code routes (api.go:78-81). Validate the hex pubkey with the existing `validateHexPubkey`.

## Backend — orchestrator (Python)

**`api/services/relay_admin.py`**
- `create_invite_code`: add `target_pubkey: str = ""` param; include in body when set (mirrors the Issue-19 `artist_name`/`npub` additions).
- New `list_roster_invites_for_pubkey(pubkey)` → `GET /api/internal/roster-invites?target_pubkey=...` → returns `data.get("invites", [])`.

**`api/routers/label.py`** — `AddExistingArtistRequest` gains `target_pubkey: Optional[str] = ""`; `add_existing_artist` passes it to `create_invite_code`. (Server trusts the client-decoded hex; it's only a notification target, and redeem itself is still NIP-98-gated.)

**`api/routers/access.py`** — new `GET /api/access/my-roster-invites` (`Depends(require_auth)` → caller hex): calls `relay_admin.list_roster_invites_for_pubkey(pubkey)`, returns `{invites: [...]}`. Each invite carries `invite_code`, `target_managed_by` (label pubkey), `target_relationship_type`. Reuses the existing redeem path (`POST /api/access/redeem`) for accept — no new redeem logic.

## Frontend

**`artist-management.html` — Add Existing Artist form**
- Reframe the npub field from "optional, record-keeping" to the targeting mechanism: *"Artist npub — enter it so they get an in-app invite. Without it you'll need to share the code manually."*
- On submit: normalise the entered value with `NostrTools.nip19` — accept `npub1…` (decode→hex) or raw 64-hex; derive `target_pubkey` (hex) and a canonical `npub` for display. Send `artist_name`, `npub`, `target_pubkey`, `relationship_type`. Invalid input → inline error. If left blank, send no target (OOB-only, unchanged).

**`common/js/admin-sidebar.js` — banner (reuses the `renderActingAsBanner` pattern, admin-sidebar.js:155)**
- New `_checkRosterInvites()` invoked from `init()` after `fetchRole()` resolves, **only when `getRole()==='artist'`**. Calls `SessionManager.authFetch('/api/access/my-roster-invites')`; if any invite, inject a `.roster-invite-banner` into `.main-content` (same `insertAdjacentElement('afterbegin', …)` + idempotent-remove pattern as the acting-as banner; new blue-tinted CSS class).
- Banner: "**\<Label name\>** invited you to their roster (\<managed|signed\>)" + **Accept** + **Dismiss**. Resolve the label's display name from its Kind 0 via the same cache-API lookup the sidebar dropdown already uses (`/api/cache/events?kinds=0&authors=<label_pubkey>`), falling back to the pubkey prefix.
- **Accept (one click)**: confirm → `SessionManager.authFetch('/api/access/redeem', {method:'POST', body: {code, display_name:''}})`. On success: re-`fetchRole()` (now `managed_by` set) and reload so the managed state reflects everywhere. On error (e.g. `already_managed_by_other`), show the relay's detail in the banner. Reuses the existing redeem transaction — for an already-onboarded artist the `node_artists` UPSERT flips `managed_by` self→label and applies the invite's `relationship_type` (admin.go redeem UPSERT), no backup/profile re-run.
- **Dismiss**: hide for this session (`sessionStorage`), no server change. Real server-side decline deferred.

## Files to modify

| File | Change |
|---|---|
| `content_node/equaliser-relay/migrations/007_roster_invite_target.sql` | NEW — add `target_pubkey` column |
| `content_node/equaliser-relay/internal/storage/admin.go` | `CreateOrphanInviteCode` stores `target_pubkey`; new `ListRosterInvitesForPubkey` |
| `content_node/equaliser-relay/internal/api/api.go` | decode `target_pubkey`; new `handleListRosterInvites` + route |
| `content_node/orchestrator/api/services/relay_admin.py` | `create_invite_code` gains `target_pubkey`; new `list_roster_invites_for_pubkey` |
| `content_node/orchestrator/api/routers/label.py` | `add_existing_artist` threads `target_pubkey` |
| `content_node/orchestrator/api/routers/access.py` | new `GET /api/access/my-roster-invites` (NIP-98) |
| `content_node/orchestrator/artist-management.html` | npub → hex `target_pubkey`, prominence + validation |
| `common/js/admin-sidebar.js` | `_checkRosterInvites()` banner + one-click accept + CSS |
| `docs/ARTIST_LABEL_CHANGES.md` | mark Issue 20 shipped |

Reused (read-only): the redeem transaction `RedeemInviteCode` (admin.go) via `POST /api/access/redeem`; the `renderActingAsBanner` injection pattern + `.acting-as-banner` CSS; the sidebar's Kind-0 cache-API name resolution; `redeem.html?code=` deep-link (kept as the fallback path); `validateHexPubkey`, `nullableString`, the `_request` httpx wrapper.

## Verification (local-only; preserves no data — full reset)

1. `./tools/reset-node.sh --force -d` (rebuilds relay with migration 007 + Go changes; rebuild orchestrator for Python). Wait healthy.
2. **API smoke (Node + nostr-tools):** claim operator → create + redeem a label (Magic) → onboard a self artist (Shibuya) → as Magic call `add-existing-artist` with Shibuya's `target_pubkey` → as Shibuya `GET /api/access/my-roster-invites` returns the invite → `POST /api/access/redeem` with its code → assert `node_artists.managed_by(Shibuya)=Magic` and `relationship_type` applied. Negative: a second label's invite → accept → `already_managed_by_other` (409). Assert standalone `/join`-style invites (no `target_pubkey`) never appear in `my-roster-invites`.
3. **Playwright UI:** inject Shibuya's session → load dashboard → assert the roster-invite banner shows with Magic's resolved name → click Accept → assert banner clears and `getRole()` reflects managed. Screenshot, then clean `/tmp`.
4. Confirm the label side still shows "Roster invite: Shibuya Crossings" (Issue 19) and that an invite created **without** an npub produces no banner (OOB-only path intact).

## Out of scope / deferred
- Never-onboarded artists (no node role) — they can't see admin; OOB code stays their path.
- Server-side "decline" (marking the invite) — MVP dismiss is client-session only.
- Multiple simultaneous invites UI — show all in the banner stack or just the most recent (render the list; accept is per-invite).
- Relay + orchestrator both need a rebuild (Go migration + Python); `artist-management.html` + `admin-sidebar.js` are bind-mounted (no rebuild).
