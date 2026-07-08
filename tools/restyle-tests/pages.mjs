// Route manifest — single source of truth for capture/verify/smoke.
// auth: 'anon' | 'listener' (throwaway id, no node role) | 'operator' (test identity, claimed)
// waitFor: selectors that must exist before capture; keySelectors: {sel: minCount} asserted present.
// maskSelectors: dynamic regions hidden (visibility:hidden) before screenshots.
// refs: values resolved from .seed-refs.json (written by discover-refs.mjs).
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REFS_FILE = join(HERE, '.seed-refs.json');
export const refs = existsSync(REFS_FILE) ? JSON.parse(readFileSync(REFS_FILE, 'utf8')) : {};

const MASK_COMMON = ['.loading-spinner', 'time', '[data-eq-mask]'];
const MASK_TIMES = ['.post-time', '.reply-time', '.quoted-post-time', '.note-time', '.msg-time', '.activity-time'];

function r(id, url, auth, opts = {}) {
  return {
    id, url, auth,
    group: opts.group || 'client',
    waitFor: opts.waitFor || ['body'],
    keySelectors: opts.keySelectors || {},
    maskSelectors: [...MASK_COMMON, ...(opts.mask || [])],
    pixelTolerancePct: opts.tol ?? 0.3,
    waitExtraMs: opts.waitExtraMs || 0,
    skipIfNoRef: opts.needsRef || null,
  };
}

export const routes = [
  // ── Client SPA (served through app.html shell) ────────────────────────────
  r('home',      '/home.html',    'listener', { waitFor: ['#page-content .main-content'], waitExtraMs: 2000, keySelectors: { '.album-card, .release-card, [class*="album"]': 1 }, mask: MASK_TIMES }),
  r('artist',    `/artist.html?npub=${refs.artistNpub || ''}`, 'listener', { needsRef: 'artistNpub', waitFor: ['#page-content'], mask: MASK_TIMES, waitExtraMs: 2500, keySelectors: { '[class*="track"], [class*="release"], [class*="album"]': 1 } }),
  r('social',    '/social.html',  'listener', { waitFor: ['#page-content'], mask: MASK_TIMES, waitExtraMs: 1500 }),
  r('thread',    `/thread.html?id=${refs.threadId || ''}`, 'listener', { needsRef: 'threadId', waitFor: ['#page-content'], mask: MASK_TIMES }),
  r('profile',   '/profile.html', 'listener', { waitFor: ['#page-content'], mask: MASK_TIMES }),
  r('user',      `/user.html?npub=${refs.artistNpub || ''}`, 'listener', { needsRef: 'artistNpub', waitFor: ['#page-content'], mask: MASK_TIMES, waitExtraMs: 1500 }),
  r('messages',  '/messages.html', 'listener', { waitFor: ['#page-content'], mask: MASK_TIMES }),
  r('library',   '/library.html', 'listener', { waitFor: ['#page-content'] }),
  r('playlist',  `/playlist.html?pubkey=${refs.playlistPubkey || ''}&d=${refs.playlistD || ''}`, 'listener', { needsRef: 'playlistPubkey', waitFor: ['#page-content'], mask: MASK_TIMES }),
  r('settings',  '/settings.html', 'listener', { waitFor: ['#page-content'] }),
  // ── Client standalone pages ───────────────────────────────────────────────
  r('index',      '/index.html',      'anon', { group: 'standalone' }),
  r('login',      '/login.html',      'anon', { group: 'standalone' }),
  r('join',       '/join',            'anon', { group: 'standalone' }),
  r('onboarding', '/onboarding.html', 'anon', { group: 'standalone' }),
  // ── Admin (operator session) ──────────────────────────────────────────────
  r('adm-dashboard',   '/admin/dashboard.html',        'artist', { group: 'admin', mask: [...MASK_TIMES, '.stat-value'], waitExtraMs: 2000 }),
  r('adm-releases',    '/admin/releases.html',         'artist', { group: 'admin', waitExtraMs: 2500, keySelectors: { '[class*="release"], [class*="track"], [class*="draft"], tbody tr': 1 }, mask: MASK_TIMES }),
  r('adm-editrelease', `/admin/edit-release.html?id=${refs.draftId || ''}`, 'artist', { group: 'admin', needsRef: 'draftId', mask: MASK_TIMES, waitExtraMs: 2000 }),
  r('adm-upload',      '/admin/upload.html',           'artist', { group: 'admin' }),
  r('adm-profile',     '/admin/profile.html',          'artist', { group: 'admin' }),
  r('adm-settings',    '/admin/settings.html',         'artist', { group: 'admin' }),
  r('adm-artists',     '/admin/artist-management.html','operator', { group: 'admin', keySelectors: { 'table, .data-table': 1 } }),
  r('adm-access',      '/admin/access-requests.html',  'operator', { group: 'admin' }),
  r('adm-invites',     '/admin/invite-codes.html',     'operator', { group: 'admin' }),
  r('adm-delegations', '/admin/delegations.html',      'artist', { group: 'admin' }),
  r('adm-overview',    '/admin/node-overview.html',    'operator', { group: 'admin', mask: ['.stat-value', '.health-status', ...MASK_TIMES] }),
  r('adm-sync',        '/admin/sync-manager.html',     'operator', { group: 'admin', mask: ['.stat-value', 'td', ...MASK_TIMES], tol: 1.0 }),
  r('adm-ipfs',        '/admin/ipfs-storage.html',     'operator', { group: 'admin', mask: ['.stat-value', '.cid', 'td', ...MASK_TIMES], tol: 1.0 }),
  r('adm-blossom',     '/admin/blossom-config.html',   'operator', { group: 'admin', mask: ['.stat-value'] }),
  r('adm-usercache',   '/admin/user-cache.html',       'operator', { group: 'admin', mask: ['td', ...MASK_TIMES], tol: 1.0 }),
  r('adm-nodesettings','/admin/node-settings.html',    'operator', { group: 'admin' }),
  r('adm-login',       '/admin/login.html',            'anon',     { group: 'admin' }),
  r('adm-redeem',      '/admin/redeem.html',           'listener',     { group: 'admin' }),
  // setup.html intentionally excluded: node is claimed, page redirects.
];

export function selectRoutes({ pages = null, group = null } = {}) {
  let list = routes;
  if (group) list = list.filter(x => x.group === group);
  if (pages) { const want = new Set(pages.split(',').map(s => s.trim())); list = list.filter(x => want.has(x.id)); }
  return list.filter(x => !x.skipIfNoRef || refs[x.skipIfNoRef]);
}
