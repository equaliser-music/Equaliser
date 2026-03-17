# VPS Security Audit — 2026-03-17

Audit of both Hetzner VPS nodes (CPX22 and CX23). No evidence of compromise found — all processes, users, SSH keys, and crontabs are legitimate. Both servers are under constant SSH brute-force attack.

## Findings

### CRITICAL

#### 1. IPFS API port 5001 publicly exposed (both servers)

Docker bypasses UFW and exposes port 5001 on all interfaces (`0.0.0.0:5001`). The IPFS HTTP API allows anyone to add/remove pins, modify MFS, change IPFS config, and potentially exfiltrate or destroy content.

**Fix:** Bind to localhost in `docker-compose.yml` — inter-container traffic still works via Docker's internal network:
```yaml
ports:
  - "4001:4001"         # P2P swarm (must be public)
  - "127.0.0.1:5001:5001"  # API (localhost only)
```
Also add this to `docker-compose.override.yml` on each VPS.

**Affected:** CPX22, CX23

#### 2. SSH password authentication enabled with no fail2ban (both servers)

`PasswordAuthentication yes` in sshd_config. CPX22 logged 1,107 failed attempts in one hour. CX23 logged 317 from 31 IPs. Root requires key auth (`PermitRootLogin without-password`), but any future user account with a weak password would be instantly compromised.

**Fix (both servers):**
```bash
# Disable password auth
sed -i 's/^#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
echo "PasswordAuthentication no" >> /etc/ssh/sshd_config  # if not already present
systemctl restart sshd

# Install fail2ban as defence-in-depth
apt install -y fail2ban
systemctl enable fail2ban
systemctl start fail2ban
```

**Affected:** CPX22, CX23

### HIGH

#### 3. Port 8080 publicly accessible (CPX22)

The Docker nginx container's port 8080 is exposed on all interfaces, allowing bypass of SSL termination and host-level nginx protections.

**Fix:** Bind to localhost in `docker-compose.override.yml` on CPX22:
```yaml
services:
  web:
    ports:
      - "127.0.0.1:8080:80"
```

**Affected:** CPX22

#### 4. No HTTPS on CX23

All traffic including admin operations transmitted in cleartext. CPX22 has SSL via Let's Encrypt.

**Fix:** Run the SSL setup script for CX23:
```bash
./vps/Hetzner/CX23/deploy.sh --ssl
```
Requires a domain pointed at CX23's IP (46.225.52.198), or use the existing `setup-ssl.sh`.

**Affected:** CX23

### MEDIUM

#### 5. No security headers in nginx (both servers)

Missing standard security headers. CPX22's `shibuyacrossings.com` config has some, but `equaliser.app` does not. CX23 has none.

**Fix:** Add to each nginx server block:
```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
# server_tokens off;  # in http block
```

**Affected:** CPX22, CX23

#### 6. TLSv1 and TLSv1.1 enabled (CPX22)

Deprecated and insecure TLS versions still allowed in nginx SSL config.

**Fix:** In nginx SSL config:
```nginx
ssl_protocols TLSv1.2 TLSv1.3;
```

**Affected:** CPX22

#### 7. Pending system updates (both servers)

CPX22: 13 packages including kernel and Docker. CX23: 3 packages including nftables security update.

**Fix (both servers):**
```bash
apt update && apt upgrade -y
reboot  # if kernel updated
```

**Affected:** CPX22, CX23

#### 8. Nginx leaks version (both servers)

`server_tokens` not disabled — response headers expose nginx version.

**Fix:** Add to nginx `http` block:
```nginx
server_tokens off;
```

**Affected:** CPX22, CX23

### LOW

#### 9. No HTTP rate limiting

API endpoints have no request throttling. A malicious client could flood upload or publish endpoints.

**Fix:** Add to nginx config:
```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

location /api/ {
    limit_req zone=api burst=20 nodelay;
    # ... existing proxy_pass
}
```

**Affected:** CPX22, CX23

#### 10. IPFS swarm port (4001) open to all

Could be restricted to known peers or rate-limited if abuse is detected. Low priority — IPFS needs this for content discovery.

**Affected:** CPX22, CX23

## Task Checklist

### Immediate (do now)

- [x] **Both servers:** Disable SSH password authentication (done 2026-03-17)
- [x] **Both servers:** Install fail2ban (done 2026-03-17)
- [x] **Both servers:** Bind IPFS API port 5001 to localhost in docker-compose (done 2026-03-17)
- [x] **Both servers:** Bind web port 8080 to localhost in docker-compose override (done 2026-03-17, both servers)

### Soon (this week)

- [ ] **CX23:** Set up HTTPS/SSL with Let's Encrypt
- [ ] **Both servers:** Run `apt update && apt upgrade`
- [ ] **Both servers:** Add security headers to nginx configs
- [ ] **CPX22:** Remove TLSv1/TLSv1.1 from SSL config
- [ ] **Both servers:** Disable nginx server_tokens

### Later (backlog)

- [ ] **Both servers:** Add HTTP rate limiting to nginx
- [ ] **Both servers:** Consider restricting IPFS swarm port to known peers
- [ ] **Both servers:** Set up log monitoring/alerting for brute-force patterns
- [ ] **Both servers:** Reduce SSH `MaxAuthTries` from 6 to 3
