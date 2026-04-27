# Plan: Access Control (Phase A)

## Context

Phases B–E built role-aware backend permissions, sidebar, label admin pages, and operator admin pages. Labels and operators can already generate invite codes via [invite-codes.html](content_node/orchestrator/invite-codes.html) and approve access requests via [access-requests.html](content_node/orchestrator/access-requests.html). **None of those codes can be redeemed yet** — there is no consumer, no public application form, and no code path inserts into `node_artists`. Onboarding remains permissionless: anyone with the URL `/admin/onboarding.html` can self-onboard with no record on the node.

Closing this loop completes "Access Control" — the original gated-onboarding mechanism in [NODE-MANAGEMENT-SPEC.md](docs/NODE-MANAGEMENT-SPEC.md). Outcome: a strict, code-gated path from "stranger applies via /join" → "label/operator approves" → "applicant uses code at /admin/onboarding.html (or /admin/redeem.html if already has nsec) → `node_artists` row created with the right `role` and `managed_by`". Plus a label-side flow to invite *existing* artists onto a roster (consent-based via shareable code), and operator-side ability to issue label-role invites.

This phase also addresses an unrelated UX irritation: the dual login experience. Today [`content_node/orchestrator/login.html`](content_node/orchestrator/login.html) and [`client/login.html`](client/login.html) are separate sessionStorage scopes — and worse, [`content_node/orchestrator/js/session.js`](content_node/orchestrator/js/session.js) (641 lines, role-aware after Phase C) and [`client/js/session.js`](client/js/session.js) (462 lines, no role awareness) have diverged. We consolidate to one shared file in a new top-level `common/` directory (sibling of `client/`, `content_node/`, `tools/`, `docs/`), mounted at `/common/js/session.js` so the same nsec carries across surfaces fluidly and so the file *cannot* drift again.

## Confirmed decisions

