// Onboard artist identities from backup JSONs onto the local strict-mode node:
// operator (test identity) mints an artist invite code, artist redeems it.
// Idempotent: skips identities that already hold a role.
// Usage: node seed-artists.mjs <backup.json> [<backup.json> ...]
import { readFileSync } from 'fs';
import { hexToBytes } from '@noble/hashes/utils';
import { testIdentity, skBytes } from './lib/identity.mjs';
import { authFetch } from './lib/nip98.mjs';

const BASE = process.env.RT_BASE_URL || 'http://localhost';
const op = testIdentity();
const opSk = skBytes(op);

for (const file of process.argv.slice(2)) {
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  const name = backup.profile?.name || 'Artist';
  const artistSk = hexToBytes(backup.keys.privateKeyHex);

  const who = await authFetch(artistSk, `${BASE}/api/auth/whoami`);
  if (who.ok) { console.log(`✓ ${name}: already has role '${(await who.json()).role}'`); continue; }

  // Operator mints a standalone artist invite code
  const mint = await authFetch(opSk, `${BASE}/api/label/invite-codes`, {
    method: 'POST',
    body: JSON.stringify({ target_role: 'artist', target_relationship_type: 'self' }),
  });
  if (!mint.ok) { console.error(`✗ ${name}: mint failed ${mint.status}: ${await mint.text()}`); process.exit(1); }
  const mintJson = await mint.json();
  const code = mintJson.code || mintJson.invite_code || mintJson.invite?.code;
  if (!code) { console.error(`✗ ${name}: no code in mint response: ${JSON.stringify(mintJson)}`); process.exit(1); }

  // Artist redeems it
  const redeem = await authFetch(artistSk, `${BASE}/api/access/redeem`, {
    method: 'POST',
    body: JSON.stringify({ code, display_name: name }),
  });
  if (!redeem.ok) { console.error(`✗ ${name}: redeem failed ${redeem.status}: ${await redeem.text()}`); process.exit(1); }
  console.log(`✓ ${name}: onboarded as artist (${backup.keys.npub.slice(0, 16)}…)`);
}
