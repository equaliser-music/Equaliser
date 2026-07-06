# Artist + Label onboarding — fix list

Captured during manual UAT in Brave (operator) + Safari (label/artist) on a freshly reset local node, May 2026. After Phase G + post-redeem profile-setup shipped, walking through the operator + label + artist onboarding flows surfaced the following issues.

**Status:**
- 2026-05-28: fixes 1–6, 9 shipped + smoke-verified (5/5 Playwright checks). Fix 10 audited; gaps documented inline.
- 2026-05-29: fixes 7 + 8 shipped + smoke-verified (2/2 Playwright checks). onboarding.html is now a thin shim that hands off to redeem.html → profile-setup.html. setup.html routes operators through profile-setup with an operator-only "Skip for now" link.
- 2026-06-03: fix 10 sub-fixes a + b + c + d + e + h shipped + smoke-verified (4/4 Playwright checks).
- 2026-06-06: fix 10 sub-fixes f + g shipped + smoke-verified (4/4 Playwright checks). Per-row Upload button on artist-management.html sets the selected artist and navigates to upload.html; releases.html surfaces a proactive "No active Manager Authorization" banner with a deep-link when the user is acting as a managed artist without an active NIP-26 delegation.
- 2026-06-06: fix 11 shipped + smoke-verified (6/6 Playwright checks). The four `/api/label/access-requests/*` endpoints are now gated by `require_operator`; access-requests.html shows labels a "use the Artists page → Add Existing Artist" notice; the Access Requests sidebar link is hidden for labels.

Outstanding: 12 (label/operator separation), 13 (`/join` redeem instructions).

## Walkthroughs exercised

- **Operator** — `/admin/setup.html` claim → backup → dashboard (Brave)
- **Label apply via `/join`** — submitted "Typically Magic Records" → operator approved → invite code → onboarded via `/admin/onboarding.html` (no existing nsec)
- **Artist invited by the label** — operator's existing backup file restored → strict-mode redirect → `/admin/redeem.html` (existing nsec path) → tried to redeem the `signed` roster invite the label issued

The label backup (Typically Magic Records) was saved to [packages/labels/](../packages/labels/) and the existing artist backups in [packages/artists/](../packages/artists/) were used.

## Fix list

### Copy / role-aware text

1. ✅ **setup.html — post-claim heading wrong.** After the operator claims the node, the `Save Your Backup` panel renders but the page header still reads *"No operator is configured yet. Use the setup token from your relay logs to claim this node as the first operator."* Swap or hide the original h1/lead after the claim succeeds.

2. ✅ **onboarding.html is hardcoded artist-only throughout.** Every visible string assumes `role=artist` even when a label invite is being redeemed:
   - Subtitle: "Artist Onboarding" → "Label Onboarding"
   - Step 3 heading: "Your Artist Profile" → "Your Label Profile"
   - Step 5 success: "Your artist profile has been published to NOSTR…"
   - Lead: "Tell fans about yourself…"
   - Field label: "Artist / Project Name *" → "Label Name *"
   - Placeholder: "e.g. Shibuya Crossings" → "e.g. Magic Records"
   - Bio hint: "A short description of you and your music"
   - **Genres field should be hidden for labels** (matches the behaviour already in `profile-setup.html`).

3. ✅ **Sidebar `common/js/admin-sidebar.js` — "MANAGE ARTIST" group heading is shown to labels** under their own profile card. Heading should adapt per role:
   - Artist → "MANAGE ARTIST" (current)
   - Label → "MANAGE LABEL" or "MY PROFILE"
   - Operator → "MANAGE" (operator may switch between several artists via the selector)
   - The "Analytics" sub-item is a placeholder regardless — consider hiding until implemented or relabel per role.

### Flow / placement issues

4. ✅ **onboarding.html — backup file download is in the wrong place.** Step 2 "Save Your Keys" only gives Copy buttons + a "I've securely saved my private key" checkbox; the actual Download Backup button appears on Step 5 (post-publish). Two consequences:
   - Step 2 forces the user to *claim* they "securely saved" the nsec when no real save tool is offered yet (Copy ≠ save).
   - Step 5 backup looks like a second key to manage, which it isn't.
   - **Fix**: move Download Backup into Step 2 alongside Copy + checkbox (matching `setup.html` / `redeem.html`), and remove it from Step 5. Keep Step 5 as a pure "you're in, here's where you published" summary.

5. ✅ **redeem.html — forces another backup download even when the user logged in by restoring from a backup file.** If the session was created via "Load Backup File" on `login.html`, the user already has a JSON backup on disk — the redeem backup step is redundant friction. **Fix**: when login.html processes a backup file, set a flag (e.g. `sessionStorage['equaliser_backup_loaded'] = '1'`); redeem.html's backup step reads it and either:
   - Skips the step entirely, OR
   - Shows a soft message ("You restored from a backup file — that's still valid for this nsec, no need to re-download") and enables the Continue button immediately. Download Backup remains available as an opt-in.

6. ✅ **redeem.html — "Redeem" button visible alongside "Check Code" before the code is checked.** It's disabled but still visible, which signals "you can click this" and adds friction. **Fix**: hide the Redeem button entirely until a successful Check (preview rendered), then swap Check Code → Redeem as the primary action.

### Architecture: onboarding consolidation