1. **SessionManager** — consolidate to one shared file (filesystem-enforced via nginx mount).
2. **Onboarding** — STRICT. New pubkeys cannot get a `node_artists` row without a valid invite code. Existing pubkeys can still log in to admin, but if they have neither a `node_artists` nor `node_operators` row they're redirected to a redeem page.
3. **Add existing artist** — label generates a roster invite code (`target_managed_by` = label's pubkey) → shares out-of-band → artist redeems via `/admin/redeem.html`.
4. **Operator-issued label and operator invites** — operators choose `target_role` ∈ {artist, label, operator} when generating codes. Labels can only issue artist-role codes. On redeem, `target_role='operator'` inserts into `node_operators` (not `node_artists`), letting a node have multiple operators without server-side env edits.
5. **First-run setup (setup token)** — on a fresh deploy with zero operators, the relay generates a one-time setup token at boot, logs it loudly to stdout, AND writes it to `/data/setup-token.txt` (visible to anyone with shell access to the host). A visitor at `/admin/` is redirected to `/admin/setup.html` where they paste the token and sign in with their nsec/extension to claim themselves as the first operator. Token rotates on every boot until claimed; cleared once an operator exists. Replaces the awkward `OPERATOR_PUBKEYS` env-edit-and-restart dance — though `OPERATOR_PUBKEYS` is preserved as a headless/automated fallback.
6. **Backup file recovery** — at first-operator setup AND every operator-invite redeem AND every artist invite redeem, force a "Save your backup" step that downloads `equaliser-operator-backup-*.json` (same format as the existing artist backup file). Restoring is the existing backup-file-login flow at `/admin/login.html`. Email-based recovery is **deferred** to a follow-up phase (see Deferred section).

## Build order

Each step is testable on its own; later steps depend on earlier ones being deployed.

1. Schema migration `004_access_control.sql`.
2. Relay `AdminStore` + setup-token storage extensions + new internal API endpoints (including operator claim).
3. Orchestrator `relay_admin.py` wrappers + new `routers/access.py` (request/check-invite/redeem/claim-operator/setup-status) + `label.py` updates.
4. Shared SessionManager move + nginx mount + HTML reference updates.
5. Frontend pages: `setup.html` (first-run), `client/join.html`, `redeem.html`, then modify `onboarding.html` / `login.html` / `artist-management.html` / `invite-codes.html`. Add backup-file download step to onboarding, redeem, and setup flows.
6. **Remove the fallback** in [`dependencies.py:86-89`](content_node/orchestrator/api/dependencies.py#L86-L89) — this is what flips the system to strict mode. Do this **last**, after every UI surface knows to redirect un-rowed pubkeys, so we don't lock anyone out mid-deploy.
7. Add role awareness to the (now-shared) `SessionManager` for the client surface and add the cross-surface "Manage"/"Listener" links.
8. Playwright end-to-end verification.
9. Documentation updates.

## Schema migration — `content_node/equaliser-relay/migrations/004_access_control.sql`

Additive only. Existing rows get NULL/defaults — no data migration.

```sql
ALTER TABLE access_requests
  ADD COLUMN IF NOT EXISTS requested_role TEXT DEFAULT 'artist',
  ADD COLUMN IF NOT EXISTS target_role TEXT DEFAULT 'artist',
  ADD COLUMN IF NOT EXISTS target_managed_by TEXT,
  ADD COLUMN IF NOT EXISTS issued_by TEXT;

CREATE INDEX IF NOT EXISTS idx_access_requests_invite_code
  ON access_requests(invite_code) WHERE invite_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS setup_state (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  setup_token TEXT,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  claimed_at TIMESTAMPTZ
);
INSERT INTO setup_state (id) VALUES (1) ON CONFLICT DO NOTHING;
```

## First-run setup token mechanism

Goal: a fresh node deploy should be claimable by the first visitor with shell access to the host (for log/file access) — no env editing, no container restart.

**Relay startup behavior** (`cmd/relay/main.go`):
1. After migrations + `BootstrapOperators(OPERATOR_PUBKEYS)` run, count rows in `node_operators`.
2. If count == 0, generate a 32-byte hex setup token, persist it to `/data/setup-token.txt` (mode 0600), AND log a banner to stdout:
   ```
   ============================================================
    NO OPERATOR CONFIGURED. To claim this node:
      1. Visit /admin/setup.html in your browser
      2. Enter setup token: <token>
      3. Sign in with your nsec or extension
    Token is also at /data/setup-token.txt inside the relay container.
   ============================================================
   ```
3. If count > 0, ensure no setup-token file exists (delete if stale).
4. Token rotates on every boot when count is still 0 (so an unclaimed node doesn't have a permanent shared secret if it's restarted).
5. After successful claim: token is deleted and the banner is not re-printed unless the operator count drops to 0 again.

**Relay storage** (`internal/storage/admin.go`):
- New `SetupToken` struct + methods `GenerateSetupToken(ctx) (string, error)`, `GetSetupToken(ctx) (string, error)`, `ClearSetupToken(ctx) error`. Token stored in a new `setup_state` table (single-row keyed by `id=1`) so it survives container restart for in-flight setup attempts.
- New `ClaimFirstOperator(ctx, token, pubkey, name) error` — single transaction:
  ```sql
  BEGIN;
  -- locks setup_state row, reads token
  SELECT setup_token FROM setup_state WHERE id=1 FOR UPDATE;
  -- abort if token != provided OR if EXISTS (SELECT 1 FROM node_operators)
  INSERT INTO node_operators (pubkey, name) VALUES ($pubkey, $name);
  UPDATE setup_state SET setup_token = NULL, claimed_at = NOW() WHERE id=1;
  COMMIT;
  ```

**Relay schema** (in `004_access_control.sql`):
```sql
CREATE TABLE IF NOT EXISTS setup_state (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  setup_token TEXT,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  claimed_at TIMESTAMPTZ
);
INSERT INTO setup_state (id) VALUES (1) ON CONFLICT DO NOTHING;
```

**Relay endpoints** (`internal/api/api.go`):
- `GET /api/internal/setup-status` → `{needs_setup: bool}` based on operator count == 0 AND setup_token exists.
- `POST /api/internal/operators/claim` body `{token, pubkey, name}` → calls `ClaimFirstOperator`.

**Orchestrator endpoints** (`routers/access.py`):
- `GET /api/access/setup-status` (no auth) — proxies to relay's setup-status. Used by `login.html` and `dashboard.html` to detect "needs setup" and redirect.
- `POST /api/access/claim-operator` (NIP-98 auth) — body `{token, name}`. Verifies pubkey via NIP-98, calls relay's claim. Returns the created operator row.

## Relay backend — Go

**File: [`content_node/equaliser-relay/internal/storage/admin.go`](content_node/equaliser-relay/internal/storage/admin.go)**

- Extend `AccessRequest` struct: `TargetRole`, `TargetManagedBy *string`, `IssuedBy *string`.
- New `GetInviteCode(ctx, code) (*AccessRequest, error)` — returns code metadata for the public check-invite endpoint.
- New `RedeemInviteCode(ctx, code, pubkey, displayName) (*RedeemResult, error)` — **single transaction** with row-level locking. Branches on `target_role`:

  Common preamble for all roles:
  ```sql
  BEGIN;
  SELECT id, target_role, target_managed_by, status, invite_used
    FROM access_requests WHERE invite_code = $1 FOR UPDATE;
  -- validate status='approved' AND NOT invite_used
  UPDATE access_requests
    SET invite_used = TRUE, reviewed_at = COALESCE(reviewed_at, NOW())
    WHERE id = $id AND invite_used = FALSE;
  -- if rows_affected != 1: concurrent redeem won, abort with 409
  ```

  Then branch on `target_role`:
  ```sql
  -- target_role IN ('artist', 'label'):
  INSERT INTO node_artists (pubkey, artist_name, request_id, role, managed_by, status)
    VALUES ($pubkey, $name, $id, $role, $managed_by, 'active')
    ON CONFLICT (pubkey) DO UPDATE
      SET managed_by = COALESCE(node_artists.managed_by, EXCLUDED.managed_by),
          role = CASE
            WHEN node_artists.role = 'artist' AND EXCLUDED.role = 'label' THEN 'label'
            ELSE node_artists.role  -- never downgrade
          END
    WHERE node_artists.managed_by IS NULL OR node_artists.managed_by = EXCLUDED.managed_by;

  -- target_role = 'operator':
  INSERT INTO node_operators (pubkey, name)
    VALUES ($pubkey, $name)
    ON CONFLICT (pubkey) DO NOTHING;
  -- operators are additive — no managed_by, no demotion, no role conflict.
  -- node_artists row (if any) is left alone; operator status is checked first by ResolveRole.

  COMMIT;
  ```
  Returns 409 with structured `{error: "already_managed_by_other"}` if pre-existing `node_artists` row has a different `managed_by`. Operator branch never returns 409 — `ON CONFLICT DO NOTHING` is idempotent.
- Update `CreateOrphanInviteCode(ctx, role, managedBy, issuedBy)` signature — three new params with defaults `'artist'`/`nil`/`nil`.
- Update `ApproveAccessRequest(ctx, id, adminNotes, issuedBy)` — record caller pubkey.
- Wrap `INSERT` of code generation in retry-on-collision (`ON CONFLICT (invite_code) DO NOTHING RETURNING`, retry up to 3x).

**File: [`content_node/equaliser-relay/internal/api/api.go`](content_node/equaliser-relay/internal/api/api.go)**

- New `POST /api/internal/invite-codes/redeem` — body `{code, pubkey, artist_name}`, returns the created `NodeArtist`.
- New `GET /api/internal/invite-codes/{code}` — returns code metadata (target_role, target_managed_by, issuer name) for client preview before commitment. 404 if invalid/used.
- Update existing `POST /api/internal/invite-codes` (orphan create) to read `target_role`, `target_managed_by`, `issued_by` from body.
- Update `POST /api/internal/access-requests/{id}/approve` to read `issued_by` from body.

## Orchestrator backend — Python

**File: [`content_node/orchestrator/api/services/relay_admin.py`](content_node/orchestrator/api/services/relay_admin.py)**

Three new wrappers: `redeem_invite_code(code, pubkey, artist_name)`, `get_invite_code(code)`, and update `create_invite_code(target_role, target_managed_by, issued_by)`, `approve_access_request(... issued_by)`.

**File: [`content_node/orchestrator/api/routers/access.py`](content_node/orchestrator/api/routers/access.py) — NEW**

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/api/access/request` | none | Public — creates an `access_requests` row. Body: `{requested_role, artist_name, email, npub, description, links}`. `requested_role` ∈ {artist, label}; default `artist`; `operator` rejected (cannot be self-applied). Returns `{id, status: "pending"}`. |
| GET | `/api/access/check-invite?code=...` | none | Public — returns `{valid, target_role, target_managed_by, issuer_name}` or 404. Used by `/admin/redeem.html` and `/admin/onboarding.html` Step 0 to preview before committing. |
| POST | `/api/access/redeem` | NIP-98 | Body: `{code, artist_name}`. Validates pubkey via NIP-98, calls relay's redeem. Returns the created `NodeArtist`. |
| GET | `/api/access/setup-status` | none | Returns `{needs_setup: bool}`. Used by login/dashboard to redirect to setup.html on a fresh node. |
| POST | `/api/access/claim-operator` | NIP-98 | Body: `{token, name}`. Verifies pubkey via NIP-98, calls relay's claim. Returns the created operator row. |

**File: [`content_node/orchestrator/api/routers/label.py`](content_node/orchestrator/api/routers/label.py)**

- New `POST /api/label/add-existing-artist` (label/operator role) — body `{artist_name, npub?}`. Generates a roster invite code with `target_managed_by` = caller's pubkey, `target_role` = `'artist'`. Returns the code. Server enforces that label callers can never set `target_managed_by` to anything other than their own pubkey.
- Update `POST /api/label/invite-codes` — accept optional `target_role` and `target_managed_by`. Operator-only constraint: `target_role ∈ {'label', 'operator'}` rejected for non-operator callers (403). Operator codes never carry `target_managed_by` — server strips it if present.
- Update `POST /api/label/access-requests/{id}/approve` to forward `issued_by` = caller's pubkey to the relay.

**File: [`content_node/orchestrator/api/dependencies.py`](content_node/orchestrator/api/dependencies.py)**

- **Remove fallback** at lines 86–89. Replace with: if `_resolve_role` returns None → raise `HTTPException(403, detail={"reason": "no_role_on_node", "redirect": "/admin/redeem.html"})`. This is what makes the gate strict.

**File: [`content_node/orchestrator/api/main.py`](content_node/orchestrator/api/main.py)**

- Mount `access` router at `/api/access`.
- Add `server_time` (Unix ms) to `/api/health` so clients with clock skew can self-correct on NIP-98 401s.

## SessionManager consolidation

Pick **shared mount via nginx** (filesystem-enforced, can't drift). New top-level `common/` directory at the repo root, sibling of `client/` and `content_node/` — signals that this code belongs to neither surface and is shared:

- **NEW**: `common/js/session.js` — canonical, merged from both files. Admin-specific behaviors (e.g. role fetching) keyed on a `window.EQ_SURFACE = 'admin'` flag set by a one-line `<script>` in admin pages (client pages omit it; default is listener mode).
- **NEW**: `common/js/admin-sidebar.js` — moved from orchestrator (admin-only, but lives next to session.js for symmetry).
- **MODIFIED**: [`content_node/web/nginx.conf`](content_node/web/nginx.conf) — add `location ^~ /common/ { alias /usr/share/nginx/html/common/; }`.
- **MODIFIED**: [`content_node/docker-compose.yml`](content_node/docker-compose.yml) — `web` service mounts `../common:/usr/share/nginx/html/common:ro` (relative path matches the existing `../client:/usr/share/nginx/html/client:ro` pattern).
- **MODIFIED**: every HTML file in `content_node/orchestrator/*.html` and `client/*.html` — change `<script src="js/session.js">` → `<script src="/common/js/session.js">` (and same for admin-sidebar.js where present).
- **DELETE**: `content_node/orchestrator/js/session.js`, `content_node/orchestrator/js/admin-sidebar.js`, `client/js/session.js`.

## Frontend pages

**NEW pages**

- **`client/join.html`** — public application form. Fields: requested_role (radio: artist | label, default artist), artist_name/label_name (required), email (required), npub (optional), description, links. POSTs to `/api/access/request` with `requested_role`. Success message: "Application received — you'll get a notification when it's reviewed". No auth. Form copy adapts to selected role ("Tell us about your label" vs "Tell us about your music" etc.).
- **`content_node/orchestrator/redeem.html`** — post-login page for an existing-pubkey user to enter an invite code. Calls `GET /api/access/check-invite?code=...` to preview, then `POST /api/access/redeem` (NIP-98). On success → forces backup-file download step → redirects to `/admin/dashboard.html`. Used by: (a) listener-becomes-artist, (b) artist-joins-label-roster, (c) operator-invite redemption.
- **`content_node/orchestrator/setup.html`** — first-run claim page. Visible when `GET /api/access/setup-status` returns `needs_setup: true`. Form: setup token + nsec/extension login. On submit calls `POST /api/access/claim-operator`. On success: forces backup-file download (this is the operator's only recovery mechanism in v1) → redirects to `/admin/dashboard.html`. Page also shows "How to find your token" instructions (cat /data/setup-token.txt or scroll the relay's startup logs).

**MODIFIED pages**

- **[`content_node/orchestrator/onboarding.html`](content_node/orchestrator/onboarding.html)** — add Step 0: invite code entry. Accept `?invite=<code>` URL param to skip prompt. Validate via check-invite endpoint, show issuer + target role to the user before they commit. After Kind 0 publish, call `/api/access/redeem`, then force a backup-file download step before the success screen. **Reject onboarding entirely if no valid code** — strict mode.
- **[`content_node/orchestrator/login.html`](content_node/orchestrator/login.html)** — on page load, call `GET /api/access/setup-status`; if `needs_setup` → redirect to `/admin/setup.html`. After login, call `GET /api/auth/whoami`. If 403 with `reason: "no_role_on_node"` → redirect to `/admin/redeem.html?return=<original>`. Otherwise proceed to `returnUrl`. The existing backup-file login path is unchanged — same UI used by both artists and operators for restore.
- **[`content_node/orchestrator/artist-management.html`](content_node/orchestrator/artist-management.html)** — add "Add Existing Artist" button beside Refresh. Modal: artist_name + npub (optional). Submits to `POST /api/label/add-existing-artist`. Success modal displays the generated invite code with copy button.
- **[`content_node/orchestrator/invite-codes.html`](content_node/orchestrator/invite-codes.html)** — operator-only role selector on "Generate New" button (radio: artist | label | operator). Show `target_role` column in the table. Codes that grant label or operator role get a distinct badge. The operator option carries a confirmation dialog ("This grants full node access — confirm?").
- **[`content_node/orchestrator/access-requests.html`](content_node/orchestrator/access-requests.html)** — surface `requested_role`, `target_role`, `target_managed_by`, `issued_by` on cards. Show a "Requested as: {role}" badge per card. Approve modal pre-selects `target_role = requested_role` but lets the approver override (e.g. label applies but operator approves them as artist with a managed_by override). Modal previews "will become {target_role} managed by {label_name or 'unmanaged'}".

## Cross-surface UX — client gets role awareness

After SessionManager consolidation, the canonical `session.js` already has `fetchRole()` (Phase C). Client surface gains it for free.

- **`client/index.html`** (or wherever the main shell renders) — after login, call `SessionManager.fetchRole()`. If `getRole() ∈ {'artist', 'label', 'operator'}` → show a "Manage" link in the header pointing to `/admin/dashboard.html`. Wrap in try/catch — listener-only users (who get 403 on whoami after we remove the fallback) silently skip the link, no console noise.
- **`common/js/admin-sidebar.js`** — add a "Listener view" item in the bottom nav section pointing to `/`.

## Edge cases & invariants

| Risk | Mitigation |
|------|------------|
| Concurrent redeem of same code | Atomic SQL transaction with `FOR UPDATE` + `WHERE invite_used = FALSE`; loser gets 409. |
| Pubkey already has `node_artists` row, redeems compatible code | `ON CONFLICT DO UPDATE` only when existing `managed_by IS NULL` or matches; role only upgraded artist→label. |
| Pubkey already has row with conflicting `managed_by` | 409 `already_managed_by_other` — operator must resolve manually. |
| Strict mode locks out an existing operator with no `node_artists` row | `_resolve_role` checks `node_operators` first; operators always pass. |
| Brand-new node bootstrap (nobody can issue codes, nobody can self-onboard) | Setup-token first-run flow (Decision #5). `OPERATOR_PUBKEYS` env var remains as a headless/automated fallback. Both paths documented in `content_node/CLAUDE.md` setup notes. |
| Code intercepted via MITM and used with attacker's pubkey | NIP-98 `payload` tag must include the request body hash — verify in `services/nip98.py`. Codes are bearer secrets by design; document the trust model. |
| Label sets `target_managed_by` to a different label's pubkey | Server-side check in `routers/label.py`: non-operator callers can only issue codes where `target_managed_by == ctx.pubkey`. |
| Code generation collision | `INSERT ... ON CONFLICT (invite_code) DO NOTHING RETURNING`, retry up to 3x. |
| Operator-invite redeemed by pubkey that's already an operator | `INSERT INTO node_operators ... ON CONFLICT DO NOTHING` — silently no-op, redeem still marks the code used. Show "you're already an operator" message client-side. |
| Operator demotion | Out of scope — manual `DELETE FROM node_operators` via psql. Adding a self-revoke or peer-revoke UI is a follow-up. |
| Last operator removes themselves | Not enforced at DB level. If you delete the last operator (e.g. via psql), the next relay restart with no `OPERATOR_PUBKEYS` will re-enter setup-token mode — visit `/admin/setup.html` to re-claim. |
| Setup token leaked between boot and claim | Token rotates each boot until claimed; ageing setup-token files should be considered compromised. If you suspect leak before claim, restart the relay to rotate. The `setup-token.txt` file is mode 0600 and inside the container — only host-shell-access leaks the token. |
| Setup-token race (two visitors with the token at the same time) | `ClaimFirstOperator` uses `FOR UPDATE` on the setup_state row + checks `EXISTS (SELECT 1 FROM node_operators)` inside the transaction. Loser gets 409. |
| User loses both nsec AND backup file | No recovery in v1. Only paths: (a) another operator promotes them via fresh invite, (b) shell access + psql, (c) restart with `OPERATOR_PUBKEYS` env (which re-runs `BootstrapOperators` if the listed pubkey isn't already an operator). Document loudly in setup docs. Email recovery is the planned remedy — see Deferred. |
| Backup file save step skipped or interrupted | Make the download an explicit "Continue" gate — user must click "I've saved my backup" before proceeding to dashboard. Don't insert any DB row for the operator until backup has been triggered (so an interrupted setup doesn't leave a half-onboarded operator). |
| NIP-98 clock skew on redeem (we've seen this on `/api/drafts`) | `/api/health` exposes `server_time`; client computes offset and re-signs once on `detail="NIP-98 event expired"`. Don't widen `MAX_EVENT_AGE` — preserves replay protection elsewhere. |
| Listener-becomes-artist needs `user-type: artist` Kind 0 republish | Out of scope for v1 — note in deferred section. |

## Out of scope / deferred

- Listener-becomes-artist auto-republish of Kind 0 with `user-type: artist`.
- Email notifications on application approval/decline.
- **Email-based recovery for lost-key operators/artists.** Add `recovery_email` column to `node_operators` and `node_artists`, captured at setup/redeem time. New `/admin/recover.html`: enter email → if SMTP configured and email matches, send 6-digit one-time code → user uploads new nsec/extension to take over the row. Throttled to prevent enumeration. Requires SMTP service in compose stack (mailhog for dev, real SMTP for prod). The v1 backup-file-only mechanism leaves a recovery gap when both nsec AND backup are lost — this closes it.
- Captcha or rate-limiting on `/join` (defer until abuse observed).
- Invite code TTL / expiration.
- Setup token TTL (currently lives until claimed or relay restart — could expire after N hours of unclaimed life).
- Pubkey-bound codes (`target_npub`).
- Label setting `fee_model` at code-issuance time (defer; label edits via `artist-management.html` post-redeem).
- Audit log beyond `node_artists.onboarded_at` + `request_id` link.
- Operator UI to revoke pending invites.
- Operator demotion / self-revoke UI (today: manual psql `DELETE FROM node_operators`).
- "Operators" list view (read-only roster of who has root access on the node). Useful sibling to revoke UI.

## Critical files

| File | Change |
|------|--------|
| [`content_node/equaliser-relay/migrations/004_access_control.sql`](content_node/equaliser-relay/migrations/004_access_control.sql) | NEW — schema additions (incl. `setup_state`) |
| [`content_node/equaliser-relay/cmd/relay/main.go`](content_node/equaliser-relay/cmd/relay/main.go) | First-run setup-token generation + log banner + `/data/setup-token.txt` write |
| [`content_node/equaliser-relay/internal/storage/admin.go`](content_node/equaliser-relay/internal/storage/admin.go) | `RedeemInviteCode`, `GetInviteCode`, `GenerateSetupToken`/`GetSetupToken`/`ClearSetupToken`, `ClaimFirstOperator`, signature updates |
| [`content_node/equaliser-relay/internal/api/api.go`](content_node/equaliser-relay/internal/api/api.go) | 4 new handlers (redeem, get-invite, setup-status, claim-operator) |
| [`content_node/orchestrator/api/dependencies.py`](content_node/orchestrator/api/dependencies.py) | Remove fallback (lines 86-89) — flips to strict mode |
| [`content_node/orchestrator/api/routers/access.py`](content_node/orchestrator/api/routers/access.py) | NEW router |
| [`content_node/orchestrator/api/routers/label.py`](content_node/orchestrator/api/routers/label.py) | `add-existing-artist`, role gates on invite-codes POST |
| [`content_node/orchestrator/api/services/relay_admin.py`](content_node/orchestrator/api/services/relay_admin.py) | Wrappers for new relay endpoints |
| [`content_node/orchestrator/api/services/nip98.py`](content_node/orchestrator/api/services/nip98.py) | Verify body hash payload tag is enforced for POSTs |
| [`content_node/orchestrator/api/main.py`](content_node/orchestrator/api/main.py) | Mount access router; add server_time to /api/health |
| `common/js/session.js` | NEW — canonical merged file (top-level shared dir) |
| `common/js/admin-sidebar.js` | NEW — moved from orchestrator |
| [`content_node/web/nginx.conf`](content_node/web/nginx.conf) | New `/common/` location |
| [`content_node/docker-compose.yml`](content_node/docker-compose.yml) | New `../common` mount on web service |
| `client/join.html` | NEW |
| `content_node/orchestrator/redeem.html` | NEW (with mandatory backup-file step) |
| `content_node/orchestrator/setup.html` | NEW — first-run operator claim + mandatory backup-file step |
| [`content_node/orchestrator/onboarding.html`](content_node/orchestrator/onboarding.html) | Step 0 + redeem call |
| [`content_node/orchestrator/login.html`](content_node/orchestrator/login.html) | Branch on `no_role_on_node` 403 |
| [`content_node/orchestrator/artist-management.html`](content_node/orchestrator/artist-management.html) | Add Existing Artist modal |
| [`content_node/orchestrator/invite-codes.html`](content_node/orchestrator/invite-codes.html) | Role selector |
| [`content_node/orchestrator/access-requests.html`](content_node/orchestrator/access-requests.html) | Surface target_* fields on cards & approve modal |
| All `content_node/orchestrator/*.html` and `client/*.html` | `<script src="js/session.js">` → `<script src="/common/js/session.js">` |

## Verification

End-to-end Playwright test (run as both label and operator):

0. **Fresh deploy / setup token**: `docker compose down -v && up`. Confirm setup token printed in `equaliser-relay` startup logs and present at `/data/setup-token.txt`. Visit `/admin/login.html` → redirected to `/admin/setup.html`. Generate a fresh keypair in-page, paste token, submit. Confirm `node_operators` row created, backup-file download triggered, redirect to dashboard. Restart relay; confirm token is gone (no banner re-printed). Visit `/admin/setup.html` again → confirm 404 / "already claimed" message.
1. **Bootstrap (alternate path)**: with `node_operators` already populated, set `OPERATOR_PUBKEYS` to add a second known nsec, restart relay, log in as that operator. Confirm `BootstrapOperators` is idempotent.
2. **Public join**: anonymous browser hits `/join`, submits form. Confirm row appears in `access_requests` with `status='pending'`.
3. **Approve**: operator visits `/admin/access-requests.html`, approves the request with admin notes. Confirm modal shows the generated invite code; row in DB has `invite_used=false`, `issued_by`=operator pubkey.
4. **Strict gate**: open a fresh tab, generate a new keypair, hit `/admin/login.html`. Confirm redirect to `/admin/redeem.html` with `?return=...`.
5. **Redeem**: paste code, click redeem. Confirm `node_artists` row created with `role='artist'`, redirect to dashboard, dashboard loads.
6. **Concurrent redeem**: two browser sessions, same code, race the click. One succeeds, other gets 409.
7. **Add existing artist**: log in as label, visit `/admin/artist-management.html`, click "Add Existing Artist", supply name + npub. Confirm code shown. In a new browser, redeem with that artist's nsec. Confirm `node_artists.managed_by` = label pubkey.
8. **Operator issues label invite**: operator on `/admin/invite-codes.html`, "Generate New" with role=label. New nsec redeems → `node_artists.role='label'`.
8b. **Operator issues operator invite**: operator clicks "Generate New" with role=operator (after confirmation dialog). New nsec redeems → row in `node_operators`. The new operator can immediately access all admin pages and issue further invites. Verify a label caller cannot generate operator codes (403).
9. **Cross-surface nav**: log in to `/admin/` as artist, navigate to `/` in same tab. Confirm session preserved (shared SessionManager). "Manage" link visible. Reverse: from `/` navigate to `/admin/dashboard.html` — still authenticated.
10. **Strict mode boundary**: confirm fresh-pubkey hit on `/api/drafts` returns 403 `no_role_on_node` (not 200 with empty results).
11. **Backup-file recovery**: log in as the freshly-claimed operator from step 0, download the backup file. Log out, clear sessionStorage. At `/admin/login.html` use the "Restore from backup file" path with the saved JSON. Confirm session restored, dashboard loads with operator role.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — flip the "Access Control (Phase A)" TODO to done with summary.
- [`docs/NODE_MANAGEMENT_ARCHITECTURE.md`](docs/NODE_MANAGEMENT_ARCHITECTURE.md) — new section "Access Control" describing the redemption lifecycle, the strict-gate boundary, and the SessionManager consolidation.
- [`content_node/CLAUDE.md`](content_node/CLAUDE.md) — document the new top-level `common/` directory convention, the new HTML pages, the new endpoints (`/api/access/*`, `/api/label/add-existing-artist`), the **first-run setup flow** (visit `/admin/setup.html` after `docker compose up`, find token in relay logs or at `/data/setup-token.txt`), and `OPERATOR_PUBKEYS` as the headless/automated alternative. Also document the mandatory backup-file save step and the recovery story (backup-file restore via existing login path; email recovery deferred).
- [`CLAUDE.md`](CLAUDE.md) — add `common/` to the codebase structure table so it's visible at a glance.