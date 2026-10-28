'use strict';
// Cifrados de acordes: texto ("Ebm", "Gbmaj7/Cb", "Ab7b9") <-> estructura MusicXML <harmony>.

const QUALITIES = [
  // [sufijo, kind de MusicXML, texto mostrado]
  ['maj13', 'major-13th', 'maj13'], ['maj11', 'major-11th', 'maj11'], ['maj9', 'major-ninth', 'maj9'],
  ['maj7', 'major-seventh', 'maj7'], ['M7', 'major-seventh', 'maj7'], ['m7b5', 'half-diminished', 'm7b5'],
  ['dim7', 'diminished-seventh', 'dim7'], ['dim', 'diminished', 'dim'], ['aug', 'augmented', 'aug'],
  ['mmaj7', 'major-minor', 'mmaj7'], ['m13', 'minor-13th', 'm13'], ['m11', 'minor-11th', 'm11'],
  ['m9', 'minor-ninth', 'm9'], ['m7', 'minor-seventh', 'm7'], ['m6', 'minor-sixth', 'm6'],
  ['min', 'minor', 'm'], ['sus4', 'suspended-fourth', 'sus4'], ['sus2', 'suspended-second', 'sus2'],
  ['13', 'dominant-13th', '13'], ['11', 'dominant-11th', '11'], ['9', 'dominant-ninth', '9'],
  ['7', 'dominant', '7'], ['6', 'major-sixth', '6'], ['m', 'minor', 'm'], ['-', 'minor', 'm'],
  ['+', 'augmented', 'aug'], ['', 'major', ''],
];
const KIND_TO_SUFFIX = {};
for (const [suf, kind] of QUALITIES) {
  if (!(kind in KIND_TO_SUFFIX) && suf !== 'min' && suf !== '-' && suf !== '+' && suf !== 'M7') KIND_TO_SUFFIX[kind] = suf;
}

function parseRoot(s) {
  const m = /^([A-G])([b#]?)/.exec(s);
  if (!m) return null;
  return { step: m[1], alter: m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0, len: m[0].length };
}

/** "Ab7b9" -> {root:{step,alter}, kind, text, bass?, degrees:[{value,alter,type}]} o lanza Error. */
function parseChord(sym) {
  const slash = sym.split('/');
  if (slash.length > 2) throw new Error(`cifrado inválido: ${sym}`);
  const root = parseRoot(slash[0]);
  if (!root) throw new Error(`cifrado inválido (raíz): ${sym}`);
  let rest = slash[0].slice(root.len);
  let bass = null;
  if (slash[1]) {
    const b = parseRoot(slash[1]);
    if (!b || b.len !== slash[1].length) throw new Error(`bajo inválido en cifrado: ${sym}`);
    bass = { step: b.step, alter: b.alter };
  }
  let kind = 'major';
  let text = '';
  for (const [suf, k, t] of QUALITIES) {
    if (suf && rest.startsWith(suf)) { kind = k; text = t; rest = rest.slice(suf.length); break; }
  }
  const degrees = [];
  const re = /^\(?(add|b|#)?(\d+)\)?/;
  let m;
  while (rest && (m = re.exec(rest))) {
    const [full, mod, num] = m;
    const value = Number(num);
    if (mod === 'add' || !mod) degrees.push({ value, alter: 0, type: 'add' });
    else degrees.push({ value, alter: mod === 'b' ? -1 : 1, type: value === 5 ? 'alter' : 'add' });
    rest = rest.slice(full.length);
  }
  if (rest) throw new Error(`cifrado no reconocido: ${sym} (sobra "${rest}")`);
  return { root: { step: root.step, alter: root.alter }, kind, text, bass, degrees };
}

/** Estructura -> texto de cifrado ("Gbmaj7/Cb"). */
function formatChord({ root, kind, bass, degrees = [] }) {
  const acc = (a) => (a < 0 ? 'b'.repeat(-a) : a > 0 ? '#'.repeat(a) : '');
  let s = root.step + acc(root.alter) + (KIND_TO_SUFFIX[kind] ?? '');
  for (const d of degrees) s += (d.alter < 0 ? 'b' : d.alter > 0 ? '#' : d.type === 'add' ? 'add' : '') + d.value;
  if (bass) s += '/' + bass.step + acc(bass.alter);
  return s;
}

function chordToXml(sym, staff) {
  const c = parseChord(sym);
  let x = `<harmony><root><root-step>${c.root.step}</root-step><root-alter>${c.root.alter}</root-alter></root>`;
  x += `<kind text="${c.text}">${c.kind}</kind>`;
  if (c.bass) x += `<bass><bass-step>${c.bass.step}</bass-step><bass-alter>${c.bass.alter}</bass-alter></bass>`;
  for (const d of c.degrees) {
    x += `<degree><degree-value>${d.value}</degree-value><degree-alter>${d.alter}</degree-alter><degree-type>${d.type}</degree-type></degree>`;
  }
  return x + `<staff>${staff}</staff></harmony>`;
}

module.exports = { parseChord, formatChord, chordToXml };
