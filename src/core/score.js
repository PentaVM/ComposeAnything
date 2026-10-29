'use strict';
// Modelo de partitura: JSON plano, una entrada por compás y pentagrama con texto DSL.
// Escribir un compás lo REEMPLAZA (nunca lo duplica) y toda escritura es atómica: si un compás es
// inválido no se aplica ninguno.

const { parseStream, splitVoices, streamLength, serialize, DslError, midiToName } = require('./dsl');

const GM = { piano: 0, choir: 52, voice: 53, strings: 48, violin: 40, cello: 42, flute: 73, guitar: 24, organ: 19 };

const RANGES = {
  // [mín, máx] MIDI de la tesitura cómoda; fuera de ella solo hay aviso
  soprano: [60, 81], alto: [55, 74], tenor: [48, 69], bass: [40, 64], piano: [21, 108],
  voice: [48, 84], violin: [55, 103], cello: [36, 76], flute: [60, 96],
};

function templateParts(template, opts = {}) {
  switch (template) {
    case 'piano':
      return { parts: [{ id: 'P1', name: 'Piano', abbr: 'Pno.', program: GM.piano, range: 'piano', staves: [{ clef: 'G' }, { clef: 'F' }] }] };
    case 'satb_open':
      return {
        parts: [
          { id: 'P1', name: 'Soprano', abbr: 'S.', program: GM.choir, range: 'soprano', staves: [{ clef: 'G' }] },
          { id: 'P2', name: 'Alto', abbr: 'A.', program: GM.choir, range: 'alto', staves: [{ clef: 'G' }] },
          { id: 'P3', name: 'Tenor', abbr: 'T.', program: GM.choir, range: 'tenor', staves: [{ clef: 'G', octave: -1 }] },
          { id: 'P4', name: 'Bajo', abbr: 'B.', program: GM.choir, range: 'bass', staves: [{ clef: 'F' }] },
        ],
        groups: [{ from: 'P1', to: 'P4', symbol: 'bracket' }],
      };
    case 'satb_closed':
      return {
        parts: [{ id: 'P1', name: 'Coro', abbr: 'Coro', program: GM.choir, range: 'soprano', staves: [{ clef: 'G' }, { clef: 'F' }] }],
        hint: 'Pentagrama 1: soprano || alto (dos voces). Pentagrama 2: tenor || bajo.',
      };
    case 'voice_piano':
      return {
        parts: [
          { id: 'P1', name: opts.voiceName || 'Voz', abbr: 'V.', program: GM.voice, range: 'voice', staves: [{ clef: 'G' }] },
          { id: 'P2', name: 'Piano', abbr: 'Pno.', program: GM.piano, range: 'piano', staves: [{ clef: 'G' }, { clef: 'F' }] },
        ],
        groups: [{ from: 'P1', to: 'P2', symbol: 'bracket' }],
      };
    case 'solo': {
      const name = opts.instrument || 'Violín';
      return { parts: [{ id: 'P1', name, abbr: name.slice(0, 4) + '.', program: GM[opts.programKey] ?? GM.violin, range: 'violin', staves: [{ clef: opts.clef || 'G' }] }] };
    }
    default:
      throw new Error(`plantilla desconocida "${template}" (piano, satb_open, satb_closed, voice_piano, solo)`);
  }
}

function newScore({ title = 'Sin título', subtitle = '', composer = '', key = 0, mode = 'major', time = [4, 4], tempo = 100, template = 'piano', options = {} } = {}) {
  const { parts, groups = [], hint = '' } = templateParts(template, options);
  return { version: 1, meta: { title, subtitle, composer, key, mode, time, tempo, template, hint }, parts, groups, measures: {} };
}

const barLength = (time) => time[0] * (96 / time[1]);
const measureCount = (m) => Math.max(0, ...Object.keys(m.measures).map(Number));
const staffList = (m) => {
  const out = [];
  let g = 1;
  for (const p of m.parts) p.staves.forEach((s, i) => out.push({ global: g++, part: p, local: i + 1, staff: s }));
  return out;
};

/** Compás en vigor (armadura y compás de tiempo) en el compás n, siguiendo los cambios previos. */
function contextAt(model, n) {
  let time = model.meta.time, key = model.meta.key, mode = model.meta.mode;
  for (let i = 1; i <= n; i++) {
    const m = model.measures[i];
    if (m?.time) time = m.time;
    if (m?.key !== undefined) { key = m.key; if (m.mode) mode = m.mode; }
  }
  return { time, key, mode };
}

