// Functional smoke tests — run AFTER captures (some steps publish events).
// Env: RT_SMOKE=nav,player,social,admin (default all) · RT_THEME
import { selectRoutes, refs } from './pages.mjs';
import { launch, newPage, settle, BASE } from './lib/env.mjs';

const WANT = (process.env.RT_SMOKE || 'nav,player,social,admin').split(',');
const theme = process.env.RT_THEME || null;
const browser = await launch();
const results = [];
const t = (name, fn) => ({ name, fn });

const tests = [];

if (WANT.includes('nav')) tests.push(t('spa-nav', async () => {
  const route = selectRoutes({ pages: 'home' })[0];
  const { context, page, errors } = await newPage(browser, route, { theme });
  await settle(page, route);
  const links = ['/social.html', '/library.html', '/profile.html', '/home.html'];
  for (const href of links) {
    const before = await page.evaluate(() => document.getElementById('eq-page-styles')?.textContent.length || 0);
    await page.click(`.sidebar a[href="${href}"], a[href="${href}"]`, { timeout: 5000 });
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => document.getElementById('eq-page-styles')?.textContent.length || 0);
    const content = await page.locator('#page-content *').count();
    if (content < 3) throw new Error(`nav to ${href}: page-content nearly empty`);
    if (before === after && href !== '/home.html') console.log(`    (note: style length unchanged for ${href})`);
  }
  const errs = errors.filter(e => !e.includes('favicon') && !e.includes('403') && !e.includes('status of 4'));
  await context.close();
  if (errs.length) throw new Error(`console errors during nav: ${errs.slice(0, 2).join(' | ')}`);
}));

if (WANT.includes('player')) tests.push(t('player-hls', async () => {
  const route = selectRoutes({ pages: 'artist' })[0];
  if (!route) throw new Error('artist route unavailable (no ref)');
  const { context, page } = await newPage(browser, route, { theme });
  await settle(page, route);
  let sawManifest = false;
  page.on('request', rq => { if (rq.url().includes('.m3u8') || rq.url().includes('playlist')) sawManifest = true; });
  const play = page.locator('.release-play-btn, .tracklist-item.playable, #page-content [class*="play"]').first();
  await play.scrollIntoViewIfNeeded().catch(() => {});
  await play.click({ timeout: 8000, force: true });
  await page.waitForTimeout(3500);
  // Interactivity proof: persistent player bar becomes present/visible after a play action.
  const barPresent = await page.locator('.eq-player-bar, [class*="player-bar"], #eq-player, [id*="player"]').count();
  await context.close();
  if (barPresent < 1 && !sawManifest) throw new Error('play click produced neither player bar nor manifest fetch');
}));

if (WANT.includes('social')) tests.push(t('social-flows', async () => {
  const route = selectRoutes({ pages: 'social' })[0];
  const { context, page } = await newPage(browser, route, { theme });
  await settle(page, route);
  // Tab switch
  const tabs = page.locator('.feed-tab, .tab, [class*="tab"]');
  if (await tabs.count() >= 2) { await tabs.nth(1).click(); await page.waitForTimeout(800); await tabs.nth(0).click(); await page.waitForTimeout(500); }
  // Composer present in DOM (visibility varies by tab state); feed rendered
  const composerCount = await page.locator('#compose-text, .composer textarea, [contenteditable="true"]').count();
  const feedItems = await page.locator('#page-content [class*="post"], #page-content [class*="note"], #page-content [class*="thread"]').count();
  await context.close();
  if (composerCount < 1) throw new Error('composer element missing from DOM');
  if (feedItems < 1) throw new Error('no feed/thread items rendered');
}));

if (WANT.includes('admin')) tests.push(t('admin-tables', async () => {
  for (const id of ['adm-releases', 'adm-invites', 'adm-dashboard']) {
    const route = selectRoutes({ pages: id })[0];
    const { context, page } = await newPage(browser, route, { theme });
    await settle(page, route);
    const url = page.url();
    const sidebar = await page.locator('.sidebar, [class*="sidebar"]').count();
    const contentKids = await page.locator('.main-content *, .container *, body > *').count();
    await context.close();
    if (/login\.html|redeem\.html/.test(url)) throw new Error(`${id}: bounced to ${url} (auth session not honoured)`);
    if (sidebar < 1) throw new Error(`${id}: admin sidebar did not render`);
    if (contentKids < 5) throw new Error(`${id}: page content nearly empty`);
  }
}));

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`✓ smoke:${name}`); results.push({ name, ok: true }); }
  catch (e) { console.log(`✗ smoke:${name}: ${e.message}`); results.push({ name, ok: false, err: e.message }); failed++; }
}
await browser.close();
console.log(`smoke: ${tests.length - failed}/${tests.length} pass`);
process.exit(failed ? 1 : 0);