7. ✅ **onboarding.html bypasses profile-setup.html.** Shipped via Option A in the Open decisions section: onboarding.html is now a thin shim. Step 0 still gates on the invite code; Step 1 still lets the user generate keys, paste an existing nsec, or import a backup file; Step 2 still saves the backup. After Step 2 the user is handed off to `redeem.html?code=<INVITE>` which runs the existing redemption + profile-setup flow. Steps 3-5 (profile + relays + publish) and ~200 lines of related JS (`publishProfile`, `renderRelays`, `addRelay`, genre + relay state, `fetchExistingProfile`, the old `downloadBackup`, `goToDashboard`) were deleted. The existing-nsec and backup-file branches now skip Step 2 and hand off directly. `downloadKeysBackup()` + `loadBackupFile()` set `sessionStorage['equaliser_backup_loaded']` so redeem.html's backup step soft-gates (Continue is pre-enabled and the copy reads "Backup already saved").

   **Options to discuss tomorrow:**
   - **A)** Refactor onboarding.html so after Step 2 (Save Keys) it redirects to `redeem.html` (which then routes through `profile-setup.html`). Smallest reuse — onboarding.html becomes a thin shim that generates keys and hands off.
   - **B)** Replace onboarding.html's Steps 3-5 with an inline embed of profile-setup.html.
   - **C)** Leave onboarding.html as-is and document it as a "shortcut path" — fastest to ship but breaks the universal rule.

8. ✅ **Operator setup.html doesn't go through profile-setup.html.** Shipped via Option A in the Open decisions section: setup.html post-backup now redirects to `profile-setup.html?return=dashboard.html` and stashes the operator's chosen display name in sessionStorage. profile-setup.html pre-fills that name when its external-Kind-0 search finds nothing, and shows an operator-only "Skip for now →" link in the form actions (hidden for artists + labels). Artists + labels still have no escape hatch — the universal rule holds for them; operators just get an out because they're infrastructure-only.

### Label workflow gaps

9. ✅ **Sidebar "Managing Artist" dropdown shows pubkey hex instead of names** (e.g. `8ce7f5ce…6235` instead of "Typically Magic Records"). Should look up Kind 0 for each managed pubkey (including the label itself) via the cache API and render the display name, falling back to the pubkey prefix only if no profile exists. Same Kind 0 cache logic the sidebar profile card uses for the avatar/name.

10. **Label → artist releases workflow needs review.** Audited 2026-05-28; sub-fixes a + b + c + d + e + h shipped 2026-06-03. The wiring already existed at the sidebar + SessionManager level — `setSelectedArtistPubkey()` persists, the `equaliser:artist-switched` event broadcasts across tabs, and `signTrackEvent` on releases.html *correctly* routes self / managed / signed when given the right artist pubkey. The remaining gap was that no page consumed the selected-artist context; that's now closed for the four main editing surfaces.

    Concrete gaps + status:

    a. ✅ **Dashboard greeting + Recent Releases now scope by selected artist.** `dashboard.html` awaits `fetchRole()`, then `loadProfile()` + `loadReleases()` read `getSelectedArtistPubkey()` instead of `session.publicKey`. The greeting reflects the artist the label is acting as. Switch listener wired.

    b. ✅ **Releases page scopes by selected artist.** `releases.html` `loadDraftsFromAPI()` + `loadReleasedFromNostr()` now receive `getSelectedArtistPubkey()`. Switch listener clears + reloads on dropdown change.

    c. ✅ **Upload page scopes by selected artist.** `upload.html` defaults the artist + pricing fields from the *selected* artist's Kind 0 and sends `target_artist_pubkey` to `/api/tracks/upload` so the orchestrator stores the draft under the artist's pubkey (the endpoint already enforces `ctx.can_manage(target)`).

    d. ✅ **Edit-release scopes by selected artist + shows the banner.** All three `?pubkey=` reads now use `getSelectedArtistPubkey()`. The "Add Existing Track" modal lookup also pulls from the selected artist's catalogue.

    e. ✅ **Shared "Acting as" banner.** `AdminSidebar.renderActingAsBanner()` injects a banner at the top of `.main-content` when `getSelectedArtistPubkey() !== session.publicKey`. Auto-resolves the display name via the same Kind 0 cache the sidebar dropdown uses. Re-renders on every `equaliser:artist-switched` event. Pages just call `AdminSidebar.renderActingAsBanner()` after `fetchRole()` resolves.

    h. ✅ **`equaliser:artist-switched` listeners wired.** dashboard.html reloads profile + releases; releases.html resets state and reloads; upload.html re-seeds form defaults. Sidebar's auto-injected banner refresh works everywhere.

    f. ✅ **Per-row Upload CTA on artist-management.html.** New `actAsAndUpload(pubkey)` handler sets `SessionManager.setSelectedArtistPubkey()`, dispatches `equaliser:artist-switched` for any other open tabs, and navigates to upload.html. The upload form's existing scope-by-selected-artist logic (from 10c) does the rest. Renders next to Edit + Suspend in the row actions column.

    g. ✅ **Proactive delegation banner on releases.html.** New `checkDelegationNeeded(targetPubkey)` runs alongside `loadReleases()`. When the caller is acting on behalf of someone (`target !== self`) and that artist's `relationship_type === 'managed'` and `/api/delegations/active/{pk}` returns 404, a banner above the releases list reads "No active Manager Authorization. You need {artist}'s permission to publish on their behalf. Request one →" with a deep-link to artist-management.html (where the Request column button already exists). Hidden for self-publish, signed artists, and any backend error.

    *Also discovered during the audit (still unfixed):*
    - Dashboard greeting "Welcome back, Artist" before profile resolves — the initial unfilled state is "Artist" rather than something role-aware (e.g. blank or "Label"). Will resolve to the correct name once the Kind 0 lookup completes.

## What's left

Three items surfaced during manual UAT on 2026-06-08. **Status: discussion before code.** Each has a recommendation but the user has asked we agree the approach before touching files.

