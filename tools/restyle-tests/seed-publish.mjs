// Publish seed content: each artist's Kind 0 profile (via relay WS) and all
// imported drafts (release → sign → publish via API). Idempotent-ish: drafts
// are deleted on publish; re-runs no-op when no drafts remain.
// Usage: node seed-publish.mjs <backup.json> [...]
import { readFileSync } from 'fs';
import WebSocket from 'ws';
import { finalizeEvent } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils';
import { authFetch } from './lib/nip98.mjs';

globalThis.WebSocket = WebSocket;
const BASE = process.env.RT_BASE_URL || 'http://localhost';
const RELAY = process.env.RT_RELAY_URL || 'ws://localhost/relay';

function publishWS(event) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY);
    const timer = setTimeout(() => { ws.close(); reject(new Error('relay timeout')); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.on('message', (m) => {
      const [type, , ok, msg] = JSON.parse(m.toString());
      if (type === 'OK') { clearTimeout(timer); ws.close(); ok ? resolve() : reject(new Error(`relay rejected: ${msg}`)); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

for (const file of process.argv.slice(2)) {
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  const sk = hexToBytes(backup.keys.privateKeyHex);
  const pub = backup.keys.publicKeyHex;
  const name = backup.profile?.name || 'Artist';

  // 1. Kind 0 profile (tagged app + user-type artist, matching platform convention)
  const profile = { name, about: backup.profile?.bio || '', ...(backup.profile?.location ? { location: backup.profile.location } : {}) };
  const k0 = finalizeEvent({
    kind: 0, created_at: Math.floor(Date.now() / 1000),
    tags: [['app', 'Equaliser'], ['user-type', 'artist']],
    content: JSON.stringify(profile),
  }, sk);
  await publishWS(k0);
  console.log(`✓ ${name}: profile published`);

  // 2. Release + publish every draft
  const listRes = await authFetch(sk, `${BASE}/api/drafts?pubkey=${pub}&status=draft`);
  if (!listRes.ok) { console.error(`✗ ${name}: list drafts ${listRes.status}: ${await listRes.text()}`); process.exit(1); }
  const { drafts = [] } = await listRes.json();
  console.log(`  ${drafts.length} draft(s) to publish`);
  for (const d of drafts) {
    const rel = await authFetch(sk, `${BASE}/api/drafts/${d.id}/release`, { method: 'POST', body: JSON.stringify({}) });
    if (!rel.ok) { console.error(`  ✗ release ${d.title}: ${rel.status} ${await rel.text()}`); process.exit(1); }
    const { unsigned_event } = await rel.json();
    const signed = finalizeEvent(unsigned_event, sk);
    const pubRes = await authFetch(sk, `${BASE}/api/tracks/publish`, {
      method: 'POST',
      body: JSON.stringify({ signed_event: signed, draft_id: d.id }),
    });
    if (!pubRes.ok) { console.error(`  ✗ publish ${d.title}: ${pubRes.status} ${await pubRes.text()}`); process.exit(1); }
    console.log(`  ✓ published: ${d.title}`);
  }
}
console.log('seed-publish complete');
