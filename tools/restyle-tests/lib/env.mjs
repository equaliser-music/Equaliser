// Browser environment: deterministic page setup, session injection, settle & mask.
import { chromium } from 'playwright';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { testIdentity, throwawayIdentity } from './identity.mjs';

const REFS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.seed-refs.json');
const REFS = existsSync(REFS_FILE) ? JSON.parse(readFileSync(REFS_FILE, 'utf8')) : {};

export const BASE = process.env.RT_BASE_URL || 'http://localhost';
export const VIEWPORT = { width: 1440, height: 900 };

const KILL_MOTION_CSS = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}`;

export async function launch() {
  return chromium.launch({ headless: true });
}

let _artistBackup = null;
function artistBackup() {
  if (_artistBackup) return _artistBackup;
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'artists');
  const f = readdirSync(dir).find(x => x.includes('shibuya') && x.endsWith('.json'));
  _artistBackup = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return _artistBackup;
}

function sessionFor(auth) {
  if (auth === 'anon') return null;
  if (auth === 'artist') {
    const b = artistBackup();
    return {
      type: 'nsec', nsec: b.keys.nsec, publicKey: b.keys.publicKeyHex, npub: b.keys.npub,
      createdAt: Date.now(), lastActivity: Date.now(),
      role: 'artist', managedArtists: [b.keys.publicKeyHex], selectedArtistPubkey: b.keys.publicKeyHex,
    };
  }
  const id = auth === 'operator' ? testIdentity() : throwawayIdentity();
  const s = {
    type: 'nsec',
    nsec: id.nsec,
    publicKey: id.publicKey,
    npub: id.npub,
    createdAt: Date.now(),
    lastActivity: Date.now(), // must be fresh: session.js rejects ≥30min idle
  };
  if (auth === 'operator') {
    s.role = 'operator';
    // Select the seeded artist so admin content pages (releases/dashboard/edit)
    // render real catalogue rather than the operator's empty lists.
    const artist = REFS.artistPubkey || id.publicKey;
    s.managedArtists = [artist];
    s.selectedArtistPubkey = artist;
  }
  return s;
}

/** Fresh context+page per route (isolates BroadcastChannel + storage). */
export async function newPage(browser, route, { theme = null } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const session = sessionFor(route.auth);
  await context.addInitScript(({ s, t }) => {
    if (s) sessionStorage.setItem('equaliser_session', JSON.stringify(s));
    if (t) localStorage.setItem('equaliser_theme', t);
  }, { s: session, t: theme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('requestfailed', rq => { const u = rq.url(); if (u.startsWith(BASE)) errors.push(`requestfailed: ${u} ${rq.failure()?.errorText}`); });
  return { context, page, errors };
}

export async function settle(page, route) {
  await page.goto(BASE + route.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.addStyleTag({ content: KILL_MOTION_CSS });
  for (const sel of route.waitFor) {
    await page.waitForSelector(sel, { timeout: 15000 }).catch(() => { throw new Error(`waitFor failed: ${sel} on ${route.id}`); });
  }
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  // All images settled (loaded or errored/hidden by onerror fallbacks)
  await page.waitForFunction(() => [...document.images].every(i => i.complete), { timeout: 15000 }).catch(() => {});
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400 + (route.waitExtraMs || 0));
}

export async function mask(page, route) {
  const sels = route.maskSelectors.join(',');
  if (sels) await page.addStyleTag({ content: `${sels}{visibility:hidden!important}` });
  await page.waitForTimeout(100);
}

/** Serialized structural snapshot: tag#id.classes tree; style attr as sorted property-name list. */
export async function structureSnapshot(page, route) {
  const rootSel = route.group === 'client' ? '#page-content' : 'body';
  return page.evaluate(({ rootSel, volatile }) => {
    const strip = new Set(volatile);
    const root = document.querySelector(rootSel) || document.body;
    const lines = [];
    (function walk(el, depth) {
      if (el.nodeType !== 1) return;
      if (['SCRIPT', 'STYLE', 'LINK', 'META'].includes(el.tagName)) return;
      const cls = [...el.classList].filter(c => !strip.has(c)).sort().join('.');
      const styleProps = el.getAttribute('style')
        ? [...new Set(el.getAttribute('style').split(';').map(s => s.split(':')[0].trim()).filter(Boolean))].sort().join(',')
        : '';
      lines.push('  '.repeat(depth) + el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (cls ? `.${cls}` : '') + (styleProps ? ` [style:${styleProps}]` : ''));
      for (const c of el.children) walk(c, depth + 1);
    })(root, 0);
    return lines.join('\n');
  }, { rootSel, volatile: ['active', 'playing', 'open', 'selected', 'current', 'loading', 'visible', 'show', 'hover'] });
}

/** Computed styles for key selectors (first match each) — cosmetic property set, for failure localization. */
export async function computedStyles(page, route) {
  const sels = Object.keys(route.keySelectors || {});
  const universal = ['body', '.btn', '.card', 'h1', 'h2', 'a'];
  return page.evaluate((allSels) => {
    const PROPS = ['color', 'background-color', 'background-image', 'border', 'border-radius', 'box-shadow', 'font-family', 'font-size', 'font-weight', 'text-transform', 'letter-spacing', 'backdrop-filter', 'filter'];
    const out = {};
    for (const sel of allSels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const cs = getComputedStyle(el);
      out[sel] = Object.fromEntries(PROPS.map(p => [p, cs.getPropertyValue(p)]));
    }
    return out;
  }, [...new Set([...sels, ...universal])]);
}

export async function assertKeySelectors(page, route) {
  const failures = [];
  for (const [sel, min] of Object.entries(route.keySelectors || {})) {
    const n = await page.locator(sel).count();
    if (n < min) failures.push(`keySelector ${sel}: found ${n} < ${min}`);
  }
  return failures;
}