- ✅ **14** — operator role separation (shipped 2026-06-08, see "Role boundaries to review")
- **15** — `/join` should let artists nominate a label they'd like to be represented by (see "Application flow")
- **16** — release-package import for a freshly-onboarded artist doesn't surface drafts on the dashboard / releases page (see "Bugs surfaced during UAT")
- ✅ **19** — "Add Existing Artist" roster invite now stores + displays the artist name (shipped 2026-06-14, see "Bugs surfaced during UAT")
- **20** — in-app roster invite: notify the targeted artist instead of out-of-band-only code sharing (approach chosen, planning — see "Bugs surfaced during UAT")
- ✅ **17** — operator claim education (shipped 2026-06-08, see "Role boundaries to review")
- ✅ **18** — operator claim pre-flight identity check (shipped 2026-06-08, see "Role boundaries to review")

**14, 17, 18 shipped together** as one coherent operator-identity-separation change. 15 and 16 remain independent + open.

## Application flow

### 13. ✅ **`/join` success screen has no forward-pointer to the redeem URL.** (shipped 2026-06-07)

Shipped both halves of the closed loop — applicant-facing instructions on `/join` and the operator-facing deep link on the approve modal.

Applicant side (`client/join.html`):
- Success card now leads with a "What happens next" 3-step list (operator reviews → emails 12-char code → use one of the URLs below to redeem).
- Pre-built onboarding deep link `${origin}/admin/onboarding.html?invite=YOUR_CODE` rendered in a copyable input — applicant substitutes `YOUR_CODE` when their code arrives. Origin via `window.location.origin` so it works across localhost + production nodes.
- Existing-nsec block points at `${origin}/admin/login.html` with a one-line note that login auto-redirects to redeem when the pubkey has no role yet (Phase A behaviour already in place).
- npub heuristic: if the applicant pasted an npub in the optional field, the existing-nsec block is highlighted green so they prefer that path on landing.
- Bookmark reminder closes the panel.

Operator side (`content_node/orchestrator/access-requests.html`):
- Invite-code modal (the one shown after Approve) now renders the same deep-link pattern with the real code substituted in (`${origin}/admin/onboarding.html?invite=<CODE>`), with its own Copy button. Operator can paste either just the code or the full link into their email client.

Nothing API-level changed — onboarding.html already consumed `?invite=` (existing Phase A code path), so the deep link works against any node without server changes.

### 15. **`/join` should let an artist nominate a label they'd like to be represented by.** (raised 2026-06-08, discussion stage)

Today the artist application on `/join` collects name / email / npub / description / links — but no preference about which label, if any, they want to join. The operator approving the request guesses (or asks out-of-band). If the artist intends to onboard under a specific label that's already on the node, surfacing that intent up front lets the operator route the invite directly into that label's roster (`target_managed_by`) and pick the right relationship type (`managed` / `signed`) without a follow-up email.

The plumbing already exists: `access_requests` has `target_managed_by` + `target_relationship_type`, both honoured by the approve flow and carried through redemption into `node_artists`. What's missing is the *applicant-side* expression of preference; today only operators set those fields at approval time.

How to fix — options to discuss:

| Option | What it costs | What it gives | Notes |
|---|---|---|---|
| **A. Add a label picker to `/join` artists.** Public `GET /api/access/labels` returns `[{pubkey, name}]` for all `node_artists.role='label'` rows; `/join` shows the list (or "Independent — no label" as default) when role=artist is selected; the chosen pubkey + relationship type go into a new `preferred_managed_by` (or reuse `target_managed_by`) column on `access_requests`. Approve modal pre-fills the picker from the applicant's choice; operator can still override. | One new public endpoint, one new column (or repurpose `target_managed_by` as "preferred"), one new form field, approve-modal pre-fill. | Closes the loop without requiring the operator to ask. | Public list of labels needs filtering — only labels who opted in to public listing? Or just any non-suspended label? Privacy of labels who don't want to be advertised needs an opt-in flag. |
| **B. Free-text "preferred label" field on `/join`.** Just a string the operator reads alongside the application. No new endpoint, no DB join — just another `description`-like field. | Smallest code. | Less misleading: operator still does the routing decision, applicant just *hints*. No risk of leaking labels who don't want public exposure. | Operator still has to manually match the string to a label and pick its pubkey at approve time. Misses the point of "auto-route to chosen label". |
| **C. Leave as-is, document as out-of-band.** Applicant emails the operator separately to express preference. | Zero code. | Recognises that low-volume nodes don't need automation. | Doesn't actually fix the user complaint. |

Open questions to resolve before coding:
- Is there a label-visibility flag today, or does *every* label on the node show up in a public list? (Need to grep `node_artists` schema; if not, a `public_listing` column probably needs adding before B is safe.)
- If a label is chosen but later declines to take the artist on, does the operator just override `target_managed_by` to null + approve? That already works today.
- Should labels themselves see incoming "preferred-by" applications and have a chance to claim them? Or stays operator-mediated?

**Recommendation: A**, but explicitly gated on a `public_listing` flag (defaulting to false) so existing labels stay invisible until they opt in via `artist-management.html`'s edit modal. That avoids accidentally publishing the label roster to a public application form. Confirm with user before implementing — particularly the public-listing flag direction.

## Bugs surfaced during UAT

### 16. **Release-package import for a freshly-onboarded artist doesn't surface drafts on dashboard / releases page.** (raised 2026-06-08, investigation needed)

Reproduction (per the user on 2026-06-08):
1. Bootstrap operator → invite Shibuya Crossings as an artist.
2. Shibuya redeems, lands on dashboard.
3. Imports a release package (`./tools/import-artist.sh` or via the admin import UI).
4. Expected: drafts visible on `releases.html` (Drafts tab) and recent-releases card on `dashboard.html`.
5. Actual: neither surface shows the imported tracks.

Likely root causes — needs verification before deciding a fix:

