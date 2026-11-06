// i18n: web/i18n/en.json is valid, every CJK string literal in web/js + web/index.html (tools/i18n-extract.mjs) has an English entry or
// a pattern, nothing in the dictionary is stale, and t() behaves (exact, {} templates, patterns, run-time fragments, punctuation).
import { readFileSync } from 'node:fs';
import { test, ok, eq, suite, done } from './harness.mjs';
import { extract, IGNORE, CJK } from '../tools/i18n-extract.mjs';
import { t, _useForTest } from '../web/js/i18n.js';

const en = JSON.parse(readFileSync(new URL('../web/i18n/en.json', import.meta.url), 'utf8'));
const strings = en.strings, patterns = en.patterns || [];
const keys = extract();
const holes = s => (s.match(/\{\d*\}/g) || []).length;
const sample = k => k.replace(/\{\}/g, '7');

suite('en.json');
test('shape: { strings: {zh: en}, patterns: [[regex, replacement]] }', () => {
  ok(strings && typeof strings === 'object' && !Array.isArray(strings), 'strings');
  ok(Object.values(strings).every(v => typeof v === 'string'), 'values are strings');
  ok(Array.isArray(patterns) && patterns.every(p => Array.isArray(p) && p.length === 2 && p.every(x => typeof x === 'string')), 'patterns');
  for (const [re] of patterns) new RegExp(re, 's');
});
test('English values contain no CJK letters or full-width punctuation', () => {
  const bad = Object.entries(strings).filter(([k, v]) => CJK.test(v) && !IGNORE.has(k));
  ok(!bad.length, bad.slice(0, 5).map(([k, v]) => `${k} => ${v}`).join(' | '));
});
test('{} holes: a value uses the same number of holes as its key (numbered {1} {2} may reorder)', () => {
  const bad = Object.entries(strings).filter(([k, v]) => k.includes('{}') && holes(v) !== holes(k) || !k.includes('{}') && holes(v));
  ok(!bad.length, bad.slice(0, 5).map(([k, v]) => `${k} => ${v}`).join(' | '));
});
test('keys are trimmed and whitespace-collapsed (as the extractor produces them)', () => {
  const bad = Object.keys(strings).filter(k => k !== k.replace(/\s+/g, ' ').trim());
  ok(!bad.length, bad.slice(0, 5).join(' | '));
});

suite('coverage');
const matchesPattern = k => patterns.some(([re]) => new RegExp(re, 's').test(sample(k)));
test(`every extracted CJK literal (${keys.size}) has a translation, a pattern or is on the ignore list`, () => {
  const miss = [...keys.keys()].filter(k => !(k in strings) && !matchesPattern(k) && !IGNORE.has(k));
  ok(!miss.length, `${miss.length} untranslated, e.g. ` + miss.slice(0, 6).map(k => JSON.stringify(k) + ' @ ' + keys.get(k)[0].file + ':' + keys.get(k)[0].line).join(' | '));
});
test('no stale dictionary entries (keys that no source literal contains any more)', () => {
  const KEEP = new Set(['{}：{}']);      // generic last-resort template (see t() tests)
  const stale = Object.keys(strings).filter(k => !keys.has(k) && !KEEP.has(k));
  ok(!stale.length, `${stale.length} stale, e.g. ` + stale.slice(0, 6).map(k => JSON.stringify(k)).join(' | '));
});
test('t() leaves no CJK behind for any extracted literal', () => {
  _useForTest('en', en);
  const bad = [...keys.keys()].filter(k => !IGNORE.has(k)).map(k => [k, t(sample(k))]).filter(([, o]) => CJK.test(o));
  ok(!bad.length, bad.slice(0, 5).map(([k, o]) => `${k} -> ${o}`).join(' | '));
});
test('wall/index.json: every wallpaper has name_en and credit_en', () => {
  const j = JSON.parse(readFileSync(new URL('../web/wall/index.json', import.meta.url), 'utf8'));
  ok(j.length > 0 && j.every(x => x.name_en && x.credit_en && !CJK.test(x.name_en + x.credit_en)), 'name_en / credit_en');
});

suite('t()');
test('identity in zh-TW', () => { _useForTest('zh-TW', null); eq(t('播放'), '播放'); eq(t('x'), 'x'); });
test('exact, template, run-time fragments, unit templates', () => {
  _useForTest('en', en);
  eq(t('播放'), 'Play');
  eq(t(' 播放 '), ' Play ');
  eq(t('完全沒有的字串'), '完全沒有的字串');      // unknown text passes through
  eq(t('REW 回應錯誤：demo'), 'REW returned an error: demo');
  eq(t('已把 3 個濾波器指派到 FL'), 'Assigned 3 filters to FL');
  eq(t('23 首'), '23 tracks');
  eq(t('15分'), '15 min');
  eq(t('49、98、147 Hz'), '49, 98, 147 Hz');
});
test('patterns: capture groups are substituted and translated', () => {
  _useForTest('en', { strings: { 播放: 'Play' }, patterns: [['^第 (\\d+) / (\\d+) 步$', 'Step $1 / $2'], ['^按 (.+) 開始$', 'Press $1 to start']] });
  eq(t('第 2 / 9 步'), 'Step 2 / 9'); eq(t('按 播放 開始'), 'Press Play to start');
});
test('{n} placeholders can reorder; a weak "{}：{}" template is only a last resort', () => {
  _useForTest('en', { strings: { '把 {} 放到 {}': 'Put {2} on {1}', '{}：{}': '{}: {}', 播放: 'Play' }, patterns: [] });
  eq(t('把 A 放到 B'), 'Put B on A'); eq(t('Spotify：x'), 'Spotify: x'); eq(t('播放：x'), 'Play: x');
});
done('i18n.test.mjs');
