'use strict';
// Herramientas de coro (SATB): comprobación de reglas de escritura a cuatro voces y reparto de letra.

const { parseStream, splitVoices, serialize } = require('./dsl');
const { staffList, contextAt, barLength, measureCount } = require('./score');

const VOICE_RANGES = { S: [60, 81], A: [55, 74], T: [48, 69], B: [40, 64] }; // C4–A5, G3–D5, C3–A4, E2–E4
const NAMES = { S: 'soprano', A: 'alto', T: 'tenor', B: 'bajo' };

/** Devuelve [{label, staff, voice}] de arriba abajo si la obra es un coro SATB; si no, null. */
function choirVoices(model) {
  const t = model.meta.template;
  if (t === 'satb_open') return ['S', 'A', 'T', 'B'].map((label, i) => ({ label, staff: String(i + 1), voice: 0 }));
  if (t === 'satb_closed') return [{ label: 'S', staff: '1', voice: 0 }, { label: 'A', staff: '1', voice: 1 }, { label: 'T', staff: '2', voice: 0 }, { label: 'B', staff: '2', voice: 1 }];
  return null;
}

const beatUnits = ([num, den]) => (den === 8 ? (num > 3 && num % 3 === 0 ? 36 : 12) : den === 2 ? 48 : 24);

function lineAt(tokens, t) {
  let pos = 0;
  for (const tk of tokens) {
    if (tk.kind === 'dir') continue;
    if (t >= pos && t < pos + tk.dur) return tk.kind === 'note' ? Math.max(...tk.pitches.map((p) => p.midi)) : null;
    pos += tk.dur;
  }
  return null;
}

function checkChoir(model, from = 1, to = measureCount(model)) {
  const voices = choirVoices(model);
  if (!voices) return { applicable: false, issues: [] };
  const issues = [];
  const add = (severity, measure, beat, rule, text) => issues.push({ severity, measure, beat, rule, text });
  let prev = null;
  for (let n = from; n <= to; n++) {
    const m = model.measures[n];
    if (!m) { prev = null; continue; }
    const ctx = contextAt(model, n);
    const grid = beatUnits(ctx.time), bar = barLength(ctx.time);
    const streams = voices.map((v) => {
      const src = m.staves?.[v.staff];
      const parts = src ? splitVoices(src) : [];
      return parts[v.voice] ? parseStream(parts[v.voice]) : [];
    });
    for (let b = 0; b * grid < bar; b++) {
      const t = b * grid, beat = b + 1;
      const col = streams.map((s) => lineAt(s, t));
      col.forEach((p, i) => {
        if (p === null) return;
        const [lo, hi] = VOICE_RANGES[voices[i].label];
        if (p < lo || p > hi) add('warn', n, beat, 'tesitura', `${NAMES[voices[i].label]} fuera de tesitura (MIDI ${p}, cómoda ${lo}–${hi})`);
      });
      for (let i = 0; i < 3; i++) {
        if (col[i] !== null && col[i + 1] !== null) {
          if (col[i] < col[i + 1]) add('error', n, beat, 'cruce', `cruce de voces: ${NAMES[voices[i].label]} por debajo de ${NAMES[voices[i + 1].label]}`);
          else if (i < 2 && col[i] - col[i + 1] > 12) add('warn', n, beat, 'espaciado', `${NAMES[voices[i].label]} y ${NAMES[voices[i + 1].label]} separados más de una octava`);
        }
      }
      if (prev) {
        for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
          const [a0, b0, a1, b1] = [prev[i], prev[j], col[i], col[j]];
          if ([a0, b0, a1, b1].some((x) => x === null || x === undefined)) continue;
          const i0 = (a0 - b0) % 12, i1 = (a1 - b1) % 12;
          const da = Math.sign(a1 - a0), db = Math.sign(b1 - b0);
          if (da === 0 || db === 0 || da !== db || i0 !== i1) continue;
          if (i1 === 7) add('error', n, beat, 'quintas', `quintas paralelas entre ${NAMES[voices[i].label]} y ${NAMES[voices[j].label]}`);
          else if (i1 === 0) add('error', n, beat, 'octavas', `octavas paralelas entre ${NAMES[voices[i].label]} y ${NAMES[voices[j].label]}`);
        }
      }
      prev = col;
    }
  }
  return { applicable: true, issues };
}

/** "Glo-ri-a in ex-cel-sis" -> [{text:'Glo-'},{'ri-'},{'a'},{'in'},...] ; "_" = extensor. */
function syllabify(text) {
  const out = [];
  for (const word of String(text).trim().split(/\s+/).filter(Boolean)) {
    if (word === '_') { out.push('_'); continue; }
    const parts = word.split('-').filter((p) => p.length);
    parts.forEach((p, i) => out.push(p.replace(/[!{}\[\]]/g, '') + (i < parts.length - 1 ? '-' : '')));
  }
  return out;
}

/** Reparte la letra sobre las notas de una voz a partir del compás `from`. Reemplaza la letra previa de ese verso. */
function setLyrics(model, { staff, from = 1, text, verse = 1, voice = 0 }) {
  const syl = syllabify(text);
  if (!syl.length) throw new Error('la letra está vacía');
  const sid = String(staff);
  if (!staffList(model).some((s) => String(s.global) === sid)) throw new Error(`el pentagrama ${sid} no existe`);
  const tag = verse === 1 ? 'l=' : `l${verse}=`;
  let i = 0, prevTie = null, lastMeasure = from;
  for (let n = from; n <= measureCount(model); n++) {
    const m = model.measures[n];
    const src = m?.staves?.[sid];
    if (!src) continue;
    const voices = splitVoices(src);
    if (!voices[voice]) continue;
    const tokens = parseStream(voices[voice]);
    for (const t of tokens) {
      if (t.kind !== 'note') continue;
      t.mods = t.mods.filter((x) => !(verse === 1 ? /^l=/ : new RegExp(`^l${verse}=`)).test(x));
      const key = t.pitches.map((p) => p.midi).join();
      if (prevTie === key) { prevTie = t.mods.includes('ts') ? key : null; continue; } // nota ligada: no lleva sílaba
      prevTie = t.mods.includes('ts') ? key : null;
      if (i < syl.length) { t.mods.push(tag + syl[i++]); lastMeasure = n; }
    }
    voices[voice] = serialize(tokens);
    m.staves[sid] = voices.join(' || ');
    if (i >= syl.length) { lastMeasure = n; break; }
  }
  return { assigned: i, remaining: syl.slice(i), lastMeasure };
}

module.exports = { VOICE_RANGES, choirVoices, checkChoir, syllabify, setLyrics };
