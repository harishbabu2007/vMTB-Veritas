#!/usr/bin/env node
// npm run check:theme
//
// Two cheap guards for the theme system (see the token comment in src/index.css):
//   1. Contrast — every text/background token pair we rely on meets WCAG AA in
//      both :root (light) and :root.dark.
//   2. Hardcoded colours — components use semantic tokens, so a raw palette
//      class (bg-white, text-gray-400, hover:bg-red-50, ...), a hex/rgb() literal,
//      or a `dark:` colour variant in src/ is an error. Something that must stay
//      literal (a third-party brand logo, a document's own colours) is allowed by
//      putting `theme-allow: <reason>` in a comment on the same or previous line,
//      or wrapping a block in `theme-allow-start: <reason>` / `theme-allow-end`.
//
// Exits 1 on any violation.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = join(root, 'src');
let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  ✗ ${msg}`);
};

// --------------------------------------------------------------------------
// 1. Contrast
// --------------------------------------------------------------------------

const css = readFileSync(join(src, 'index.css'), 'utf8');

function readTokens(selectorPattern) {
  const m = css.match(new RegExp(`${selectorPattern}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`Could not find ${selectorPattern} in index.css`);
  const tokens = {};
  for (const [, name, value] of m[1].matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[name] = value;
  }
  return tokens;
}

const themes = {
  light: readTokens(':root'),
  dark: { ...readTokens(':root'), ...readTokens(':root\\.dark') },
};

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const PLAIN = ['bg', 'surface', 'surface-hover', 'surface-muted'];
const PAGE = ['bg', 'surface']; // coloured accents sit on the page or a card, not on hover/chip fills
const AA = 4.5;
const pairs = []; // [foreground token, background token, minimum ratio]
const add = (fg, bgs, min = AA) => bgs.forEach((bg) => pairs.push([fg, bg, min]));

add('text', PLAIN);
add('text-muted', PLAIN);
add('text-subtle', PLAIN);
add('link', PLAIN);
add('primary', PAGE, 3); // icons, borders, focus rings: non-text, 3:1
add('on-solid', ['primary-solid', 'neutral-solid', 'neutral-solid-hover', 'danger-solid', 'success-solid', 'info-solid', 'danger-solid-hover', 'success-solid-hover', 'info-solid-hover', 'primary-solid-hover']);
for (const f of ['danger', 'success', 'info', 'warning']) {
  add(f, PAGE);
  add(`${f}-text`, [`${f}-bg`, `${f}-bg-strong`]);
  add(f, [`${f}-bg`, `${f}-bg-strong`]); // accent text/icon inside its own alert or badge
}
for (const s of ['processing', 'pending', 'verified', 'failed', 'mtb-updated']) {
  add(`status-${s}-text`, [`status-${s}-bg`]);
}

// Pairs that miss AA on purpose, with the reason. Anything not listed is an error.
const KNOWN = new Map([
  // Brand blue (#4A90E2) is the product's identity; white on it is 3.4:1, so it
  // passes only as "large text" (>=14px bold). Darkening --color-primary-solid
  // in :root fixes it in one line — a design call, not a bug.
  ['light on-solid/primary-solid', 'brand blue; AA-large only'],
  ['light on-solid/primary-solid-hover', 'brand blue; AA-large only'],
]);

console.log('Contrast (WCAG AA, 4.5:1 text / 3:1 non-text)');
for (const [theme, tokens] of Object.entries(themes)) {
  for (const [fg, bg, min] of pairs) {
    if (!tokens[fg] || !tokens[bg]) {
      fail(`${theme}: token missing for ${fg} on ${bg}`);
      continue;
    }
    const ratio = contrast(tokens[fg], tokens[bg]);
    if (ratio >= min) continue;
    const key = `${theme} ${fg}/${bg}`;
    if (KNOWN.has(key)) {
      console.warn(`  ! ${key} ${ratio.toFixed(2)}:1 (< ${min}) — known: ${KNOWN.get(key)}`);
    } else {
      fail(`${key} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
    }
  }
}

// --------------------------------------------------------------------------
// 2. Hardcoded colours
// --------------------------------------------------------------------------

const PALETTE =
  'white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const UTILS = 'bg|text|border|ring|ring-offset|divide|from|to|via|fill|stroke|outline|placeholder|accent|caret|decoration|shadow';
const paletteClass = new RegExp(`(?<![\\w-])(?:[\\w:-]+:)?(?:${UTILS})-(?:${PALETTE})(?:-\\d{2,3})?(?:/\\d+)?(?![\\w-])`, 'g');
const darkVariant = /(?<![\w-])dark:(?:[\w-]+:)*(?:bg|text|border|ring|divide|from|to|via|fill|stroke|outline|placeholder|accent)-/g;
const hexLiteral = /#[0-9a-fA-F]{3,8}\b(?![\w-])/g;
const rgbLiteral = /\brgba?\(\s*\d/g;
const bgOpacity = /(?<![\w-])(?:[\w:-]+:)?bg-opacity-\d+/g;

// Files that are out of scope, and why.
const SKIP_FILES = new Map([
  ['components/VoiceRecorder.tsx', 'legacy voice dictation — do not touch (CLAUDE.md)'],
  ['components/VoiceRecorder.css', 'legacy voice dictation — do not touch (CLAUDE.md)'],
  ['pages/NewCaseStep2_backup.tsx', 'dead backup, not imported anywhere'],
]);
const SKIP_EXT = /\.backup$/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

console.log('Hardcoded colours in src/');
let scanned = 0;
for (const file of walk(src)) {
  const rel = relative(src, file).split(sep).join('/');
  if (!/\.(tsx?|jsx?|css)$/.test(rel) || SKIP_EXT.test(rel) || SKIP_FILES.has(rel)) continue;
  // The token definitions themselves live here.
  if (rel === 'index.css') continue;
  scanned += 1;
  const lines = readFileSync(file, 'utf8').split('\n');
  let inAllowBlock = false;
  lines.forEach((line, i) => {
    if (/theme-allow-start:/.test(line)) inAllowBlock = true;
    if (/theme-allow-end/.test(line)) {
      inAllowBlock = false;
      return;
    }
    if (inAllowBlock) return;
    if (/theme-allow:/.test(line) || (i > 0 && /theme-allow:/.test(lines[i - 1]))) return;
    const isCss = rel.endsWith('.css');
    const hits = [
      ...(isCss ? [] : line.match(paletteClass) ?? []),
      ...(isCss ? [] : line.match(darkVariant) ?? []),
      ...(isCss ? [] : line.match(bgOpacity) ?? []),
      ...(line.match(hexLiteral) ?? []),
      ...(line.match(rgbLiteral) ?? []),
    ];
    if (hits.length) fail(`${rel}:${i + 1}  ${[...new Set(hits)].join(', ')}`);
  });
}
console.log(`  scanned ${scanned} files`);

if (failures) {
  console.error(`\ncheck:theme failed with ${failures} problem${failures === 1 ? '' : 's'}.`);
  console.error('Use a semantic token (see src/index.css), or add `theme-allow: <reason>` if a literal must stay.');
  process.exit(1);
}
console.log('\ncheck:theme passed.');
