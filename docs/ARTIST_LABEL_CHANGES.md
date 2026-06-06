# Artist + Label onboarding — fix list

Captured during manual UAT in Brave (operator) + Safari (label/artist) on a freshly reset local node, May 2026. After Phase G + post-redeem profile-setup shipped, walking through the operator + label + artist onboarding flows surfaced the following issues.

**Status:**
- 2026-05-28: fixes 1–6, 9 shipped + smoke-verified (5/5 Playwright checks). Fix 10 audited; gaps documented inline.
- 2026-05-29: fixes 7 + 8 shipped + smoke-verified (2/2 Playwright checks). onboarding.html is now a thin shim that hands off to redeem.html → profile-setup.html. setup.html routes operators through profile-setup with an operator-only "Skip for now" link.
- 2026-06-03: fix 10 sub-fixes a + b + c + d + e + h shipped + smoke-verified (4/4 Playwright checks).
- 2026-06-06: fix 10 sub-fixes f + g shipped + smoke-verified (4/4 Playwright checks). Per-row Upload button on artist-management.html sets the selected artist and navigates to upload.html; releases.html surfaces a proactive "No active Manager Authorization" banner with a deep-link when the user is acting as a managed artist without an active NIP-26 delegation.

Outstanding: 11 + 12 (role boundaries), 13 (`/join` redeem instructions).

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

- **11** — label cannot approve a node-join — operator-only (see "Role boundaries to review")
- **12** — label and operator roles are separate (see "Role boundaries to review")
- **13** — `/join` success screen should hand the applicant the redeem URL + instructions (see "Application flow")

## Application flow

### 13. **`/join` success screen has no forward-pointer to the redeem URL.**

Today (`client/join.html:177-184`):
> *"Application Received. Your application is in the operator's queue. You'll get an invite code by email if approved."*

That's the entire post-submit experience. The applicant has no idea:
- What the invite code will look like (12-char hex)
- Where to take it once received (which URL on this node)
- The difference between using their existing nsec vs generating fresh keys
- That the redeem URL can be deep-linked with `?invite=<CODE>` for one-click flow

What the user wants: when an applicant submits via `/join`, the confirmation screen should include the URL pattern they'll use later + a clear "what happens next" sequence. So when the operator's email arrives (currently manual; SMTP not yet wired), the applicant has the context to act on it.

Concrete change:
- Expand the `#success-card` content with:
  1. ✓ Application received
  2. **What happens next**: operator reviews → if approved, they email you a 12-char invite code
  3. **When your code arrives**, visit: `http://<this-node>/admin/onboarding.html?invite=YOUR_CODE` (new identity) — or if you already have a Nostr nsec, sign in at `/admin/login.html` and you'll be redirected to redeem.
  4. Save this page or bookmark the URL so the applicant has it ready.
- The node's base URL should be derived from `window.location.origin` so it works across localhost + production nodes.
- Operator-side change to pair with this: the **approve modal on `/admin/access-requests.html`** should display the same URL pattern alongside the generated code, so when the operator copies the code to paste into their email client, they can copy the pre-built deep link instead. This closes the loop without SMTP integration.

Bonus (optional): if the applicant pastes an npub in the optional npub field during `/join`, surface the existing-nsec redeem URL (`/admin/login.html`) more prominently on the success screen since we already know they have keys.

## Role boundaries to review

These are principles the user flagged on 2026-05-28 during manual UAT. Both touch authorization across the orchestrator + UI.

### 11. **Labels should NOT be allowed to approve access requests — operator-only.**

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

### 12. **Label and operator roles are separate — operators should not auto-inherit label permissions.**

Today the orchestrator collapses the two with `require_label` accepting both roles (see the table above + every other `Depends(require_label)` call site in `routers/label.py`). Per the principle: an operator is *infrastructure*, a label is *content/business*. The same pubkey shouldn't have both unless explicitly assigned each.

Status check:
- DB: separate (`node_operators` table vs `node_artists.role='label'`) ✅
- Cross-row: a single pubkey can in principle be both an operator AND a label (one row in each table). No constraint prevents it today. Decision needed: forbid it (hard constraint), allow it (no change), or warn (operator UI banner if also a label).
- Permissions: `require_label` admits operators today. To honour the principle, every `Depends(require_label)` would need to be reviewed:
  - For genuinely label-tier endpoints (rosters, roster invites, the label's own artists), should operators *only* access them via an explicit "act as operator" path (e.g. via the operator-only `/api/operator/*` routes)?
  - For operator-only endpoints (sync, IPFS, blossom, node-settings, node-overview) — already gated by `require_operator` ✅
- UI: the sidebar already separates Manage / Label Admin / Infrastructure groups by role.

Things to decide:
- **Hard separation**: a pubkey is exactly one of {artist, label, operator}. The redeem flow already rejects re-redemption with `already_managed_by_other` for artists managed by a different label; would need similar guards for operator-vs-label.
- **Soft separation**: a pubkey can be both, but the UI and API treat them as separate concerns (no role auto-inheritance). Operators wanting label-tier functionality would have to be onboarded as a label too.
- **Status quo**: operators auto-inherit label-tier endpoints — convenient for single-operator nodes but blurs the boundary.

Recommendation: **hard separation** + re-gate label-tier endpoints to `require_label_strict` (label-only, no operator). Operators get parallel operator-tier endpoints for the same actions they need (e.g. operator-side artist-management is already different — they see all artists, the label sees only their roster). Will need to audit each `require_label` call site.

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
