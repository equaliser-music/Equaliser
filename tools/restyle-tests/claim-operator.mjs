// Claim the local node's first-operator slot with the test identity (idempotent),
// so admin pages are capturable. Usage: node claim-operator.mjs [baseUrl]
import { execSync } from 'child_process';
import { testIdentity, skBytes } from './lib/identity.mjs';
import { authFetch } from './lib/nip98.mjs';

const BASE = process.argv[2] || process.env.RT_BASE_URL || 'http://localhost';
const id = testIdentity();
const sk = skBytes(id);

// Already an operator? (whoami is the cheapest idempotency probe)
const who = await authFetch(sk, `${BASE}/api/auth/whoami`);
if (who.ok) {
  const j = await who.json();
  if (j.role === 'operator') { console.log(`already operator: ${id.npub}`); process.exit(0); }
}

let token = '';
try {
  token = execSync('docker exec equaliser-relay cat /data/setup-token.txt', { encoding: 'utf8' }).trim();
} catch { /* fall through */ }
if (!token) { console.error('no setup token available (node already claimed by a different identity?)'); process.exit(1); }

const body = JSON.stringify({ token, name: 'Restyle Test Operator' });
const res = await authFetch(sk, `${BASE}/api/access/claim-operator`, { method: 'POST', body });
const text = await res.text();
if (!res.ok) { console.error(`claim failed ${res.status}: ${text}`); process.exit(1); }
console.log(`claimed operator: ${id.npub}`);

const verify = await authFetch(sk, `${BASE}/api/auth/whoami`);
const vj = await verify.json();
if (vj.role !== 'operator') { console.error(`whoami says role=${vj.role} — claim did not stick`); process.exit(1); }
console.log('whoami verified: operator');
