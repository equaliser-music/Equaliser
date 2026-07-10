// Restyle lint gate: cosmetic CSS literals are forbidden outside theme files
// after a file has been tokenised. Usage:
//   node tools/restyle-lint.mjs --files a.html,b.js
//   node tools/restyle-lint.mjs --all          (lint the standard converted set)
// Allowlists:
//   1. inline: a line containing "eq-allow" (comment or data-eq-allow attr) is skipped
//   2. file:   tools/restyle-lint-allow.txt lines "path :: substring"
//   3. structural: behavioral properties in style=""/el.style are never flagged
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const ARGS = process.argv.slice(2);
const REPO = new URL('..', import.meta.url).pathname;
const THEME_FILES = /common\/css\/theme-[a-z0-9-]+\.css$/;

let files = [];
if (ARGS[0] === '--files') files = ARGS[1].split(',').map(s => s.trim());
else if (ARGS[0] === '--all') {
  files = execSync(
    `find client common content_node/orchestrator -type f \\( -name '*.html' -o -name '*.js' -o -name '*.css' \\) | grep -vE 'node_modules|restyle-tests'`,
    { cwd: REPO, encoding: 'utf8' }
  ).trim().split('\n');
} else { console.error('usage: --files a,b | --all'); process.exit(2); }

const allowFile = REPO + 'tools/restyle-lint-allow.txt';
const fileAllows = existsSync(allowFile)
  ? readFileSync(allowFile, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'))
      .map(l => { const [p, sub] = l.split('::').map(s => s.trim()); return { p, sub }; })
  : [];

// Cosmetic-literal patterns, evaluated only inside CSS-ish contexts.
const RULES = [
  { name: 'hex-color', re: /[:(,]\s*#[0-9a-fA-F]{3,8}\b/ },
  { name: 'rgb/hsl', re: /\b(rgba?|hsla?)\(/ },
  { name: 'gradient', re: /\b(linear|radial|conic)-gradient\(/ },
  { name: 'box-shadow', re: /box-shadow\s*:(?!\s*(?:none|var\(|inherit|unset))/ },
  { name: 'border-radius', re: /border-radius\s*:(?!\s*(?:0[;\s}]|var\(|inherit|unset|initial))/ },
  { name: 'font-family', re: /font-family\s*:(?!\s*(?:inherit|var\(|unset))/ },
  { name: 'backdrop-filter', re: /backdrop-filter\s*:(?!\s*(?:none|var\(|unset))/ },
  { name: 'visual-filter', re: /(?<!backdrop-)filter\s*:\s*(grayscale|blur|drop-shadow|sepia|contrast)/ },
];
// Behavioral style="" properties never flagged even if literal-looking values present
const BEHAVIORAL = /style\s*=\s*"(?:\s*(display|width|height|top|left|right|bottom|transform|opacity|max-width|max-height|min-width|min-height|visibility|overflow|z-index)\s*:[^"]*)+"/;

// Determine CSS-ish context per line: inside <style>, inside .css file, in a style="" attr,
// or in a JS template literal that contains a CSS property pattern.
function lint(path) {
  const abs = REPO + path;
  if (!existsSync(abs)) return [{ path, line: 0, rule: 'missing', text: 'file not found' }];
  if (THEME_FILES.test(path)) return [];
  const src = readFileSync(abs, 'utf8');
  const lines = src.split('\n');
  const isCss = path.endsWith('.css');
  let inStyleBlock = false;
  const hits = [];
  lines.forEach((line, i) => {
    if (/<style[\s>]/.test(line)) inStyleBlock = true;
    const cssContext = isCss || inStyleBlock || /style\s*=\s*"/.test(line) ||
      (path.endsWith('.js') && /(textContent|innerHTML|insertAdjacentHTML|cssText|`)/.test(line) && /[a-z-]+\s*:\s*[^;]{2,}/.test(line));
    if (/<\/style>/.test(line)) inStyleBlock = false;
    if (!cssContext) return;
    if (/eq-allow/.test(line)) return;
    if (BEHAVIORAL.test(line) && !RULES.slice(0, 3).some(r => r.re.test(line))) return;
    if (fileAllows.some(a => path.includes(a.p) && line.includes(a.sub))) return;
    for (const rule of RULES) {
      if (rule.re.test(line)) { hits.push({ path, line: i + 1, rule: rule.name, text: line.trim().slice(0, 120) }); break; }
    }
  });
  return hits;
}

let total = 0;
for (const f of files) {
  const hits = lint(f);
  total += hits.length;
  for (const h of hits) console.log(`${h.path}:${h.line}: [${h.rule}] ${h.text}`);
}
console.log(total ? `\nLINT FAIL: ${total} cosmetic literal(s)` : 'LINT OK');
process.exit(total ? 1 : 0);
