// Test identity management for the restyle harness.
// Generates (once) and loads a dedicated throwaway identity used as the
// node operator + capture session across all restyle tests.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const HERE = dirname(fileURLToPath(import.meta.url));
const ID_FILE = join(HERE, '..', '.test-identity.json');
const THROWAWAY_FILE = join(HERE, '..', '.throwaway-identity.json');

function createIdentity(name) {
  const sk = generateSecretKey();
  const skHex = bytesToHex(sk);
  const pk = getPublicKey(sk);
  return {
    name,
    skHex,
    publicKey: pk,
    nsec: nip19.nsecEncode(sk),
    npub: nip19.npubEncode(pk),
    createdAt: Date.now(),
  };
}

function loadOrCreate(file, name) {
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const id = createIdentity(name);
  writeFileSync(file, JSON.stringify(id, null, 2));
  return id;
}

/** Primary identity: claimed as node operator; used for captures. */
export function testIdentity() { return loadOrCreate(ID_FILE, 'restyle-operator'); }
/** Secondary identity: used by smoke tests that publish (posts/likes) so capture data stays pristine. */
export function throwawayIdentity() { return loadOrCreate(THROWAWAY_FILE, 'restyle-throwaway'); }
export function skBytes(id) { return hexToBytes(id.skHex); }