| Hypothesis | How to verify | Likely fix |
|---|---|---|
| **A. Drafts written under wrong pubkey.** Package import (`POST /api/releases/import`) might write `draft_tracks.artist_pubkey` to a pubkey other than the onboarded artist (e.g. the importing operator's or the package signer's). | `docker exec equaliser-orchestrator sqlite3 /data/drafts.db 'SELECT artist_pubkey, title FROM draft_tracks'` after import; compare against Shibuya's pubkey from her backup file. | Server: derive `artist_pubkey` from NIP-98 caller pubkey when not explicitly set; or require client to pass `target_artist_pubkey` (Fix 10c added this on `/upload`). |
| **B. Drafts list query filters by something else.** `releases.html` `loadDraftsFromAPI()` calls `/api/drafts?pubkey=${getSelectedArtistPubkey()}`. If onboarding doesn't set `selectedArtistPubkey` after Phase A redeem, the query may be running with `null` → empty result. | Open DevTools on `releases.html`, look at network request URL. Also check `sessionStorage.getItem('equaliser_session')` post-redeem — does `selectedArtistPubkey` exist? | If null, `redeem.html` should default `selectedArtistPubkey = publicKey` for self-publishing artists; or `releases.html` should fall back to `session.publicKey` when no selection. |
| **C. Package import succeeds but background HLS encode silently fails.** Draft row not created or marked `status=failed`. | `docker logs equaliser-orchestrator` during import; check `draft_tracks.status` column. | Surface error to UI; clean failed rows; retry path. |
| **D. Authorization gate rejects the import.** `POST /api/releases/import` is `Depends(require_role)` + `ctx.can_manage(artist_pubkey)`. If the package's stated artist pubkey doesn't match the caller, import returns 403. Tools script may not pass the right `--artist-pubkey`. | `import-artist.sh --help`; check what the script POSTs vs the caller's pubkey. | Document the script; or auto-fill `artist_pubkey` from NIP-98 caller. |

How to fix — proposal:
1. **First**: reproduce locally and walk through which hypothesis is correct (under 30 min). Don't write code yet; the trace dictates which file changes.
2. **Then**: depending on root cause, one of B/A is most likely. If B, the fix is a one-liner in `redeem.html` or `releases.html`. If A, it's the orchestrator deriving artist_pubkey correctly on package import.
3. **Verification**: re-run the user's exact flow + confirm drafts appear. Add a Playwright smoke test that covers Phase A redeem → import → drafts visible.

**Recommendation:** investigate first. The wording of the issue ("doesn't appear as a draft release") + the symptom of *no* surface showing the tracks (dashboard, releases page, *both*) points toward B (selected-artist context missing for a fresh redeem) rather than A (wrong pubkey on import) — because A would still let the dashboard's *unscoped* Kind 30050 query find the published track, whereas B fails on the orchestrator's *scoped* drafts query. Confirm with the user before coding the fix.

### 19. ✅ **"Add Existing Artist" roster invite discarded the artist name (showed npub / "Standalone").** (shipped 2026-06-14)

UAT (2026-06-14): a label ("Typically Magic Records") used Add Existing Artist for "Shibuya Crossings"; the generated code showed on `invite-codes.html` as *Standalone (no request)* with the label's own pubkey prefix beside the role badge — never the artist's name.

Root cause: the typed `artist_name` (and optional `npub`) were dropped on the way to storage. `routers/label.py:add_existing_artist` forwarded only role/managed_by/relationship_type to `relay_admin.create_invite_code`, which had no `artist_name` param; the relay's `CreateOrphanInviteCode` hardcoded `artist_name='(direct invite)'`.

