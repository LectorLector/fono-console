// Shared EQ APO config validator (used by config.test.mjs and ui-sweep.mjs). Returns a list of problems (empty = fine).
const okLine = /^(Device|Channel|Preamp|Filter( \d+)?|Copy|Delay|Convolution|If|ElseIf|Else|EndIf|Include|Stage):/;
export function configProblems(txt, name = 'cfg') {
  const bad = [];
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(txt)) bad.push(name + ': non-ASCII character');
  if (/NaN|undefined|null|Infinity/.test(txt)) bad.push(name + ': bad value in text');
  const lines = txt.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  let depth = 0;
  for (const l of lines) {
    if (!okLine.test(l)) bad.push(`${name}: unknown line "${l}"`);
    if (/^If:/.test(l)) depth++; if (/^EndIf:/.test(l)) depth--;
    if (depth < 0) bad.push(name + ': EndIf before If');
    if (/^Filter/.test(l) && !/^Filter( \d+)?: (ON|OFF) (PK|LSC|HSC|LP|HP|BP|NO|AP|LPQ|HPQ|LS|HS) Fc \d+(\.\d+)? Hz( Gain -?\d+(\.\d+)? dB)?( Q \d+(\.\d+)?)?$/.test(l)) bad.push(`${name}: malformed filter "${l}"`);
    if (/^Delay:/.test(l) && !/^Delay: -?\d+(\.\d+)? ms$/.test(l)) bad.push(`${name}: malformed delay "${l}"`);
    if (/^Preamp:/.test(l)) { const m = l.match(/^Preamp: (-?[\d.]+) dB$/); if (!(m && +m[1] <= 0.01)) bad.push(`${name}: bad preamp "${l}"`); }
  }
  if (depth) bad.push(name + ': unbalanced If');
  return bad;
}
