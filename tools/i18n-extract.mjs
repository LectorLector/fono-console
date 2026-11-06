// Extract every CJK-containing string literal / template-literal piece from web/js/*.js and web/index.html.
//   node tools/i18n-extract.mjs            list the keys (zh) with file:line
//   node tools/i18n-extract.mjs --missing  keys with no entry in web/i18n/en.json (exit 1 if any)
//   node tools/i18n-extract.mjs --json     machine-readable
// Keys: whitespace-collapsed + trimmed literal; a template literal becomes one key with `${...}` replaced by `{}`;
// literals containing HTML markup yield one key per text fragment / title|placeholder|aria-label|alt attribute value.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..');
export const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;
const CJK_LETTER = /[㐀-鿿豈-﫿]/;
export const norm = s => s.replace(/\s+/g, ' ').trim();

/** Keys that are intentionally never translated: the language names themselves (shown in both languages) and the top-bar switch key. */
export const IGNORE = new Set(['繁體中文', 'Language · 語言', '中', '第', '首', '序曲']);   // + demo-only track titles in mock.js (shown inside data-i18n-skip)

const REGEX_PREV = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const unesc = s => s.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|[\s\S])/g, (m, a, u1, u2, x) => {
  if (u1) return String.fromCodePoint(parseInt(u1, 16)); if (u2) return String.fromCharCode(parseInt(u2, 16)); if (x) return String.fromCharCode(parseInt(x, 16));
  const c = m[1]; return c === 'n' ? '\n' : c === 't' ? '\t' : c === '\n' ? '' : c;
});

/** Tokenise JS source, returning string / template literals (nested ones in ${} included). */
export function jsLiterals(src) {
  const out = []; const lineAt = i => src.slice(0, i).split('\n').length;
  function run(i, inTpl) {
    let depth = 0, last = '';
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1; while (src[j] !== c) { if (src[j] === '\\') j++; j++; }
        out.push({ kind: 'str', value: unesc(src.slice(i + 1, j)), line: lineAt(i) }); i = j + 1; last = 'x'; continue;
      }
      if (c === '`') {
        const pieces = []; let j = i + 1, cur = '';
        while (src[j] !== '`') {
          if (src[j] === '\\') { cur += src.slice(j, j + 2); j += 2; continue; }
          if (src[j] === '$' && src[j + 1] === '{') { pieces.push(unesc(cur)); cur = ''; j = run(j + 2, true); continue; }
          cur += src[j++];
        }
        pieces.push(unesc(cur)); out.push({ kind: 'tpl', pieces, line: lineAt(i) }); i = j + 1; last = 'x'; continue;
      }
      if (c === '/') {
        const rx = last === '' || REGEX_PREV.has(last) || last === 'R';
        if (rx) { let j = i + 1, cls = false; while (j < src.length && (src[j] !== '/' || cls)) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; } i = j + 1; while (/[a-z]/.test(src[i])) i++; last = 'x'; continue; }
      }
      if (c === '{') depth++;
      if (c === '}') { if (inTpl && depth === 0) return i + 1; depth--; }
      if (/[A-Za-z_$]/.test(c)) { let j = i; while (/[\w$]/.test(src[j])) j++; const w = src.slice(i, j); last = /^(return|typeof|case|in|of|else|do|throw|yield|await|void|delete)$/.test(w) ? 'R' : 'x'; i = j; continue; }
      if (!/\s/.test(c)) last = c === ')' || c === ']' || /\d/.test(c) ? 'x' : c;
      i++;
    }
    return i;
  }
  run(0, false); return out;
}

/** Keys from one literal value (may be markup). */
export function keysOf(value) {
  const v = value;
  if (!CJK.test(v)) return [];
  if (/<\/?[a-zA-Z][^>]*>/.test(v) || /<[a-zA-Z]/.test(v)) {
    const ks = [];
    for (const m of v.matchAll(/\b(?:title|placeholder|aria-label|alt)\s*=\s*"([^"]*)"/g)) ks.push(norm(m[1]));
    for (const frag of v.replace(/<[^>]*>/g, '\u0000').split('\u0000')) ks.push(norm(frag));
    return ks.filter(k => CJK.test(k));
  }
  return [norm(v)];
}

export function extract() {
  const map = new Map();  // key -> [{file,line}]
  const add = (k, file, line) => { if (!CJK.test(k)) return; (map.get(k) || map.set(k, []).get(k)).push({ file, line }); };
  const dir = join(root, 'web/js');
  for (const f of readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'i18n.js').sort()) {   // i18n.js is the translator itself
    const src = readFileSync(join(dir, f), 'utf8');
    for (const lit of jsLiterals(src)) {
      const v = lit.kind === 'str' ? lit.value : lit.pieces.join('{}');
      for (const k of keysOf(v)) add(k, 'js/' + f, lit.line);
    }
  }
  // Server messages that reach the UI (errors, install-job steps): Go "..." literals, %s / %v / %.1f become {}
  for (const f of ['setup.go', 'platform_windows.go']) {
    const src = readFileSync(join(root, f), 'utf8').split('\n');
    src.forEach((line, i) => {
      if (/^\s*\/\//.test(line) || (f !== 'setup.go' && !/errors\.New|Errorf/.test(line))) return;
      for (const m of line.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) { const v = unesc(m[1]).replace(/%[-+# 0-9.]*[a-zA-Z]/g, '{}'); for (const k of keysOf(v)) add(k, f, i + 1); }
    });
  }
  const html = readFileSync(join(root, 'web/index.html'), 'utf8');
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const k of keysOf(body.replace(/^[\s\S]*?<body/, '<body'))) add(k, 'index.html', 0);
  return map;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const map = extract();
  const enPath = join(root, 'web/i18n/en.json');
  const en = existsSync(enPath) ? JSON.parse(readFileSync(enPath, 'utf8')) : { strings: {} };
  if (process.argv.includes('--json')) { console.log(JSON.stringify([...map].map(([k, w]) => ({ key: k, where: w.map(x => `${x.file}:${x.line}`) })), null, 1)); process.exitCode = 0; } else {
  const miss = [...map.keys()].filter(k => !(k in (en.strings || {})) && !IGNORE.has(k));
  if (process.argv.includes('--missing')) {
    for (const k of miss) console.log(JSON.stringify(k) + '  @ ' + map.get(k)[0].file + ':' + map.get(k)[0].line);
    console.error(`${map.size} keys, ${miss.length} untranslated`); process.exit(miss.length ? 1 : 0);
  }
  for (const [k, w] of map) console.log(`${w[0].file}:${w[0].line}\t${JSON.stringify(k)}`);
  console.error(`${map.size} keys, ${miss.length} untranslated`);
  }
}
