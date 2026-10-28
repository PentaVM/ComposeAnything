'use strict';
// DSL de notación de ComposeAnything: texto compacto que una IA puede leer y escribir con fiabilidad.
//
//   Nota      Eb4:ed          acorde  [Bb2 Eb3 Gb3]:q          silencio  r:q
//   Duración  w h hd q qd e ed s sd t   (redonda, blanca, blanca con puntillo, negra, ...; 1 negra = 24 unidades)
//   Marcas    !acc !stac !ten !marc !fer !ts (ligadura de unión)  !s( !s) (ligadura de frase)  !l=Glo- (letra, verso 1)  !l2=...
//   Directivas {harm Ebm} {dyn mf} {cresc} {dim} {wedge x} {ped s|c|x} {txt cantabile} {reh A}
//              {tempo 120 Allegro} {play 88} (cambia solo la reproducción)
//   Voces     "soprano || alto" dentro de un mismo pentagrama
//
// Alturas: letra + b/#/n + octava científica (C4 = do central). Cb5 suena como B4.

const { parseChord } = require('./chord');

const DIV = 24; // unidades por negra
const DUR = { w: 96, hd: 72, h: 48, qd: 36, q: 24, ed: 18, e: 12, sd: 9, s: 6, t: 3 };
const DUR_BY_UNITS = Object.fromEntries(Object.entries(DUR).map(([k, v]) => [v, k]));
const DUR_UNITS_DESC = Object.values(DUR).sort((a, b) => b - a);
const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const DYNAMICS = new Set(['pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff', 'sf', 'sfz', 'sfp', 'sfpp', 'fp', 'rf', 'rfz', 'fz']);
const MARKS = new Set(['acc', 'stac', 'ten', 'marc', 'fer', 'ts', 's(', 's)']);

class DslError extends Error {}

function parsePitch(name) {
  const m = /^([A-G])([b#n]*)(-?\d)$/.exec(name);
  if (!m) throw new DslError(`altura inválida: "${name}" (usa p. ej. Eb4, F#3, Cn5)`);
  const alter = (m[2].match(/#/g) || []).length - (m[2].match(/b/g) || []).length;
  const octave = Number(m[3]);
  return { step: m[1], alter, octave, midi: 12 * (octave + 1) + STEP_PC[m[1]] + alter, name };
}

const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

/** MIDI -> nombre con la grafía que corresponde a la armadura (Cb en 6 bemoles, E# en 6 sostenidos...). */
function midiToName(midi, fifths = 0) {
  const pc = ((midi % 12) + 12) % 12;
  const spellings = [];
  const order = fifths >= 0 ? SHARP_ORDER : FLAT_ORDER;
  for (let i = 0; i < Math.abs(fifths); i++) spellings.push({ step: order[i], alter: fifths >= 0 ? 1 : -1 });
  for (const sp of spellings) if (((STEP_PC[sp.step] + sp.alter) % 12 + 12) % 12 === pc) return build(sp.step, sp.alter);
  const sharps = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const flats = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const nm = (fifths >= 0 ? sharps : flats)[pc];
  return build(nm[0], nm.length > 1 ? (nm[1] === '#' ? 1 : -1) : 0);
  function build(step, alter) {
    const octave = Math.floor((midi - alter) / 12) - 1;
    return step + (alter < 0 ? 'b'.repeat(-alter) : '#'.repeat(alter)) + octave;
  }
}

const TOKEN_RE = /\{[^}]*\}|\[[^\]]*\]\S*|\S+/g;

function parseToken(tok) {
  if (tok.startsWith('{')) {
    const body = tok.slice(1, -1).trim();
    const sp = body.indexOf(' ');
    const name = sp < 0 ? body : body.slice(0, sp);
    const arg = sp < 0 ? '' : body.slice(sp + 1).trim();
    validateDirective(name, arg, tok);
    return { kind: 'dir', name, arg };
  }
  const i = tok.lastIndexOf(']') >= 0 ? tok.indexOf(':', tok.lastIndexOf(']')) : tok.indexOf(':');
  if (i < 0) throw new DslError(`token sin duración: "${tok}" (formato Nota:duración, p. ej. Eb4:q)`);
  const head = tok.slice(0, i);
  const [dur, ...mods] = tok.slice(i + 1).split('!');
  if (!(dur in DUR)) throw new DslError(`duración desconocida "${dur}" en "${tok}" (usa ${Object.keys(DUR).join(' ')})`);
  for (const m of mods) {
    if (!MARKS.has(m) && !/^l\d?=.+/.test(m)) throw new DslError(`marca desconocida "!${m}" en "${tok}"`);
  }
  if (head === 'r') return { kind: 'rest', dur: DUR[dur], code: dur, mods };
  const names = head.startsWith('[') && head.endsWith(']') ? head.slice(1, -1).trim().split(/\s+/) : [head];
  const pitches = names.map(parsePitch);
  return { kind: 'note', pitches, dur: DUR[dur], code: dur, mods };
}

function validateDirective(name, arg, tok) {
  const bad = (msg) => { throw new DslError(`${msg} en "${tok}"`); };
  switch (name) {
    case 'dyn': if (!DYNAMICS.has(arg)) bad(`dinámica desconocida "${arg}"`); break;
    case 'cresc': case 'dim': break;
    case 'wedge': if (arg !== 'x') bad('usa {wedge x} para cerrar un regulador'); break;
    case 'ped': if (!['s', 'c', 'x'].includes(arg)) bad('pedal: s (pisar), c (cambiar) o x (soltar)'); break;
    case 'tempo': case 'play': if (!/^\d{2,3}(\s|$)/.test(arg)) bad('tempo: {tempo 120 texto}'); break;
    case 'txt': case 'reh': if (!arg) bad('texto vacío'); break;
    case 'harm': try { parseChord(arg); } catch (e) { bad(e.message); } break;
    default: bad(`directiva desconocida {${name}}`);
  }
}

function parseStream(text) {
  const out = [];
  for (const tok of String(text || '').match(TOKEN_RE) || []) out.push(parseToken(tok));
  return out;
}

function splitVoices(text) {
  return String(text || '').split(/\s*\|\|\s*/);
}

function renderToken(t) {
  if (t.kind === 'dir') return `{${t.name}${t.arg ? ' ' + t.arg : ''}}`;
  const mods = t.mods.map((m) => '!' + m).join('');
  if (t.kind === 'rest') return `r:${t.code}${mods}`;
  const head = t.pitches.length > 1 ? `[${t.pitches.map((p) => p.name).join(' ')}]` : t.pitches[0].name;
  return `${head}:${t.code}${mods}`;
}

const serialize = (tokens) => tokens.map(renderToken).join(' ');
const streamLength = (tokens) => tokens.reduce((n, t) => n + (t.kind === 'dir' ? 0 : t.dur), 0);

/** Parte un número de unidades en duraciones representables (para ligaduras / silencios). */
function splitUnits(units) {
  const parts = [];
  let left = units;
  for (const u of DUR_UNITS_DESC) while (left >= u) { parts.push(u); left -= u; }
  if (left) throw new DslError(`duración no representable: ${units}`);
  return parts;
}

module.exports = {
  DIV, DUR, DUR_BY_UNITS, DslError, parsePitch, midiToName, parseStream, splitVoices, renderToken, serialize,
  streamLength, splitUnits, DYNAMICS,
};