function validateMeasure(model, n, spec) {
  const errors = [], warnings = [];
  const staves = staffList(model);
  const { time } = contextAt({ ...model, measures: { ...model.measures, [n]: { ...(model.measures[n] || {}), ...spec } } }, n);
  const bar = barLength(time);
  for (const [sid, text] of Object.entries(spec.staves || {})) {
    const info = staves.find((s) => String(s.global) === String(sid));
    if (!info) { errors.push(`compás ${n}: el pentagrama ${sid} no existe (hay ${staves.length})`); continue; }
    const voices = splitVoices(text);
    if (voices.length > 4) errors.push(`compás ${n} pentagrama ${sid}: máximo 4 voces`);
    voices.forEach((v, vi) => {
      let tokens;
      try { tokens = parseStream(v); } catch (e) {
        if (e instanceof DslError) { errors.push(`compás ${n} pentagrama ${sid} voz ${vi + 1}: ${e.message}`); return; }
        throw e;
      }
      const len = streamLength(tokens);
      if (len !== bar && !(spec.partial && len < bar && len > 0)) {
        errors.push(`compás ${n} pentagrama ${sid} voz ${vi + 1}: suma ${len / 24} negras, el compás ${time[0]}/${time[1]} necesita ${bar / 24}`);
      }
      const [lo, hi] = RANGES[info.part.range] || RANGES.piano;
      for (const t of tokens) {
        if (t.kind !== 'note') continue;
        for (const p of t.pitches) {
          if (p.midi < 21 || p.midi > 108) errors.push(`compás ${n}: ${p.name} fuera del piano (A0–C8)`);
          else if (p.midi < lo - 2 || p.midi > hi + 2) warnings.push(`compás ${n}: ${p.name} fuera de la tesitura cómoda de ${info.part.name}`);
        }
      }
    });
  }
  if (spec.time && (!Array.isArray(spec.time) || spec.time.length !== 2)) errors.push(`compás ${n}: time debe ser [num, den]`);
  return { errors, warnings };
}

/** items: [{ n, staves: {"1": "...", "2": "..."}, time?, key?, mode?, partial? }] */
function writeMeasures(model, items) {
  const errors = [], warnings = [];
  if (!Array.isArray(items) || !items.length) throw new Error('measures vacío');
  const seen = new Set();
  for (const it of items) {
    if (!Number.isInteger(it.n) || it.n < 1) { errors.push(`número de compás inválido: ${it.n}`); continue; }
    if (seen.has(it.n)) { errors.push(`compás ${it.n} repetido en la misma escritura`); continue; }
    seen.add(it.n);
    const r = validateMeasure(model, it.n, it);
    errors.push(...r.errors); warnings.push(...r.warnings);
  }
  if (errors.length) return { ok: false, errors, warnings };
  const written = [];
  for (const it of items) {
    const prev = model.measures[it.n] || {};
    const next = { ...prev };
    // Reemplazo por pentagrama: lo no mencionado se conserva, lo mencionado se sustituye entero.
    next.staves = { ...(prev.staves || {}), ...Object.fromEntries(Object.entries(it.staves || {}).map(([k, v]) => [String(k), String(v).trim()])) };
    for (const k of ['time', 'key', 'mode', 'partial']) if (it[k] !== undefined) next[k] = it[k];
    model.measures[it.n] = next;
    written.push(it.n);
  }
  return { ok: true, written: written.sort((a, b) => a - b), warnings };
}

function clearMeasures(model, from, to = from) {
  let n = 0;
  for (let i = from; i <= to; i++) if (model.measures[i]) { delete model.measures[i]; n++; }
  return n;
}

/** Borra compases y renumera los siguientes (para acortar la obra). */
function deleteMeasures(model, from, to = from) {
  const last = measureCount(model), count = to - from + 1, next = {};
  for (const [k, v] of Object.entries(model.measures)) {
    const i = Number(k);
    if (i < from) next[i] = v; else if (i > to) next[i - count] = v;
  }
  model.measures = next;
  return { removed: Math.min(count, Math.max(0, last - from + 1)), newCount: measureCount(model) };
}

function setMeta(model, patch) {
  for (const k of ['title', 'subtitle', 'composer', 'key', 'mode', 'tempo']) if (patch[k] !== undefined) model.meta[k] = patch[k];
  if (patch.time) model.meta.time = patch.time;
  return model.meta;
}

// --- resúmenes -------------------------------------------------------------------------------

function mapTokens(model, n, fn) {
  const m = model.measures[n];
  const out = [];
  if (!m) return out;
  for (const [sid, text] of Object.entries(m.staves || {})) {
    splitVoices(text).forEach((v, vi) => {
      for (const t of parseStream(v)) out.push(fn(t, sid, vi));
    });
  }
  return out.filter(Boolean);
}

