// Verify current state against a baseline set: pixel diff + structure diff +
// console-error regression + keySelector assertions.
// Env: RT_BASELINE (dir) · RT_CURRENT (dir with fresh capture; if absent, run capture first)
//      RT_PAGES / RT_GROUP filters · RT_MODE=pixel|structure|both (default both)
// Output: per-route verdicts, diff PNGs into RT_CURRENT/diff/, exit 1 on any failure.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { selectRoutes } from './pages.mjs';

const require = createRequire(import.meta.url);
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');

const BASE_DIR = process.env.RT_BASELINE;
const CUR_DIR = process.env.RT_CURRENT;
const MODE = process.env.RT_MODE || 'both';
if (!BASE_DIR || !CUR_DIR) { console.error('RT_BASELINE and RT_CURRENT required'); process.exit(1); }
mkdirSync(join(CUR_DIR, 'diff'), { recursive: true });

const routes = selectRoutes({ pages: process.env.RT_PAGES || null, group: process.env.RT_GROUP || null });
const report = [];
let failures = 0;

function loadJSON(p, fallback) { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback; }

for (const route of routes) {
  const v = { id: route.id, pixel: 'skip', structure: 'skip', errors: 'ok', notes: [] };

  // Console-error regression: fail on errors not present in baseline
  const baseErrs = new Set(loadJSON(join(BASE_DIR, `${route.id}.errors.json`), []).map(e => e.replace(/\d+/g, 'N')));
  const curErrs = loadJSON(join(CUR_DIR, `${route.id}.errors.json`), []);
  const newErrs = curErrs.filter(e => !baseErrs.has(e.replace(/\d+/g, 'N')));
  if (newErrs.length) { v.errors = 'FAIL'; v.notes.push(`new errors: ${newErrs.slice(0, 3).join(' | ')}`); }

  // Structure
  if (MODE !== 'pixel') {
    const bs = join(BASE_DIR, `${route.id}.structure.txt`), cs = join(CUR_DIR, `${route.id}.structure.txt`);
    if (existsSync(bs) && existsSync(cs)) {
      const a = readFileSync(bs, 'utf8'), b = readFileSync(cs, 'utf8');
      if (a === b) v.structure = 'ok';
      else {
        v.structure = 'FAIL';
        const al = a.split('\n'), bl = b.split('\n');
        for (let i = 0; i < Math.max(al.length, bl.length); i++) {
          if (al[i] !== bl[i]) { v.notes.push(`structure diff @line ${i + 1}:\n  -${al[i] ?? '(none)'}\n  +${bl[i] ?? '(none)'}`); break; }
        }
        v.notes.push(`structure line counts: base=${al.length} cur=${bl.length}`);
      }
    } else v.notes.push('structure snapshot missing on one side');
  }

  // Pixel
  if (MODE !== 'structure') {
    const bp = join(BASE_DIR, `${route.id}.png`), cp = join(CUR_DIR, `${route.id}.png`);
    if (existsSync(bp) && existsSync(cp)) {
      const img1 = PNG.sync.read(readFileSync(bp));
      const img2 = PNG.sync.read(readFileSync(cp));
      if (img1.width !== img2.width || img1.height !== img2.height) {
        v.pixel = 'FAIL';
        v.notes.push(`dimensions differ: base ${img1.width}x${img1.height} vs cur ${img2.width}x${img2.height} (layout change)`);
      } else {
        const diff = new PNG({ width: img1.width, height: img1.height });
        const n = pixelmatch(img1.data, img2.data, diff.data, img1.width, img1.height, { threshold: 0.12 });
        const pct = (n / (img1.width * img1.height)) * 100;
        v.pixelPct = +pct.toFixed(4);
        if (pct > route.pixelTolerancePct) {
          v.pixel = 'FAIL';
          writeFileSync(join(CUR_DIR, 'diff', `${route.id}.png`), PNG.sync.write(diff));
          // bounding boxes of diff clusters (coarse 40px grid)
          const cell = 40, cols = Math.ceil(img1.width / cell), grid = new Set();
          for (let y = 0; y < img1.height; y++) for (let x = 0; x < img1.width; x++) {
            const i = (y * img1.width + x) * 4;
            if (diff.data[i] === 255 && diff.data[i + 1] === 0) grid.add(Math.floor(y / cell) * cols + Math.floor(x / cell));
          }
          const boxes = [...grid].slice(0, 12).map(g => `(${(g % cols) * cell},${Math.floor(g / cols) * cell})`);
          v.notes.push(`diff ${v.pixelPct}% > tol ${route.pixelTolerancePct}% — clusters near: ${boxes.join(' ')}`);
        } else v.pixel = 'ok';
      }
    } else v.notes.push('screenshot missing on one side');
  }

  // keySelector failures from current capture summary
  const cs = loadJSON(join(CUR_DIR, 'summary.json'), { routes: {} }).routes[route.id];
  if (cs?.keySelectorFailures?.length) { v.notes.push(...cs.keySelectorFailures); v.keySelectors = 'FAIL'; }
  if (cs?.error) { v.notes.push(`capture error: ${cs.error}`); v.capture = 'FAIL'; }

  const bad = [v.pixel, v.structure, v.errors, v.keySelectors, v.capture].includes('FAIL');
  if (bad) failures++;
  report.push(v);
  console.log(`${bad ? '✗' : '✓'} ${route.id}  pixel:${v.pixel}${v.pixelPct != null ? `(${v.pixelPct}%)` : ''} structure:${v.structure} errors:${v.errors}${v.notes.length ? '\n    ' + v.notes.join('\n    ') : ''}`);
}

writeFileSync(join(CUR_DIR, 'verify-report.json'), JSON.stringify(report, null, 2));
console.log(`\nverify: ${report.length - failures}/${report.length} routes pass`);
process.exit(failures ? 1 : 0);
