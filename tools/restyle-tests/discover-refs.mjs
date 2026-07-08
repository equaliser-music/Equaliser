// Resolve dynamic route refs from the seeded node → .seed-refs.json
// (artistPubkey, threadId, playlist pubkey+d, draftId). Creates a NIP-51
// playlist as the first seed user if none exists.
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import WebSocket from 'ws';
import { finalizeEvent } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils';
import { authFetch } from './lib/nip98.mjs';

globalThis.WebSocket = WebSocket;
const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.RT_BASE_URL || 'http://localhost';
const RELAY = process.env.RT_RELAY_URL || 'ws://localhost/relay';
const REPO = join(HERE, '..', '..');
const refs = {};

const j = async (u) => (await fetch(BASE + u)).json();

// Artist: prefer Shibuya Crossings
const artists = (await j('/api/cache/artists'));
const alist = Array.isArray(artists) ? artists : artists.artists || [];
const shibuya = alist.find(a => /shibuya/i.test(a.name || '')) || alist[0];
refs.artistPubkey = shibuya?.pubkey;

// Thread: first kind-1 root note
const evs = await j('/api/cache/events?kinds=1&limit=30');
const elist = Array.isArray(evs) ? evs : evs.events || [];
const root = elist.find(e => !(e.tags || []).some(t => t[0] === 'e')) || elist[0];
refs.threadId = root?.id;

// Tracks (for playlist creation)
const tr = await j('/api/cache/tracks/recent?limit=10');
const tracks = Array.isArray(tr) ? tr : tr.tracks || [];

// Playlist: find existing kind 30001, else create as first seed user
const pls = await j('/api/cache/events?kinds=30001&limit=5');
let pl = (Array.isArray(pls) ? pls : pls.events || [])[0];
if (!pl && tracks.length >= 3) {
  const userFile = readdirSync(join(REPO, 'packages', 'users')).find(f => f.endsWith('.json'));
  const user = JSON.parse(readFileSync(join(REPO, 'packages', 'users', userFile), 'utf8'));
  const sk = hexToBytes(user.keys.privateKeyHex);
  const ev = finalizeEvent({
    kind: 30001,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', 'restyle-mix'], ['title', 'Restyle Test Mix'], ['app', 'Equaliser'],
      ...tracks.slice(0, 3).map(t => ['e', t.event_id || t.id])],
    content: '',
  }, sk);
  await new Promise((res, rej) => {
    const ws = new WebSocket(RELAY);
    const t = setTimeout(() => { ws.close(); rej(new Error('relay timeout')); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', ev])));
    ws.on('message', m => { const [ty, , ok, msg] = JSON.parse(m); if (ty === 'OK') { clearTimeout(t); ws.close(); ok ? res() : rej(new Error(msg)); } });
    ws.on('error', rej);
  });
  pl = ev;
  console.log('created seed playlist as', user.profile?.name || userFile);
}
if (pl) {
  refs.playlistPubkey = pl.pubkey;
  refs.playlistD = (pl.tags || []).find(t => t[0] === 'd')?.[1] || 'restyle-mix';
}

// Draft (Shibuya) for edit-release
if (refs.artistPubkey) {
  const backupFile = readdirSync(join(REPO, 'packages', 'artists')).find(f => f.includes('shibuya') && f.endsWith('.json'));
  const backup = JSON.parse(readFileSync(join(REPO, 'packages', 'artists', backupFile), 'utf8'));
  const sk = hexToBytes(backup.keys.privateKeyHex);
  const dr = await authFetch(sk, `${BASE}/api/drafts?pubkey=${backup.keys.publicKeyHex}&status=draft`);
  if (dr.ok) refs.draftId = ((await dr.json()).drafts || [])[0]?.id;
}

writeFileSync(join(HERE, '.seed-refs.json'), JSON.stringify(refs, null, 2));
console.log('refs:', refs);
