# Plan: Label Relationships

> **Document status:** Phase F (NIP-26 delegation) was approved, implemented, and shipped on `node-management` (commit history: relay/orchestrator/UI changes for delegation tokens). The original plan is preserved below as historical context.
>
> While reviewing the live walkthrough docs at `/live-pages/`, we identified that the NIP-26 delegation model alone doesn't capture the **traditional label-as-rights-holder** relationship. Phase G (appended at the bottom of this document) introduces a **second, parallel relationship type** — "signed" — where the label is the publisher and rights-holder of specific recordings. Both flows coexist after Phase G:
>
> - **'managed'** (Phase F, NIP-26 delegation) — manager helps an independent artist publish; artist owns recording rights and gets paid.
> - **'signed'** (Phase G, performer tag) — label is the publisher; label owns recording rights and gets paid; royalty splits to artist are off-chain (or future automation).
>
> An artist may have **different recordings owned by different labels over time** (e.g. Taylor Swift on Big Machine → Republic → Taylor's Version). Rights are per-recording, not per-artist. The `node_artists.managed_by` column becomes a soft "current label" hint that determines who can publish *new* releases attributed to the artist (strict mode); old recordings stay forever under whichever label originally signed them.

---

# Phase F: NIP-26 Delegation (shipped)

## Context

Phase A (access control) shipped — labels and artists can be onboarded onto a node via invite codes, and labels can list/edit their roster's drafts and tracks via permission-gated endpoints. **But labels cannot actually publish tracks for managed artists** because Kind 30050 events must be signed by the artist's nsec, and labels don't have it.

Concrete scenario this plan unblocks:

> Magic Records onboards Shibuya Crossings and Swansea Sound. Magic Records uploads tracks, edits metadata, and publishes releases. Shibuya and Swansea hold their own nsecs and use them for social posts (Kind 1, reactions, DMs).

Resolved trust model (your decisions): artists ALWAYS hold their own nsec (no custodial key derivation). They authorize the label via a **NIP-26 delegation token** — a signed condition string saying "label X may sign Kind 30050 (catalog) and Kind 5 (deletion) on my behalf for the next N months". Label's browser holds delegation tokens in `sessionStorage`, never artist nsecs. Artist can revoke at any time.

The existing `node_artists.custody` and `node_artists.derivation_index` columns from migration `003_roles.sql` are NOT used by this plan — they were added for an alternative custodial model. Leave them in place; document them as reserved.

## Confirmed decisions

1. **Non-custodial with NIP-26 delegation.** Artist always owns their nsec. Label gets a signed delegation token per managed artist that they include as a tag on signed Kind 30050 / Kind 5 events.
2. **Label-side storage**: delegation tokens (artist pubkey + conditions + delegator signature) live in the label's browser `sessionStorage`. Cached server-side too — so the label can fetch them from any device after login.
3. **Both onboarding flows coexist** — "Add Existing Artist" (invite-code redemption, artist keeps own keys) is still the only way to join a roster. Newly-onboarded artists then optionally grant the label a delegation as a separate, post-onboarding step.

## Build order

1. Schema migration `005_delegations.sql` — `artist_delegations` table.
2. Relay (Go): `DelegationStore` for CRUD + verification.
3. Orchestrator (Python): new `routers/delegations.py` (5 endpoints) + verification helper in `services/nip26.py`.
4. Frontend: new `delegations.html` (artist's inbox), modal additions to `artist-management.html` (label requests/views delegation), modifications to `releases.html` / `edit-release.html` (publish flow uses delegation), modal in `redeem.html` post-onboarding suggesting "grant your label a delegation".
5. Track publish flow update — `/api/tracks/publish` accepts events signed by the label when a valid delegation exists; relay denorm routes Kind 30050 with delegation tag to the delegator's `cached_tracks` row.
6. Client-side display: `cache-api.js` / `nostr-social.js` respect delegation when attributing events.
7. Playwright verification end-to-end.
8. Documentation updates.

## Schema migration — `content_node/equaliser-relay/migrations/005_delegations.sql`

Additive only.

```sql
-- NIP-26 delegations: artist authorizes label to sign Kind 30050/5 on their behalf.
-- Label-side cache; the canonical source is the signed delegation tag carried on each event.
CREATE TABLE IF NOT EXISTS artist_delegations (
    id SERIAL PRIMARY KEY,
    artist_pubkey TEXT NOT NULL,                 -- delegator
    label_pubkey  TEXT NOT NULL,                 -- delegatee
    conditions    TEXT NOT NULL,                 -- NIP-26 condition string (kind=30050&created_at>X&created_at<Y)
    signature     TEXT NOT NULL,                 -- delegator's BIP-340 sig of sha256("nostr:delegation:<label_pubkey>:<conditions>")
    granted_at    TIMESTAMPTZ DEFAULT NOW(),
    expires_at    TIMESTAMPTZ,                   -- parsed from conditions for cheap filtering
    revoked_at    TIMESTAMPTZ,                   -- artist revoked
    UNIQUE (artist_pubkey, label_pubkey)
);

CREATE INDEX IF NOT EXISTS idx_delegations_label  ON artist_delegations(label_pubkey)  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_delegations_artist ON artist_delegations(artist_pubkey) WHERE revoked_at IS NULL;

-- Label-initiated requests (before the artist signs and grants).
CREATE TABLE IF NOT EXISTS delegation_requests (
    id SERIAL PRIMARY KEY,
    label_pubkey   TEXT NOT NULL,
    artist_pubkey  TEXT NOT NULL,
    requested_kinds TEXT NOT NULL DEFAULT '30050,5',  -- comma-separated
    requested_duration_days INTEGER NOT NULL DEFAULT 365,
    note           TEXT,                         -- "we'd like to publish your back catalogue"
    status         TEXT DEFAULT 'pending',       -- 'pending' | 'granted' | 'declined' | 'expired'
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    responded_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_delegation_requests_artist
    ON delegation_requests(artist_pubkey, status);
```

## Relay backend — Go

**File: `content_node/equaliser-relay/internal/storage/delegations.go` — NEW**

- `DelegationStore` with methods:
  - `CreateRequest(ctx, label, artist, kinds, durationDays, note)` → request id
  - `ListRequestsForArtist(ctx, artist, status)` → []DelegationRequest
  - `ListRequestsForLabel(ctx, label, status)` → []DelegationRequest
  - `GrantDelegation(ctx, requestID, conditions, signature)` → atomic: mark request granted + insert/update `artist_delegations`
  - `DeclineRequest(ctx, requestID)`
  - `ListActiveDelegationsForLabel(ctx, label)` → []Delegation (used by label's UI)
  - `GetActiveDelegation(ctx, artist, label)` → *Delegation or nil
  - `RevokeDelegation(ctx, artist, label)` — sets revoked_at
- Verification helper `VerifyDelegation(d *Delegation) error` — rebuilds the SHA256("nostr:delegation:" + label + ":" + conditions) digest, verifies BIP-340 signature against `artist_pubkey`. Reuse the Schnorr verifier already in the relay (see existing event verification in `internal/relay`).

**File: `content_node/equaliser-relay/internal/api/api.go` — extend**

New `/api/internal/delegations/*` endpoints (Docker-network only, orchestrator wraps with NIP-98 auth):

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/internal/delegations/requests` | label initiates request |
| GET  | `/api/internal/delegations/requests?artist=PUB` | artist's incoming requests |
| GET  | `/api/internal/delegations/requests?label=PUB` | label's outgoing requests |
| POST | `/api/internal/delegations/requests/{id}/grant` | artist signs + grants |
| POST | `/api/internal/delegations/requests/{id}/decline` | artist declines |
| GET  | `/api/internal/delegations/active?label=PUB` | label's active delegations |
| POST | `/api/internal/delegations/{artist}/{label}/revoke` | artist revokes |

**File: `content_node/equaliser-relay/cmd/relay/main.go`** — instantiate `DelegationStore`, pass into `api.NewServer`.

## Orchestrator backend — Python

**File: `content_node/orchestrator/api/services/relay_admin.py` — extend**

Wrappers for each new internal endpoint above (`request_delegation`, `list_delegation_requests`, `grant_delegation`, `revoke_delegation`, `get_active_delegation`).

**File: `content_node/orchestrator/api/services/nip26.py` — NEW**

Pure verifier — given a Kind 30050 event with a `delegation` tag, validates:
- Tag shape: `["delegation", <delegator_pubkey>, <conditions>, <delegator_sig>]`
- Reconstructs the canonical message: `nostr:delegation:<event.pubkey>:<conditions>`
- Verifies the BIP-340 Schnorr signature against `delegator_pubkey` (reuse `services/nip98.py`'s `_verify_schnorr` helper)
- Parses conditions: extracts `kind=N` (must include `event.kind`), `created_at>X` and `created_at<Y` (must contain `event.created_at`)
- Optional cross-check: a row exists in `artist_delegations` for (delegator, event.pubkey) and isn't revoked

**File: `content_node/orchestrator/api/routers/delegations.py` — NEW**

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/api/delegations/request` | NIP-98 (label/operator) | Body `{artist_pubkey, requested_kinds?, duration_days?, note?}`. Creates a pending request. ctx.can_manage(artist) required (label can only request from their own roster). |
| GET  | `/api/delegations/incoming` | NIP-98 (any artist) | List pending requests where `artist_pubkey=ctx.pubkey`. |
| POST | `/api/delegations/{id}/grant` | NIP-98 (artist) | Body `{conditions, signature}`. Server verifies signature with ctx.pubkey, marks request granted, inserts/updates `artist_delegations`. |
| POST | `/api/delegations/{id}/decline` | NIP-98 (artist) | |
| GET  | `/api/delegations/active` | NIP-98 (label/operator) | List label's active delegations — the label's UI hits this on every page load to populate the "I can publish for these artists" set. |
| POST | `/api/delegations/{artist_pubkey}/revoke` | NIP-98 (artist) | Artist revokes (`artist_pubkey == ctx.pubkey` enforced). |

**File: `content_node/orchestrator/api/routers/tracks.py` — modify `/api/tracks/publish`**

Today the endpoint takes a pre-signed event and checks `ctx.can_manage(event.pubkey)`. Update:

- If `event.pubkey == ctx.pubkey` → unchanged (artist publishing their own track).
- If `event.pubkey == label_pubkey` (i.e. ctx) AND event has a `delegation` tag → call `services.nip26.verify_event_delegation(event)`. On success, also call `relay_admin.get_active_delegation(delegator, label)` to confirm not revoked, then forward to relay. The label-signed Kind 30050 carries the delegation tag, so any NIP-26-aware client (including our relay's denorm parser) attributes it to the delegator.

Same pattern for `/api/tracks/cleanup` and the Kind 5 deletion path (label can delete tracks for which they have an active delegation that includes Kind 5).

**File: `content_node/orchestrator/api/main.py`** — mount `delegations.router` at `/api/delegations`.

## Relay denorm change

**File: `content_node/equaliser-relay/internal/storage/denorm.go` — modify `parseTrack`**

When ingesting Kind 30050:
- If event has a `delegation` tag, verify it (using the same Schnorr helper) and use the **delegator's pubkey** as `artist_pubkey` in `cached_tracks`. Also stash the signer (label) in a new optional column `published_by` (also added in `005_delegations.sql`).
- If no delegation tag, behaviour unchanged — `artist_pubkey = event.pubkey`.

This makes track listings naturally show under the artist (Shibuya), not the label that signed.

## Frontend

**NEW**

- `content_node/orchestrator/delegations.html` — artist's inbox. List incoming requests with details (label name, kinds requested, duration, note). Per row: Grant / Decline buttons. Grant flow signs the delegation token client-side using `nostr-tools` and POSTs to the orchestrator. Also lists active delegations the artist has granted (with Revoke button).

**MODIFIED**

- `content_node/orchestrator/artist-management.html` — for each artist row, show delegation status badge (none / pending / active / expired / revoked). Add "Request Delegation" action when status is none/expired. Modal: choose kinds (defaults: 30050, 5), duration (default 1 year), optional note. POSTs to `/api/delegations/request`.
- `content_node/orchestrator/releases.html` and `edit-release.html` — when a label is releasing a track for a managed artist, the publish flow (currently calls `signEvent` with the artist's nsec) is rewritten:
  1. Fetch active delegation for `(artist, label)` from `/api/delegations/active`.
  2. Construct Kind 30050 with `pubkey = label_pubkey`, add `["delegation", artist_pubkey, conditions, signature]` tag.
  3. Sign with label's nsec.
  4. POST to `/api/tracks/publish`.
  Artist-side flow (artist publishing their own tracks) unchanged.
- `content_node/orchestrator/redeem.html` — after a roster invite is redeemed, show an optional "Grant your label publishing rights now?" step. If user clicks, route them to `delegations.html?prefill=<label>&kinds=30050,5`. Otherwise dashboard. Skippable — artist can do it later from their delegations inbox.
- `common/js/admin-sidebar.js` — add a "Delegations" item in the bottom nav for artists (so they can find their inbox). For labels/operators add a "Delegations" link in the Roster section showing active delegations + status.

## Session-side helpers (`common/js/session.js`)

Add small NIP-26 helper:

- `signDelegation(delegateePubkey, conditions)` — builds canonical message `nostr:delegation:<delegatee>:<conditions>`, hashes (SHA-256), signs with the active session's nsec, returns the hex signature. Wraps `NostrTools.schnorrSign` (or the existing extension `signSchnorr` method when in NIP-07 mode — fallback path needs documenting).
- `buildDelegationTag(artistPubkey, conditions, signature)` — returns `["delegation", artistPubkey, conditions, signature]` ready to splice into an event's `tags`.

## Edge cases & invariants

| Risk | Mitigation |
|---|---|
| Artist revokes a delegation but the label has cached events still buffered locally | Server checks `artist_delegations.revoked_at IS NULL` on every publish. Label's UI auto-refetches on a "publish failed: delegation revoked" 403, marks the artist as un-publishable. |
| Delegation expiration | Conditions string includes `created_at<Y` — server checks event timestamp falls inside. Label UI shows expiry on the artist row; nudges to request renewal a week before. |
| Label tries to publish before the artist has ever granted | `/api/tracks/publish` returns 403 `no_delegation`. Label UI shows "Awaiting delegation" status and disables the publish button. |
| Other Nostr clients ignore NIP-26 delegation tag | Document the trust model: events SHOW as from the label on non-compliant clients. Equaliser's own client respects the tag. |
| Operator manages all artists — does delegation apply? | Operators can request delegations like labels. Without a delegation, an operator publishing on behalf of an unwilling artist would 403. Operators have permission to manage but not to forge identity. |
| Concurrent requests for same (label, artist) pair | DB unique index on `(artist_pubkey, label_pubkey)` in `artist_delegations`. `delegation_requests` allows multiples but UI surfaces only the most recent pending one. |
| Artist's nsec is held in NIP-07 extension that doesn't expose schnorrSign | Fallback: have artist export to a backup-file-based session for the signing step, or skip delegation. Document the limitation. |
| Per-event delegation verification cost | Schnorr verify is cheap (~ms). Cache verification result by event ID for the relay's hot-path (denorm). |

## Out of scope / deferred

- Custodial mode (label-derived NIP-06 keys). Schema columns left in place but unused.
- Multi-label simultaneous delegations (artist authorizes 2+ labels). Schema supports it (no constraint on artist), but UI treats it as 1:1 for v1.
- Delegation renewal automation (auto-extend if both parties opted in).
- A proper notification channel for delegation requests — v1 polls `/api/delegations/incoming` on page load.
- Delegated profile edits (Kind 0). Current scope is Kind 30050 (tracks) + Kind 5 (deletion). Extending to Kind 0 needs UX care (label editing artist's profile is more invasive than catalog).

## Critical files

| File | Change |
|---|---|
| `content_node/equaliser-relay/migrations/005_delegations.sql` | NEW — `artist_delegations` + `delegation_requests` |
| `content_node/equaliser-relay/internal/storage/delegations.go` | NEW — DelegationStore |
| `content_node/equaliser-relay/internal/api/api.go` | extend — 7 internal endpoints |
| `content_node/equaliser-relay/cmd/relay/main.go` | extend — wire DelegationStore |
| `content_node/equaliser-relay/internal/storage/denorm.go` | modify `parseTrack` to honour delegation tag |
| `content_node/orchestrator/api/services/relay_admin.py` | wrappers |
| `content_node/orchestrator/api/services/nip26.py` | NEW — verifier |
| `content_node/orchestrator/api/routers/delegations.py` | NEW — 6 public endpoints |
| `content_node/orchestrator/api/routers/tracks.py` | extend `/api/tracks/publish` to accept delegated events |
| `content_node/orchestrator/api/main.py` | mount router |
| `content_node/orchestrator/delegations.html` | NEW — artist's inbox |
| `content_node/orchestrator/artist-management.html` | extend — delegation status + Request modal |
| `content_node/orchestrator/releases.html` | modify publish flow for label-on-behalf-of-artist |
| `content_node/orchestrator/edit-release.html` | same |
| `content_node/orchestrator/redeem.html` | post-onboarding "grant your label" prompt |
| `common/js/session.js` | `signDelegation`, `buildDelegationTag` helpers |
| `common/js/admin-sidebar.js` | Delegations link for artists; status indicator for labels |

## Verification

End-to-end Playwright (using `packages/operators/equaliser-operator-backup-node-operator-*.json` for the operator + Shibuya's existing nsec):

1. **Label onboards.** Operator generates label invite. Magic Records redeems → role=label.
2. **Artist onboards.** Magic Records "Add Existing Artist" → roster invite → Shibuya redeems with their existing nsec → role=artist, managed_by=Magic.
3. **Label requests delegation.** As Magic Records, on `/admin/artist-management.html`, click "Request Delegation" on Shibuya's row. Modal: kinds=30050,5, duration=365 days, note="for catalogue management". Submit. Status changes to "Pending".
4. **Artist sees + grants.** As Shibuya, navigate to `/admin/delegations.html`. See request from Magic Records. Click Grant. Client constructs canonical condition string, signs with Shibuya's nsec, POSTs to `/api/delegations/{id}/grant`. Status flips to "Granted".
5. **Label uploads track.** As Magic Records, `/admin/upload.html`, target_artist_pubkey=Shibuya. Upload audio. Confirms draft created with artist_pubkey=Shibuya.
6. **Label publishes (the unblock).** As Magic Records, click Release on Shibuya's draft. Client fetches active delegation for (Shibuya, Magic), constructs Kind 30050 with delegation tag, signs with Magic's nsec, POSTs to `/api/tracks/publish`. Server verifies delegation. Track appears in relay tagged as Shibuya's catalogue.
7. **Track displays under Shibuya.** Visit Shibuya's artist page in client (`/artist?npub=...`). Track shows up as theirs (delegator, not signer). The "via NOSTR" badge / signer-info is shown subtly — "published by Magic Records (delegated)".
8. **Artist publishes social.** As Shibuya, on the client `/`, post a Kind 1. Signed with Shibuya's own nsec, no delegation involved. Confirms social path is unchanged.
9. **Revocation.** As Shibuya, `/admin/delegations.html`, click Revoke for Magic Records. As Magic, attempt to publish another track for Shibuya → 403 `no_delegation` → UI shows revoked status, disables button.
10. **Existing artist (no delegation).** Onboard a second artist (Swansea Sound) via Add Existing. Don't grant delegation. As Magic Records, attempt to publish for Swansea → 403, helpful error pointing to Request Delegation flow.
11. **Strict mode preserved.** Delegation flow doesn't bypass the no-role-on-node gate — fresh pubkey hitting any delegation endpoint without a `node_artists` row gets 403.

## Documentation

- `CLAUDE.md` — flip the "Label Multi-Artist Management" TODO to ✅ with summary; add "Phase F" or similar to the Node Management arc.
- `docs/NODE_MANAGEMENT_ARCHITECTURE.md` — new section "Label Delegation (NIP-26)" describing the lifecycle, trust model, and edge cases.
- `content_node/CLAUDE.md` — document `delegations.html`, the new endpoints, and the publish-flow changes.
- A short trust-model note for users: "your label can publish on your behalf only while a delegation you signed is active; you can revoke at any time".

---

# Phase G: Rights-per-Recording (Label as Publisher)

## Context

Phase F's NIP-26 delegation models the case of **an independent artist letting a manager help them publish** — the artist owns the recording, the label/manager just acts as a signing proxy. That's a real relationship, but it's not the *typical* record-label deal.

In a traditional label deal:
- The LABEL pays for the studio, hires the producer, owns the master recordings
- The LABEL is the publisher (and shows in catalogue listings under their identity)
- Fans pay the LABEL directly
- The label distributes royalties to the artist as a contractually-defined share

Further: a single artist's catalogue is often **fragmented across labels** — older albums on label A, newer on label B, "Taylor's Version" re-recordings on the artist's own label. Rights are per-recording, not per-artist.

Phase G introduces a parallel "signed" relationship type alongside Phase F's "managed". Together they cover both real-world flavours.

## Confirmed decisions

1. **Two relationship types coexist** — `node_artists.relationship_type ∈ {'signed', 'managed', 'self'}`. `'signed'` = label is publisher (this phase). `'managed'` = manager via Phase F delegation. `'self'` = independent artist with no label.
2. **`managed_by` = current label, soft hint.** It defines who's *expected* to publish new releases for the artist. Strict-mode publish gate: only the current `managed_by` can publish *new* tracks attributed to this artist. Previously-signed labels' existing tracks stay published forever — they're already signed and the relay accepts them.
3. **Performer tag**: `["p", artist_pubkey, "", "performer"]` (NIP-01 single-letter `p` tag with marker, following NIP-10 conventions). Encodes attribution. The relay's denorm parser routes Kind 30050 events with this tag to the performer's catalogue, regardless of who signed.
4. **Trust + reporting** for cross-label fraud. Equaliser doesn't crypto-enforce contracts. If a fraudulent label publishes performer-tagged tracks for an artist, the artist signs a Kind 5 deletion event for those track IDs (NIP-09), and the relay propagates the deletion. Off-platform legal disputes are the source of truth.
5. **Lightning recipient** is per-track. For 'signed' tracks: the label's `lud16` (from their Kind 0). For 'managed' tracks: the artist's `lud16`. (Royalty splits are deferred — see Out of Scope.)

## Build order

1. Schema migration `006_relationship_type.sql` — adds `node_artists.relationship_type` + `cached_tracks.label_pubkey`.
2. Relay `denorm.parseTrack` — read performer tag (NIP-10 marker), route attribution to performer pubkey, record signer in `cached_tracks.label_pubkey`.
3. Orchestrator `routers/tracks.publish` — accept label-signed events with performer tag if `ctx.can_manage(performer)` AND `node_artists[performer].managed_by == ctx.pubkey` (strict-mode guard).
4. Orchestrator `routers/label.add-existing-artist` — accept `relationship_type` parameter, persist on `node_artists`.
5. Orchestrator `routers/label.artists` (PATCH) — allow operator/label to update `relationship_type` for existing roster artists.
6. Frontend: `artist-management.html` — relationship picker on Add Existing Artist modal, relationship column with badge per row, "Cannot publish — strict mode" guard rail when label B is not the current `managed_by`.
7. Frontend: `releases.html` / `edit-release.html` — publish flow routes signing based on relationship_type ('signed' → label nsec + performer tag; 'managed' → existing Phase F delegation flow; 'self' → artist nsec direct).
8. Frontend: `redeem.html` — when redeeming a roster invite, surface the relationship type in the preview ("You'll be signed to Magic Records" vs "You'll be managed by Magic Records").
9. Client SPA: `artist.js` — switch query from `authors=[artist]` to `kinds=[30050]&#p=[artist]` (filter by performer tag). Display label name per release ("Tokyo Night — Sony Music").
10. Client SPA: optional new `label.html` page — `kinds=[30050]&authors=[label_pubkey]` for label catalogues.
11. Phase F UI rename: rename "Delegations" surface to "Manager Authorizations" (or similar) so the distinction from 'signed' relationships is clear in the operator/label/artist mental model.
12. Playwright end-to-end verification.
13. Documentation updates.

## Schema migration — `content_node/equaliser-relay/migrations/006_relationship_type.sql`

Additive only.

```sql
-- Phase G: rights-per-recording. Adds relationship_type to node_artists and label_pubkey
-- (the actual signer of a Kind 30050) to cached_tracks for the new performer-tag attribution.

ALTER TABLE node_artists
    ADD COLUMN IF NOT EXISTS relationship_type TEXT DEFAULT 'managed'
        CHECK (relationship_type IN ('self', 'managed', 'signed'));

-- Backfill existing rows: artists with managed_by NULL → 'self'; with managed_by → 'managed'
-- (preserves Phase F behaviour for already-onboarded artists).
UPDATE node_artists
SET relationship_type = CASE
    WHEN managed_by IS NULL THEN 'self'
    ELSE 'managed'
END
WHERE relationship_type IS NULL OR relationship_type = 'managed';

-- Track who signed a Kind 30050. For 'signed' tracks: event.pubkey = label_pubkey, performer
-- tag identifies artist. For 'managed'/'self' tracks: label_pubkey = NULL (event.pubkey IS the artist).
ALTER TABLE cached_tracks
    ADD COLUMN IF NOT EXISTS label_pubkey TEXT;

CREATE INDEX IF NOT EXISTS idx_cached_tracks_label
    ON cached_tracks(label_pubkey)
    WHERE label_pubkey IS NOT NULL;
```

The existing `cached_tracks.published_by` column from Phase F (delegation signer) and the new `label_pubkey` column from Phase G serve overlapping purposes. **Use `label_pubkey` going forward** as the single source of truth for "who signed this track". Migrate Phase F's denorm parser to populate `label_pubkey` instead of (or in addition to) `published_by`. Drop `published_by` in a later cleanup migration once we've confirmed nothing reads it.

## Relay backend — Go

**File: `content_node/equaliser-relay/internal/storage/denorm.go` — modify `parseTrack`**

Today the parser:
- Looks for `["delegation", artist, conditions, sig]` tag (Phase F); if valid, attributes to delegator.
- Otherwise attributes to `event.pubkey`.

Add a third branch:
- Look for `["p", artist_pubkey, "", "performer"]` tag (Phase G).
  - If present: `attributedPubkey = artist_pubkey`, `label_pubkey = event.pubkey`.
  - The performer tag's marker (4th element) is `"performer"` — this distinguishes from generic NIP-10 `["p", pubkey]` mention/reply tags.

Order of checks: delegation tag first (Phase F), then performer tag (Phase G), then fallback to `event.pubkey` (independent self-publish).

`findPerformerTag` helper mirrors `findDelegationTag`.

The INSERT into `cached_tracks` populates `label_pubkey` when either tag is present.

**No new internal endpoints.** The relay's existing event ingestion path picks up the new attribution automatically.

## Orchestrator backend — Python

**File: `content_node/orchestrator/api/routers/tracks.py` — extend `publish_track_event`**

Today it accepts:
- Self-publish: `event.pubkey == ctx.pubkey AND ctx.can_manage(event.pubkey)`.
- Delegation: `event.pubkey == ctx.pubkey` with valid delegation tag for the artist.

Add:
- Performer-tag publish: `event.pubkey == ctx.pubkey AND event` has a valid performer tag pointing to artist X AND `node_artists[X].managed_by == ctx.pubkey` (strict mode). Helper to extract performer tag mirrors `nip26.find_delegation_tag`.

`relay_admin.get_artist(performer_pubkey)` is called to verify the strict-mode managed_by gate. Cache once per request.

If the publish event has BOTH a delegation tag AND a performer tag: error 400. The two attribution mechanisms are mutually exclusive — the publish flow on the client picks one based on `relationship_type`.

**File: `content_node/orchestrator/api/services/nip26.py` (or new `attribution.py`)**

Add `find_performer_tag(event)` and `validate_performer_event(event, expected_signer, expected_performer)`. Pure functions, used by tracks.publish.

**File: `content_node/orchestrator/api/routers/label.py`**

- `add-existing-artist` accepts an additional `relationship_type` parameter ('signed' | 'managed', default 'managed' for backwards compat). Persists when the redemption creates the `node_artists` row.
- `artists` PATCH accepts `relationship_type` updates (operator can change; label can change for their own roster artists).
- The roster invite code carries `relationship_type` so when the artist redeems, the new `node_artists` row gets the correct value (extend the access_request schema or carry it in the invite code metadata — TBD; simplest is a new column on `access_requests`).

**File: `content_node/orchestrator/api/services/relay_admin.py`**

Wrappers updated for the new fields. New helper `relay_admin.get_artist_relationship(pubkey)` returns `{managed_by, relationship_type}` for the strict-mode check.

## Frontend

### `artist-management.html`

**Add Existing Artist modal** — adds a relationship type radio:

```
○ Signed — we have rights to their recordings. We publish, money flows to us.
⦿ Managed — they're independent. We help via NIP-26 delegation, money flows to them.
```

The choice writes through to the relay's invite-code generation. When the artist redeems, the `node_artists.relationship_type` is set accordingly.

**Roster table** — add a "Relationship" column (between Status and Fee Model):

| Value | Badge |
|---|---|
| `signed` | "Signed" purple badge |
| `managed` (with active delegation) | "Managed (active)" green badge |
| `managed` (no delegation) | "Managed (none)" yellow badge — clickable to "Request delegation" |
| `self` | "Independent" grey badge (rare on a roster) |

**Existing artists with no relationship_type** — backfilled to 'managed' via the migration. Edit modal allows label/operator to change the type later (e.g. after re-negotiation).

### `releases.html` and `edit-release.html`

Today the publish flow signs with `session.sign(unsigned_event)`. After Phase F that became `signTrackEvent(unsigned, artistPubkey, callerPubkey)` with delegation handling.

After Phase G, `signTrackEvent` consults the artist's relationship type:

```
relationship_type = await fetchRelationshipType(artistPubkey)

if relationship_type == 'signed' AND callerPubkey is current managed_by:
    // Label-rights publish
    rewrite event.pubkey = callerPubkey
    add tag ["p", artistPubkey, "", "performer"]
    sign with caller (label) nsec
elif relationship_type == 'managed':
    // Existing Phase F flow — fetch delegation, splice in delegation tag
    ...
elif artistPubkey == callerPubkey:
    // Self-publish
    sign as-is with artist nsec
else:
    error: cannot publish for this artist
```

The release flow on the page uses the relationship type fetched from `/api/label/artists/{pubkey}`. Cached for the page lifetime to avoid repeat round-trips.

### `redeem.html`

When previewing the invite code (the existing code-preview flow), surface the relationship type:

> This invite signs you to **Magic Records**. They will own the rights to recordings they publish for you, and fans will pay them directly. Royalty distribution is handled off-platform.

vs.

> This invite makes you a **managed artist** of Magic Records. They can publish on your behalf via signed delegations, but you keep ownership of your recordings and receive payments directly.

`/api/access/check-invite` already returns `target_role` and `target_managed_by`; extend it to also return `relationship_type` carried on the invite.

### Phase F UI rename

The Phase F surface for "Delegations" should be renamed to **"Manager Authorizations"** to clarify it's specific to the 'managed' relationship type. Files affected:

- `delegations.html` → consider rename to `manager-authorizations.html` (with redirect from old URL); page title changes
- `admin-sidebar.js` — sidebar item label: "Manager Authorizations" instead of "Delegations"
- `artist-management.html` — column heading: "Authorization" instead of "Delegation"
- Copy throughout — "delegation request" → "authorization request" where it's user-facing; internal API + DB schema names stay (those are NIP-26 vocabulary)

### Client SPA — `artist.js` and `artist.html`

**Discography query**:
- Old: `kinds=[30050]&authors=[artist_pubkey]&limit=100`
- New: `kinds=[30050]&'#p'=[artist_pubkey]&limit=100`

The `#p` filter matches any Kind 30050 with `["p", artist_pubkey, ...]` — that includes both performer-tagged tracks (signed mode) AND the existing self-published tracks (which add a self-`p` tag for consistency). Self-published tracks may need a `["p", artist_pubkey, "", "performer"]` tag added to their canonical event to be discoverable this way — that's a one-time migration of existing release events.

**Display per release**:

```
┌────────────────────────────────────┐
│  Tokyo Night                       │
│  Shibuya Crossings · 3:42          │
│  Sony Music                        │  ← from cached_tracks.label_pubkey → label.Kind 0 name
└────────────────────────────────────┘
```

The label name is fetched from the label's Kind 0 profile (existing artist-profile-fetch path). Falls back to short pubkey if no Kind 0 found.

### New page (optional in v1): `client/label.html`

Mirror of `artist.html` but for labels:
- Query: `kinds=[30050]&authors=[label_pubkey]&limit=100`
- Shows the label's full catalogue (every recording they own, across all artists they've signed)
- Each release is grouped by performer tag in the UI

## Strict-mode publish guard (UI)

When a label B (not current `managed_by`) tries to release a track tagged with an artist's pubkey, the orchestrator returns 403 `not_current_label`. The releases.html flow catches that and shows a clear modal:

> Shibuya Crossings is currently signed to Magic Records. Only their current label can publish new tracks attributed to them on this node.
>
> Tracks you previously published remain in your catalog — fans can still play them.

No retry button — the label needs an off-platform conversation with the artist + operator if they think the relationship has changed.

## Edge cases & invariants

| Risk | Mitigation |
|---|---|
| Artist switches labels (Magic → Sony) | Operator updates `node_artists.managed_by`. Old Magic-signed tracks remain in catalog (event.pubkey = Magic, performer = artist). New tracks must come from Sony. Strict-mode gate enforces. |
| Label A publishes a fraudulent track for an artist they don't manage | Orchestrator's strict-mode gate rejects on publish. If the track somehow lands (e.g. via a different relay), artist signs a Kind 5 deletion event for the offending event ID. NIP-09 deletion propagates. |
| `relationship_type` upgrade from 'managed' to 'signed' (or vice versa) | Existing tracks aren't retroactively re-attributed. New tracks honour the new type. The relationship type at publish time is what matters for that recording — it lives forever in the event. |
| Strict mode locks out a label that only published one historical track | They can still see/edit/delete their own historical tracks (they're the signer), but cannot publish NEW tracks. That's the intent. |
| Royalty splits are off-platform in v1 | Document the trust expectation. Future: a `["royalty", pubkey, "ratio"]` tag convention plus NIP-57 split zaps. |
| `published_by` (Phase F) vs `label_pubkey` (Phase G) overlap | Phase G migrates Phase F's denorm to populate `label_pubkey` consistently for both delegation-signed AND performer-tagged tracks. The signer is recorded the same way regardless of attribution mechanism. Drop `published_by` in a follow-up cleanup migration. |
| Existing artist tracks (pre-Phase G) without performer tags | One-shot migration: for every `cached_tracks` row where artist_pubkey == event.pubkey, mark them as 'self' attribution. The artist's own discography query (`#p=artist`) requires that the publish flow ALSO add a self-`p` tag for self-published tracks going forward — this is a small change to the unsigned-event template in `services/nostr.py`. |
| Label catalogue page bypassing performer attribution | Querying `authors=[label_pubkey]` shows ALL tracks the label signed — this is the label's true catalogue. Independent of performer tag. |

## Out of scope / deferred

- Automated royalty splits (NIP-57 zap splits or scheduled Lightning payouts).
- Per-track contract metadata (label-artist contract reference, dates, conditions).
- Label catalogue page on the client (`label.html`) — easy follow-up but not blocking Phase G.
- Multi-label simultaneous signing (artist on Sony for one album AND Republic for another at the SAME time, on the same node). Today: strict mode enforces single current label. Real-world is more nuanced (some artists are on multiple labels for different territories) — defer until concretely requested.
- Cleanup migration to drop `cached_tracks.published_by` in favour of `label_pubkey`.
- Relationship-type history (audit log of when an artist switched labels, by whom, why).

## Critical files

| File | Change |
|---|---|
| `content_node/equaliser-relay/migrations/006_relationship_type.sql` | NEW — relationship_type + label_pubkey + index |
| `content_node/equaliser-relay/internal/storage/denorm.go` | Extend `parseTrack` with performer-tag branch; populate `label_pubkey` consistently for both delegation and performer attribution |
| `content_node/orchestrator/api/services/nip26.py` (rename/extend to `attribution.py`?) | Add `find_performer_tag`, `validate_performer_event` |
| `content_node/orchestrator/api/routers/tracks.py` | Extend `/api/tracks/publish` with performer-tag branch + strict-mode `managed_by` check |
| `content_node/orchestrator/api/routers/label.py` | `add-existing-artist` accepts `relationship_type`; PATCH `artists/{pubkey}` allows updates |
| `content_node/orchestrator/api/services/relay_admin.py` | Wrappers updated; new `get_artist_relationship` |
| `content_node/orchestrator/access-requests/...` and `redeem.html` | Surface relationship_type in preview |
| `content_node/orchestrator/artist-management.html` | Relationship picker on Add Existing modal; relationship column on roster table |
| `content_node/orchestrator/releases.html`, `edit-release.html` | Publish flow router (signed / managed / self branches) |
| `common/js/admin-sidebar.js` | Rename "Delegations" → "Manager Authorizations" |
| `content_node/orchestrator/delegations.html` | (optional rename to `manager-authorizations.html`); copy update |
| `content_node/orchestrator/api/services/nostr.py` | When generating unsigned Kind 30050 templates, include a self-`p` tag for self-published tracks so they're discoverable via `#p` |
| `client/js/pages/artist.js` | Switch query from `authors` to `#p` filter |
| `client/artist.html` | Per-release label badge (read from cached_tracks.label_pubkey, resolve to Kind 0 name) |
| `client/label.html` (optional) | Label catalogue page |

## Verification

End-to-end Playwright test (extends Phase F test scenario):

1. Operator + label setup (Phase A + Phase F flow): Magic Records onboarded as label, Shibuya redeems roster invite with `relationship_type='signed'`.
2. As Magic Records: upload a track for Shibuya. Click Release. Confirm the published Kind 30050 has `event.pubkey = Magic_Records` AND `["p", Shibuya, "", "performer"]` tag.
3. Confirm `cached_tracks` row has `artist_pubkey = Shibuya`, `label_pubkey = Magic_Records`.
4. As an anonymous client visiting `/artist?npub=<Shibuya>`: track shows up with "Sony Music" / "Magic Records" attribution badge.
5. **Strict-mode test**: onboard a second label (Sony) with no relationship to Shibuya. As Sony, attempt to publish a track tagged with Shibuya as performer. Expect 403 `not_current_label`. UI shows the strict-mode dialog.
6. **Label switch**: operator updates Shibuya's `managed_by` to Sony. As Magic, attempt to publish — expect 403. As Sony, publish — succeeds. Confirm both Magic-historical and Sony-new tracks both show on Shibuya's `/artist` page.
7. **Mixed roster**: also onboard a 'managed' artist (Bedroom Producer) for Magic. Confirm both relationship types coexist in the roster table with correct badges. Phase F delegation flow still works for the managed artist; performer-tag flow works for the signed artist.
8. **Backwards compat**: confirm artists onboarded BEFORE Phase G show as `relationship_type = 'managed'` (or 'self' if no managed_by) and Phase F delegation continues to work for them unchanged.

## Documentation

- `CLAUDE.md` — flip "Label Multi-Artist Management" TODO entry. Add a Phase G summary capturing the rights-per-recording model.
- `docs/NODE_MANAGEMENT_ARCHITECTURE.md` — extend the Phase F section with a Phase G subsection describing the dual-relationship model + performer tag + strict-mode publish gate.
- `content_node/CLAUDE.md` — document the new tracks.publish performer-tag branch + the strict-mode `managed_by` check.
- `docs/live_pages/` — re-capture screenshots for the artist-onboarding + roster flows (the relationship picker is a UX-visible change). Also add a new `signed-vs-managed.html` walkthrough showing both relationship types side-by-side.
- A short user-facing trust-model note: "Equaliser doesn't crypto-enforce label contracts. If a label publishes content that violates your contract, sign a Kind 5 deletion or contact your operator."
