# Security Review — Equaliser VPS Deployment

**Date:** 2026-03-12
**Scope:** Two Hetzner VPS nodes (CPX22 + CX23) running Equaliser content nodes
**Branch:** `equaliser-relay`

---

## Critical

### 1. No API Authentication

**Files:** `content_node/orchestrator/api/routers/tracks.py`, `drafts.py`, `packages.py`

All orchestrator endpoints accept `artist_pubkey` as a form/query parameter with zero verification that the caller owns that key. Anyone can:

- Upload tracks as any artist
- Read, modify, or delete any artist's drafts
- Import/export packages for any identity

**Risk:** Complete API takeover — full content manipulation by unauthenticated attackers.

**Recommendation:** Implement NIP-98 HTTP Auth — require a signed NOSTR event proving pubkey ownership before any write operation. Add server-side middleware that validates the signature before routing to handlers.

---

### ~~2. Private Key Accepted Over HTTP~~ FIXED

**Status:** Resolved — `artist_privkey` parameter removed from upload endpoint. Was dead code (never used in `process_track()`). Client-side signing is the established pattern.

---

### ~~3. Unrestricted CORS~~ FIXED

**Status:** Resolved — CORS origins now read from `ALLOWED_ORIGINS` env var. Defaults to `http://localhost,http://localhost:80` for local dev. VPS overrides set to `https://equaliser.app` (CPX22) and `http://46.225.52.198` (CX23).

---

### ~~4. Hardcoded Database Credentials~~ FIXED

**Status:** Resolved — DB credentials use `${POSTGRES_PASSWORD:-equaliser}` syntax with defaults for local dev. `.env.example` template created. `.env` files excluded from git. VPS overrides also updated. Production VPS nodes should create a `.env` file with strong passwords.

---

## High

### 5. No Upload Rate Limiting or Size Validation

**Files:** `content_node/web/nginx.conf` (line 18), `content_node/orchestrator/api/routers/tracks.py`

- Nginx allows `client_max_body_size 500M` with no rate limiting
- Track upload only checks `content_type.startswith("audio/")` — no file size cap, no filename sanitization

**Risk:** Disk exhaustion via spam uploads, malicious file uploads, path traversal.

**Recommendation:**
- Add `limit_req_zone` in nginx for upload endpoints
- Validate file size server-side (reject files above a reasonable threshold)
- Sanitize filenames (strip path components, restrict characters)
- Consider virus scanning for uploaded files

---

### 6. Private Keys in Browser sessionStorage

**File:** `content_node/orchestrator/js/session.js`

Artist nsec (private key) is stored in `sessionStorage` for tab-scoped persistence. Any XSS vulnerability on the admin pages can read `sessionStorage` and exfiltrate signing keys.

**Risk:** XSS attack steals artist signing keys permanently. Combined with missing CSP headers, this is high risk.

**Recommendation:** Migrate to NIP-07 browser extension authentication (keys never leave the extension). If that's not feasible, store keys in memory only (JS variable, cleared on navigation) and re-prompt on each session.

---

### 7. Client-Side Only Session Validation

**File:** `content_node/orchestrator/js/session.js` (lines 177–185)

`requireSession()` checks whether a session exists in the browser but the server never validates identity. API requests include `pubkey` as a parameter that the server trusts without verification.

**Risk:** Attackers can forge any pubkey in API requests — the server has no way to distinguish legitimate from forged requests.

**Recommendation:** Implement server-side session validation. Options:
- Challenge-response: server issues a nonce, client signs it, server verifies
- NIP-98: signed HTTP auth events with timestamp and URL binding
- JWT tokens issued after initial signature verification

---

## Medium

### 8. IPFS Swarm Port Open to Internet

**Files:** `vps/Hetzner/CPX22/setup.sh`, `vps/Hetzner/CX23/setup.sh`

```bash
ufw allow 4001/tcp  comment 'IPFS swarm'
```

The IPFS swarm port is open to all traffic on both VPS nodes.

**Risk:** DHT pollution, connection flooding, amplification attacks, resource exhaustion from unwanted peer connections.

**Recommendation:** If public IPFS discovery isn't required, restrict port 4001 to known peer IPs only. If public access is needed, consider running IPFS in a private network mode with a shared swarm key, or rate-limit connections at the firewall level.

---

### 9. Missing Security Headers

**Files:** `content_node/web/nginx.conf`, `vps/Hetzner/CPX22/nginx/sites-available/equaliser.app`

Neither the container nginx nor the host nginx configs include standard security headers.

**Missing headers:**
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Content-Security-Policy` (script-src, style-src, connect-src)
- `Strict-Transport-Security` (HSTS)
- `Referrer-Policy: strict-origin-when-cross-origin`

**Risk:** Increased exposure to XSS, clickjacking, and MIME-sniffing attacks.

**Recommendation:** Add these headers to the host-level nginx config (applies to all responses):

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:; img-src 'self' blob: data:;" always;
```

