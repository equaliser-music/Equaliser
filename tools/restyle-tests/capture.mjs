// Capture screenshots + structure + computed styles + console errors for routes.
// Env: RT_OUT (output dir, required) · RT_PAGES=id,id · RT_GROUP=client|admin|standalone
//      RT_THEME=classic|signal (sets localStorage before load; harmless pre-refactor)
// Writes per route: <id>.png, <id>.structure.txt, <id>.computed.json, <id>.errors.json
// and a top-level summary.json.
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { selectRoutes } from './pages.mjs';
import { launch, newPage, settle, mask, structureSnapshot, computedStyles, assertKeySelectors } from './lib/env.mjs';

const OUT = process.env.RT_OUT;
if (!OUT) { console.error('RT_OUT required'); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const theme = process.env.RT_THEME || null;
const routes = selectRoutes({ pages: process.env.RT_PAGES || null, group: process.env.RT_GROUP || null });

const browser = await launch();
const summary = { theme, capturedAt: new Date().toISOString(), routes: {} };
let failed = 0;

for (const route of routes) {
  const { context, page, errors } = await newPage(browser, route, { theme });
  const entry = { url: route.url, ok: false };
  try {
    await settle(page, route);
    entry.structure = `${route.id}.structure.txt`;
    writeFileSync(join(OUT, entry.structure), await structureSnapshot(page, route));
    writeFileSync(join(OUT, `${route.id}.computed.json`), JSON.stringify(await computedStyles(page, route), null, 2));
    entry.keySelectorFailures = await assertKeySelectors(page, route);
    await mask(page, route);
    await page.screenshot({ path: join(OUT, `${route.id}.png`), fullPage: true });
    entry.errors = errors;
    entry.ok = entry.keySelectorFailures.length === 0; // console errors evaluated by verify (baseline may have pre-existing ones)
    console.log(`${entry.ok ? '✓' : '✗'} ${route.id}${errors.length ? ` (${errors.length} console/page errors)` : ''}${entry.keySelectorFailures.length ? ' KEYSEL-FAIL' : ''}`);
  } catch (e) {
    entry.error = String(e.message || e);
    entry.errors = errors;
    console.log(`✗ ${route.id}: ${entry.error}`);
    failed++;
  }
  writeFileSync(join(OUT, `${route.id}.errors.json`), JSON.stringify(errors, null, 2));
  summary.routes[route.id] = entry;
  await context.close();
}
await browser.close();
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`capture done: ${routes.length - failed}/${routes.length} routes → ${OUT}`);
process.exit(failed ? 1 : 0);