/** Texto para que la IA lea la obra: un bloque por compás con el DSL de cada pentagrama. */
function dumpMeasures(model, from = 1, to = measureCount(model)) {
  const staves = staffList(model);
  const lines = [];
  for (let n = from; n <= to; n++) {
    const m = model.measures[n];
    if (!m) { lines.push(`m${n}: (vacío)`); continue; }
    const head = [m.time ? `time=${m.time.join('/')}` : '', m.key !== undefined ? `key=${m.key}` : '', m.partial ? 'partial' : ''].filter(Boolean).join(' ');
    lines.push(`m${n}${head ? ' [' + head + ']' : ''}`);
    for (const s of staves) {
      const t = m.staves?.[s.global];
      lines.push(`  ${s.global} ${s.part.name}${s.part.staves.length > 1 ? '#' + s.local : ''}: ${t ?? '(silencio)'}`);
    }
  }
  return lines.join('\n');
}

const midiOf = (t) => t.pitches.map((p) => p.midi);

/** Resumen determinista de un tramo, usado en los puntos de control. */
function describeRange(model, from, to) {
  const staves = staffList(model);
  const key = contextAt(model, from).key;
  const harm = [], dyn = [], text = [];
  const perStaff = {};
  for (let n = from; n <= to; n++) {
    const m = model.measures[n];
    if (!m) continue;
    for (const [sid, src] of Object.entries(m.staves || {})) {
      const info = staves.find((s) => String(s.global) === sid);
      const label = `${info?.part.name ?? sid}${info?.part.staves.length > 1 ? '#' + info.local : ''}`;
      const acc = (perStaff[label] ||= { pitches: [], notes: 0, chords: 0, first: null, last: null });
      splitVoices(src).forEach((v, vi) => {
        for (const t of parseStream(v)) {
          if (t.kind === 'dir') {
            if (t.name === 'harm' && vi === 0 && info?.local === 1 && (!harm.length || harm[harm.length - 1] !== t.arg)) harm.push(t.arg);
            if (t.name === 'dyn') dyn.push(t.arg);
            if (t.name === 'txt' || t.name === 'tempo') text.push(t.arg);
          } else if (t.kind === 'note') {
            const md = midiOf(t);
            acc.pitches.push(...md);
            if (t.pitches.length > 1) acc.chords++; else acc.notes++;
            const top = Math.max(...md);
            acc.first ??= top; acc.last = top;
          }
        }
      });
    }
  }
  const parts = Object.entries(perStaff).filter(([, a]) => a.pitches.length).map(([label, a]) => {
    const lo = Math.min(...a.pitches), hi = Math.max(...a.pitches);
    const arrow = a.last - a.first >= 3 ? '↗' : a.first - a.last >= 3 ? '↘' : '→';
    const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const counts = [a.notes ? pl(a.notes, 'nota', 'notas') : null, a.chords ? pl(a.chords, 'acorde', 'acordes') : null].filter(Boolean).join(', ');
    return `${label}: ${midiToName(a.first, key)}${arrow}${midiToName(a.last, key)} (rango ${midiToName(lo, key)}–${midiToName(hi, key)}, ${counts})`;
  });
  return [
    `Compases ${from}${to > from ? '–' + to : ''}`,
    harm.length ? `armonía ${harm.join(' → ')}` : null,
    dyn.length ? `dinámica ${[...new Set(dyn)].join(' → ')}` : null,
    text.length ? `indicaciones: ${text.join('; ')}` : null,
    ...parts,
  ].filter(Boolean).join(' | ');
}

// --- historial / deshacer ---------------------------------------------------------------------

class ScoreHistory {
  constructor(limit = 40) { this.stack = []; this.redoStack = []; this.limit = limit; }
  push(model) { this.stack.push(JSON.stringify(model)); if (this.stack.length > this.limit) this.stack.shift(); this.redoStack = []; }
  undo(current) {
    if (!this.stack.length) return null;
    this.redoStack.push(JSON.stringify(current));
    return JSON.parse(this.stack.pop());
  }
  redo(current) {
    if (!this.redoStack.length) return null;
    this.stack.push(JSON.stringify(current));
    return JSON.parse(this.redoStack.pop());
  }
}

module.exports = {
  GM, RANGES, newScore, barLength, measureCount, staffList, contextAt, validateMeasure, writeMeasures, clearMeasures,
  deleteMeasures, setMeta, dumpMeasures, describeRange, ScoreHistory, serialize,
};