---

### 10. Blossom Dashboard Exposed

**File:** `content_node/config/blossom/config.yml`

The Blossom dashboard is enabled (`enabled: true`). If proxied through nginx without additional auth, anyone can browse and manage stored blobs.

**Risk:** Unauthorised access to blob management — view, delete, or overwrite stored content.

**Recommendation:** Either disable the dashboard in production (`enabled: false`) or add HTTP basic auth in the nginx location block that proxies to Blossom.

---

### 11. IPFS Gateway is Publicly Readable

**File:** `content_node/web/nginx.conf` (lines 95–118)

The `/ipfs/` location proxies directly to the IPFS gateway with no access control. All pinned content is readable to anyone who knows (or guesses) a CID.

**Risk:** Content that should be gated (future encrypted/paid content) is accessible via direct CID access. Information leakage of all stored content.

**Recommendation:** For now this is acceptable (all content is public). When paid/encrypted content is added, restrict the IPFS gateway to internal access only and serve content through the orchestrator with access control.

---

### 12. No Security Event Logging

**Files:** All orchestrator routers

No logging of:
- Failed authentication attempts (because auth doesn't exist yet)
- Upload activity (who uploaded what, when, from which IP)
- Draft modifications or deletions
- Suspicious request patterns

**Risk:** No ability to detect, investigate, or respond to abuse.

**Recommendation:** Add structured logging for all write operations (upload, edit, delete, publish) with timestamp, IP, claimed pubkey, and outcome. Ship logs to a persistent store. Set up alerts for anomalies (e.g., high upload volume from single IP).

---

## Low

### 13. No Backup Encryption

No documented backup/restore procedures. No encryption for database dumps, IPFS data exports, or relay snapshots.

**Risk:** If backups are created and stored externally, they could be accessed by unauthorised parties.

**Recommendation:** Document backup procedures. Encrypt backups at rest (GPG or age). Store off-site with restricted access.

---

### 14. No Certificate Pinning for Peer Relays

**File:** `vps/Hetzner/CPX22/docker-compose.override.yml`

WebSocket connections to peer relays use standard TLS with no certificate pinning.

**Risk:** Man-in-the-middle attacks on relay-to-relay communication (low probability with valid TLS certs).

**Recommendation:** Low priority — standard TLS is adequate for now. Consider certificate pinning if relay network grows or operates in adversarial environments.

---

### 15. SSH Key Paths in Deploy Scripts

**Files:** `vps/Hetzner/CPX22/deploy.sh`, `tools/deploy-vps.sh`

SSH key file paths are hardcoded in deployment scripts committed to version control.

**Risk:** Reveals SSH key locations and server connection details.

**Recommendation:** Use SSH config files (`~/.ssh/config`) with host aliases instead of hardcoded paths. Reference hosts by alias in scripts.

---

## Threat Model Summary

| Threat | Likelihood | Impact | Current Mitigation |
|--------|-----------|--------|-------------------|
| Unauthorised content upload | Very High | High | None — API is open |
| Content defacement/deletion | Very High | High | None — no auth on write/delete |
| Disk exhaustion via spam | High | High | 500M nginx limit only |
| XSS stealing artist keys | Medium | Critical | None — keys in sessionStorage, no CSP |
| Database access via compromised container | Medium | High | Credentials externalised to `.env` (defaults still weak for local dev) |
| IPFS node abuse | Low–Medium | Medium | Open swarm port |
| Peer relay MITM | Low | Medium | Standard TLS |

---

## Priority Action Plan

### Immediate (before any public use)

1. **Add API authentication** — NIP-98 HTTP Auth requiring signed events for all write endpoints
2. ~~**Remove `artist_privkey` parameter**~~ — DONE
3. ~~**Restrict CORS**~~ — DONE (`ALLOWED_ORIGINS` env var)
4. **Add security headers** to nginx configs

### Short-term (next development cycle)

5. ~~**Move DB credentials**~~ — DONE (`.env` with `${VAR:-default}` syntax)
6. **Add upload rate limiting** via nginx `limit_req_zone`
7. **Add server-side session validation** (challenge-response or NIP-98)
8. **Add structured logging** for all write operations

### Medium-term

9. **Migrate to NIP-07 auth** — eliminate private key storage in browser
10. **Restrict IPFS swarm port** to known peers
11. **Disable Blossom dashboard** in production or add auth
12. **Document and encrypt backups**

### Before paid/encrypted content

13. **Restrict IPFS gateway** — serve gated content through orchestrator only
14. **Implement proper access control** for content delivery
15. **Audit all endpoints** for authorisation checks