Fix (threaded both through all four layers): `add_existing_artist` → `relay_admin.create_invite_code(artist_name, npub)` → relay `handleCreateInviteCode` (decodes `artist_name`/`npub`) → `CreateOrphanInviteCode` (stores them; falls back to `'(direct invite)'` only when no name). `invite-codes.html` now renders three distinct provenances: **Roster invite: \<name\>** (name + managing label), **Approved request: \<name\>**, **Standalone (no request)**. `npub` is also persisted now (unused by the list view, but it's the key Issue 20 needs). Verified via the relay internal API: a roster code stores `artist_name='Shibuya Crossings'` + `npub`, while pre-fix codes keep `'(direct invite)'`. Relay + orchestrator rebuilt; existing onboarded data preserved (Postgres volume untouched). **Codes generated before the fix don't retroactively gain the name — generate a fresh roster invite to see it.**

### 20. **Adding an existing artist gives the artist no in-app signal — they only get the code out-of-band.** (raised 2026-06-14, **approach chosen: in-app roster invite**, planning)

UAT (2026-06-14): after a label "added" Shibuya Crossings, the artist (signed in separately on the same node) saw no pending request. This is *by design today* — Add Existing Artist generates a roster invite **code** the label must share out-of-band; the artist redeems it at `/admin/redeem.html`. There is no artist-facing inbox, and the `npub` the label enters was (until Issue 19) discarded.

User decision (2026-06-14): build the **in-app roster invite** — when a label adds an existing artist *by npub*, the targeted artist sees a "\<Label\> invited you to their roster — redeem?" prompt on login and can accept in one click. Needs: persist the npub on the invite (done in Issue 19), an artist-facing query that finds unredeemed roster invites targeted at the caller's pubkey, a notification/banner surface, and a one-click redeem that reuses the existing redeem transaction. **Plan approved 2026-06-14, implementation pending — see [ROSTER_INVITE_PLAN.md](ROSTER_INVITE_PLAN.md).**

## Role boundaries to review

These are principles the user flagged on 2026-05-28 during manual UAT. Both touch authorization across the orchestrator + UI.

### 11. ✅ **Labels should NOT be allowed to approve access requests — operator-only.** (shipped 2026-06-06)

Current behaviour (confirmed in code 2026-05-28):

| Endpoint | Today gated by | Today admits |
|---|---|---|
| `GET  /api/label/access-requests` | `require_label` | label **or** operator |
| `GET  /api/label/access-requests/{id}` | `require_label` | label **or** operator |
| `POST /api/label/access-requests/{id}/approve` | `require_label` | label **or** operator |
| `POST /api/label/access-requests/{id}/decline` | `require_label` | label **or** operator |

`require_label` in `dependencies.py:116-121` admits both `label` and `operator`. So a label sitting on the node can today see the entire applicant queue and approve someone into the node (the role they grant can only be `artist`, per the existing approver check in `routers/label.py` — labels can't promote anyone to label/operator — but they can still let an artist join the *node*).

What the user wants:
- The whole `/admin/access-requests.html` page should be **operator-only**.
- Hide the "Access Requests" item in the sidebar `nav-label-admin` group for `role === 'label'`.
- Re-gate all four endpoints with `require_operator` instead of `require_label`.
- Labels would still onboard artists into *their own roster* via "Add Existing Artist" on `/admin/artist-management.html` (which issues a roster invite). The applicant pool from `/join` is the operator's queue, not the label's.

Likely follow-ons:
- Move the access-requests sidebar entry out of "Content" group into a label-specific "Roster" group, OR drop it entirely from the label sidebar.
- Server-side tests confirming a label gets 403 on `/api/label/access-requests/*` after the change.

### 12. ✅ **Label and operator roles are separate — operators should not auto-inherit label permissions.** (shipped 2026-06-06)

Shipped a pragmatic "soft separation with sharper edges": every `Depends(require_label)` call site was audited; the endpoints that are genuinely meaningful only as a label-acting-for-themselves were moved to a new `require_label_strict` gate (label only, operator rejected); dual-role endpoints whose internal logic *already* branches per-role correctly kept `require_label`.

New dependency in `content_node/orchestrator/api/dependencies.py`:
```python
async def require_label_strict(request: Request) -> RoleContext:
    """Require label role specifically — operators are rejected."""
    ctx = await require_role(request)
    if ctx.role != "label":
        raise HTTPException(status_code=403, detail="Label-only endpoint (operators have no analogue for this action)")
    return ctx
```

Audit + gate decisions:

| Endpoint | Role gate | Rationale |
|---|---|---|
| `GET /api/label/artists` | `require_label` (unchanged) | Operator legitimately sees all artists; label sees their roster. Branching already inside endpoint. |
| `GET /api/label/artists/{pubkey}` | `require_label` (unchanged) | `ctx.can_manage(pk)` enforces correct scope per role. |
| `PATCH /api/label/artists/{pubkey}` | `require_label` (unchanged) | Operator-only fields (`managed_by` transfer) checked inside endpoint; otherwise both roles can edit. |
| `GET /api/label/invite-codes` | `require_label` (unchanged) | Both roles need to see codes they can issue. |
| `POST /api/label/invite-codes` | `require_label` (unchanged) | `target_role ∈ {label,operator}` already gated to operator inside endpoint. |
| `POST /api/label/add-existing-artist` | **`require_label_strict`** | Only meaningful as label-roster-self-onboarding; the resulting code carries `target_managed_by = caller pubkey` which has no operator analogue. |
| `POST /api/delegations/request` | **`require_label_strict`** | NIP-26 delegation is artist→label; operator isn't a delegation party. |
| `GET /api/delegations/outgoing` | **`require_label_strict`** | The caller's own outgoing requests. Operators don't issue delegation requests. |
| `GET /api/delegations/active` | **`require_label_strict`** | Used at publish time to insert delegation tag. Only labels publish on behalf via NIP-26. |
| `GET /api/delegations/active/{artist_pubkey}` | **`require_label_strict`** | Same as above for a specific artist. |
| `POST /api/label/access-requests/*` (4 endpoints) | `require_operator` | Already locked down in Fix 11. |

Out of scope for this fix (already decided / unchanged):
- DB cross-row constraint (operator on same pubkey as an artist/label) — not constrained *as of fix 12*; the audit showed no current path causes a single pubkey to land in both `node_operators` and `node_artists`. **Superseded 2026-06-08:** the hard-separation decision in #14 now mandates enforcing this mutual exclusion at claim/redeem time. See #14.
- Operator parallel endpoints for label-only actions — deferred until an actual use case appears. (Note: with hard separation, an operator who also wants a label surface uses a *separate* pubkey onboarded as a label, rather than overloading the operator identity.)

Frontend impact:
- `releases.html` / `edit-release.html` `signTrackEvent` only enters the delegation branch when `relationship_type === 'managed'`. Labels still get the full 200/404 contract. An operator who somehow ends up acting-as a managed artist will now get an "HTTP 403" surfaced through the catch — explicit + correct (operators aren't supposed to be on this code path).
- `artist-management.html` `/api/delegations/active` parallel fetch already uses `.catch(() => null)`; operator response is now 403 instead of 200 with empty delegations — UI continues to render normally.

### 14. ✅ **Operator role separation — operator is infrastructure, not a personal-artist surface.** (shipped 2026-06-08)

Today's behaviour: after `setup.html` → backup-save → `profile-setup.html`, the operator is sent to `dashboard.html`. From there the sidebar's *Manage* nav (dashboard / releases / upload / profile) is rendered the same as for an artist, so the operator can navigate into personal-artist release pages they have no business in. There is no page-level gate stopping them from rendering the page; the data calls just return empty (or 403 in some places after fix 12).

**Conceptual model (agreed with user 2026-06-08):**
- **Operator is its own role.** Claiming a node makes the pubkey infrastructure: they own the node and pay for the resources, so they get full visibility into the roster (`artist-management.html`), the applicant queue (`access-requests.html`), invite codes (`invite-codes.html`), and all node-admin tooling. They do **not** get a personal-artist surface — no own-releases dashboard, no upload, no profile-as-artist — because being an operator says nothing about whether they make music.
- **Roles do not auto-inherit.** An operator pubkey (`node_operators` row) is *not* automatically an artist or label. This is already true at the DB level — `claim-operator` writes only a `node_operators` row, no `node_artists` row — so the UI fix is to stop showing operators the personal-artist surface.
- **Hard separation — no pubkey holds two roles (decided 2026-06-08).** For now a pubkey is in **exactly one** of `node_operators` *or* `node_artists` (artist/label). No dual-role pubkeys. This must be **enforced** at the two entry points:
  - `claim-operator` / operator-invite redemption → reject if the pubkey already has a `node_artists` row (artist or label).
  - artist/label invite redemption (`/api/access/redeem`) → reject if the pubkey already has a `node_operators` row.
  Both should return a clear error (e.g. `already_has_other_role`) so the UI can explain "this identity is already an operator/artist on this node — use a different key."
- **Implication for multi-hat humans (incl. the project author).** Someone who is genuinely operator + label + artist uses **separate pubkeys (separate nsecs)** per role — one nsec for node operation, another for their artist/label identity. This is the deliberate cost of hard separation and is acceptable "for now."
- **Multi-role UX is therefore moot for now.** No "switch hats" navigation, and the `/api/internal/auth/role` precedence question disappears — a pubkey can only resolve to one role because it can only hold one. If we later want true multi-role identities, that's a separate future phase that would revisit this decision.

**Concrete behaviour wanted:**
- After claim, operator lands on `node-overview.html` (their actual home page), not `dashboard.html`.
- Operator **can** access (they own/pay for the node): `node-overview.html`, `artist-management.html`, `access-requests.html`, `invite-codes.html`, and all node-admin pages (`sync-manager`, `ipfs-storage`, `blossom-config`, `user-cache`, `node-settings`).
- Operator **cannot** access the personal-artist surfaces — `dashboard.html`, `releases.html`, `upload.html`, `edit-release.html`, `profile.html` redirect to `node-overview.html`.
- Sidebar does **not** render the *Manage* nav group for `role === 'operator'`. It keeps the *Label Admin* group (roster oversight — operators legitimately see all artists there) and the *Node Admin* group.
- *Listener View* link stays (operators may want to QA the listener UI).
- **Mutual-exclusion enforcement at onboarding** (per the hard-separation decision above): operator claim/redeem rejects pubkeys that already hold an artist/label role, and artist/label redeem rejects pubkeys that already hold an operator role. This is server-side (relay redeem/claim transaction) with a UI-friendly error.

**Open question resolved:** `artist-management.html` (and the rest of the Label Admin group) **stays operator-accessible** — operators own the node and need roster visibility. Only the five personal-artist pages above are blocked. (This was option (a) from the prior discussion.)

How to fix — options:

| Option | What it costs | What it gives | Notes |
|---|---|---|---|
| **A. Per-page role gate + role-aware landing.** Each of the five personal-artist pages runs `if (getRole() === 'operator') location.href = 'node-overview.html'` after `fetchRole()` resolves. `setup.html` post-claim → `node-overview.html` (not `dashboard.html`). Sidebar drops `nav-manage` for operators (keeps `nav-label-admin` + `nav-node-admin`). | Small surface — setup.html, dashboard.html, releases.html, upload.html, edit-release.html, profile.html, admin-sidebar.js. | Clear contract: operators never land on a personal-artist page. Same role-gate pattern Phase D/E pages already use. | Recommended. Direct URL access is covered because the gate runs on every page load, not just sidebar clicks. |
| **B. Generic `/admin/index.html` redirector** that reads role and bounces to the right home (`dashboard` for artist, `artist-management` or `node-overview` for label/operator), **plus** the per-page gates from A (direct URL access still needs them). | One extra page on top of A. | A clean "default admin entry" for future links/bookmarks. | A is sufficient for now; B can come later if we find bare `/admin/` links landing people wrong. |
| **C. Strip operator access at nginx level.** `location ~* (dashboard\|releases\|upload\|edit-release\|profile)\.html` block. | Smallest code change. | — | Not viable: nginx can't read sessionStorage to know the role, and it duplicates role logic across nginx + Python + JS. Rejected. |

Verification step before shipping (not a blocker, but check during implementation):
- **No existing pubkey already holds both roles.** Before turning on mutual-exclusion enforcement, confirm no current seed/bootstrap/test data has the same pubkey in `node_operators` and `node_artists` (e.g. an `OPERATOR_PUBKEYS` env value that's also an onboarded artist). If one exists, enforcement would lock it — clean it up or migrate first. Quick check: compare `node_operators.pubkey` against `node_artists.pubkey` on a representative node.

**Recommendation: A** for the UI separation (role-aware landing + per-page gates + sidebar drops `nav-manage` for operators), **plus** the server-side mutual-exclusion guard at claim/redeem so the hard-separation invariant is actually enforced, not just assumed. The two ship together: the UI fix makes operators behave as infrastructure-only; the server guard guarantees a pubkey can't accumulate a second role behind the UI's back.

**Shipped 2026-06-08** (Option A + server guard), covering #14, #17, #18 in one change:
- **Server guard (Go relay, `internal/storage/admin.go`)** — `RedeemInviteCode` rejects an operator-invite for a pubkey already in `node_artists` (`already_has_artist_role`, 409) and an artist/label invite for a pubkey already in `node_operators` (`already_operator`, 409); `ClaimFirstOperator` rejects a pubkey already in `node_artists`. New codes mapped to 409 in `internal/api/api.go`. Existing within-table `already_managed_by_other` retained.
- **UI separation** — `setup.html` operator landing now routes through `profile-setup.html?return=node-overview.html`. The five personal-artist pages (`dashboard`, `releases`, `upload`, `edit-release`, `profile`) redirect operators to `node-overview.html` after `fetchRole()` resolves (`profile.html` gained the `fetchRole()` call). Sidebar (`common/js/admin-sidebar.js`) drops the *Manage* nav group, the artist-selector dropdown, and the bottom-nav *Edit Profile* + *Manager Authorizations* links for operators.
- **Verification** — server guard 8/8 (both directions + happy paths); operator UI 19/19 (claim education + ack gate, fresh-key happy path, all five page redirects, sidebar, warn-panel + override); label regression 5/5 (labels keep all personal-artist pages + Manage nav); #18 real detection 3/3 (seeded artist Kind 0 + Kind 30050 on the local relay → genuine warning, claim blocked). All local-only; no VPS.

### 17. ✅ **Operator claim: explain role distinction + the "one identity per role" consequence.** (shipped 2026-06-08)

Falls out of the hard-separation decision in #14. With one role per pubkey, an operator who *also* wants to be an artist or label must use a **separate nsec** for that. The claim flow (`setup.html`) says nothing about this today, so a user is likely to claim with their everyday/personal nsec — the very key they'd want to publish music under — and then discover (at #14's enforcement gate, or worse, in confusion) that the identity is now operator-only on this node.

Where: `setup.html`, the `step-claim` step. The claim form already offers three identity sources — paste an existing nsec, leave blank to generate fresh, or use a NIP-07 extension ([setup.html:76-82](../content_node/orchestrator/setup.html)).

What to convey at claim time:
- This identity becomes **the node operator** — infrastructure only. On this node it can't also be an artist or a label.
- If you also want to publish music (artist) or run a roster (label), you'll do that with a **different Nostr identity (a separate nsec)**.
- Recommendation to the user: claim with a **dedicated operator nsec**, not your personal artist/label key. The "generate fresh" option is the safe default for exactly this reason.

How to fix — options:

| Option | What it does | Notes |
|---|---|---|
| **A. Info callout + acknowledgement checkbox.** A short explainer panel above the claim button + a required "I understand this identity will be operator-only on this node" checkbox that gates Claim. | Guarantees the user sees it. Mild friction. Pairs naturally with #18 (the automated check) — the checkbox is the manual backstop. |
| **B. Info callout only (no gate).** Same copy, but Claim stays enabled. | Lightest. Operators are technical; a clear callout may be enough. Risk: people skim and miss it. |
| **C. Nudge the default toward "generate fresh".** Make generate-fresh the visually primary path with copy "Recommended: use a dedicated operator key", paste-existing demoted to a secondary disclosure. | Strongest steer without a hard gate. Could combine with A/B. |

**Recommendation: A + C** — lead with "generate a dedicated operator key" as the recommended path, keep paste-existing available but secondary, and require a one-line acknowledgement checkbox. This sets the expectation *before* #18's automated check runs, so when #18 does flag an existing artist/label identity the user already understands why.

**Shipped 2026-06-08** (A + C): `setup.html` `step-claim` gained a purple role-distinction callout, a "Recommended: generate a dedicated operator key" steer on the identity field, and a required *"I understand this identity will be operator-only on this node"* checkbox gating both Claim Node and Use Extension. See the shared shipped-note under #14.

### 18. ✅ **Operator claim: pre-flight check for existing artist/label activity on the provided identity.** (shipped 2026-06-08, Option B)

When the operator claims with an **existing** identity (pasted nsec or NIP-07 extension — not the generate-fresh path, which is a brand-new key and needs no check), the flow should look that pubkey up on public + Equaliser relays for signals that it's **already an artist or label**, and if found, explain why it shouldn't be reused as an operator identity and prompt for a different/new key.

What counts as an "already an artist/label" signal (these are Equaliser-specific markers, not generic Nostr presence):
- **Kind 0 with `["user-type", "artist"]` tag** — the Equaliser artist-profile marker.
- **Kind 30050 track events** authored by the pubkey — only artists/labels publish music metadata.
- (Maybe) **Kind 30051 release events**.
- **Not** a trigger: a plain Kind 0 profile, follows, posts, reactions — i.e. a *listener/social* identity. Those don't conflict with becoming an operator (listeners aren't a `node_artists` role), so the check must be specific to artist/label markers, or it'll false-positive on anyone who's ever used Nostr.

Where to query: the node's configured `STANDARD_RELAYS` + a hardcoded discovery set (the same `DISCOVERY_RELAYS` list `profile-setup.html` already uses: Damus / Primal / nos.lol / relay.nostr.band) + any Equaliser peer relays. Reuse the external-Kind-0 discovery pattern already in `profile-setup.html` / `onboarding.html` (`fetchExistingProfile`) and extend it to also query Kind 30050.

**Key design tension — block vs warn (needs a decision):**
- This is a **broader** policy than #14's enforcement. #14 blocks reuse of a role *on this node* (authoritative, local DB). #18 reacts to artist/label activity *anywhere on Nostr* — a heuristic from external relays that may time out, be incomplete, or (rarely) false-positive.
- The user's framing ("explain why this id can't be used") leans toward a hard block. But a hard block driven by a flaky external query risks locking someone out of claiming *their own node* — e.g. relays are unreachable and we can't even run the check, or the pubkey genuinely is an artist elsewhere but the user has deliberately decided to also operate a node with it.

| Option | Behaviour on detection | Behaviour when the check can't run (relays down/timeout) | Notes |
|---|---|---|---|
| **A. Hard block.** Detected artist/label → Claim disabled, must supply a different key or generate fresh. | Fail-open: allow claim (can't prove a conflict). | Matches the user's literal ask. Strongest separation. Risk: false-positive lockout. |
| **B. Strong warning + explicit override.** Detected → red explainer ("This identity already publishes as an artist/label on Nostr — operators should be a separate identity") with two clear buttons: *Use a different key* (recommended) and *Claim anyway, I understand*. | Silent or a soft "couldn't verify" note; allow claim. | Robust against flaky relays. Still steers hard. The local #14 enforcement remains the real gate. Recommended. |
| **C. Warn-only, no override needed.** Detected → informational note, Claim stays enabled. | Allow. | Weakest — basically just #17's copy with data behind it. |

**Decision (user, 2026-06-08): Option B** — strong warning with an explicit, slightly-uncomfortable override, fail-open when relays are unreachable. Rationale: the *authoritative* separation guarantee is #14's local DB enforcement (which is exact and can't be fooled by relay flakiness); #18 is a UX steering layer to stop people *accidentally* burning a public artist identity on an operator slot. A heuristic on external relays shouldn't be able to hard-lock a user out of their own node, so it's a wall with a labelled door rather than no door.

**Shipped 2026-06-08** (Option B): `setup.html` `checkExistingArtistIdentity(pubkey)` queries the local relay + the node's `STANDARD_RELAYS` (from `/api/config`) + the default `DISCOVERY_RELAYS` (Damus/Primal/nos.lol/relay.nostr.band) in parallel for **Kind 0 with `["user-type","artist"|"label"]`** or **any Kind 30050** — the artist/label markers only (plain Kind 0 / social presence doesn't trigger). Runs only for existing identities (pasted nsec or NIP-07 extension), skipped for generate-fresh. On a hit: a red warning panel with *Use a different key* / *Claim anyway*. Fails open (≤4s/relay, parallel) so unreachable relays never block the claim. Reuses the `profile-setup.html` parallel-query pattern. Detection verified end-to-end against the real relay (seeded artist signals → warning → claim blocked). Symmetric check on the artist/label redeem direction remains deferred (operators are rarer).

Open questions:
1. Should the check also run for the **artist/label redeem** flow in reverse — i.e. warn an artist/label onboarding with an identity that already operates a node elsewhere? Probably lower priority (operators are rarer), but symmetric.
2. NIP-07 extension claims: we get the pubkey but the extension won't reveal the nsec — the relay check works on pubkey alone, so this is fine. Note it so the check isn't accidentally skipped for extension claims.
3. How long do we let the relay queries run before letting the user proceed? Suggest a short budget (~3-4s, like `profile-setup.html`'s discovery) with a "checking…" state, then fail-open.

## Open decisions (resolved 2026-05-29)

Both decisions below were resolved in favour of Option A and shipped. Kept for reference.

### Fix 7 — onboarding.html ↔ profile-setup.html consolidation (✅ shipped Option A)

Today `redeem.html → goNext()` redirects every artist + label through `profile-setup.html`. `onboarding.html` (new-identity flow) does its own embedded Step 3 (Profile) + Step 4 (Relays) + Step 5 (Publish) and bypasses profile-setup. This contradicts the "always profile-setup" rule.

| Option | What it costs | What it gives | Risk |
|---|---|---|---|
| **A. Onboarding.html becomes a thin shim**: keeps Step 0 (invite gate) + Step 1 (generate keys) + Step 2 (save backup), then redirects to `redeem.html?code=…` (which routes through profile-setup) | Smallest refactor. Steps 3-5 deleted. ~200 lines removed | One canonical profile-setup UI. The redeem path takes care of everything else. | Need redeem.html to handle "user just generated keys, no role yet" cleanly — the redirect carries the code, redeem.html redeems it as before. Backup already done at Step 2, so the soft-gate from fix 5 kicks in and the redeem backup step is skipped. |
| **B. Replace Steps 3-5 with an iframe/embed of profile-setup.html** | Largest refactor. Two UI surfaces share rendering via embed. | Same flow visible inside the onboarding card. | iframe/embed gotchas (sessionStorage, scrolling, focus). Not recommended. |
| **C. Leave as-is, document onboarding.html as a "shortcut"** | Zero code. | Fast to ship. Backbone of the user flow stays unchanged. | Violates the universal rule the user asked for. Two profile-create UIs to maintain. |

**Recommendation: A.** Concretely: after Step 2 (Save Keys), redirect to `redeem.html?code=${inviteCode}` instead of advancing to Step 3. Profile-setup then runs as usual. The new-identity user gets the same external-Kind-0 discovery + relay picker + Kind 0 + Kind 10002 publish as the existing-nsec user.

### Fix 8 — Operator profile-setup (✅ shipped Option A with operator-only Skip)

Today `setup.html` ends at dashboard. The operator never publishes a Kind 0, so the operator's pubkey is invisible on the wider Nostr network.

| Option | Pros | Cons |
|---|---|---|
| **A. Route operator through profile-setup too** (matching the universal rule). Pre-fill `name` from the operator's setup.html input; add operator-flavored copy | Consistent rule, operators discoverable on Damus/Primal etc. | One more step before the operator can claim the node and see the dashboard. |
| **B. Keep operator as a "shadow" identity** (no Kind 0). Operators are infrastructure, not artists/labels. | Operator pubkey is server-side only, doesn't leak across Nostr. | Operators can't be DM'd, followed, or recognised externally. |

**Recommendation: A**, but make profile-setup *skippable* for the operator only (a "Skip for now" link that's hidden for artists/labels). This way the rule is universal but the operator has an out for infrastructure-only roles.

## Related

- Existing post-redeem profile-setup plan: [`/Users/decky/.claude/plans/let-s-plan-access-control-graceful-newell.md`](../../../.claude/plans/let-s-plan-access-control-graceful-newell.md)
- Phase F + G architecture: [NODE_MANAGEMENT_ARCHITECTURE.md](NODE_MANAGEMENT_ARCHITECTURE.md)
- Live walkthroughs (now outdated relative to this list): [live_pages/](live_pages/)
