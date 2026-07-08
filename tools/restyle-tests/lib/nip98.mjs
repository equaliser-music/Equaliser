// NIP-98 HTTP Auth helper — mirrors common/js/session.js authFetch():
// kind 27235 event with u/method tags (+ payload sha256 tag for bodies),
// base64-encoded in the Authorization: Nostr header.
import { finalizeEvent } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export function nip98Header(skBytes, url, method, bodyString = null) {
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];
  if (bodyString != null && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
    tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(bodyString)))]);
  }
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, skBytes);
  return 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64');
}

/** fetch() with NIP-98 auth. body must be a string (JSON.stringify it yourself) or null. */
export async function authFetch(skBytes, url, { method = 'GET', body = null, headers = {} } = {}) {
  const h = { ...headers, Authorization: nip98Header(skBytes, url, method, body) };
  if (body != null && !h['Content-Type']) h['Content-Type'] = 'application/json';
  return fetch(url, { method, body, headers: h });
}
