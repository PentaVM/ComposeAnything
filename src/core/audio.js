'use strict';
// Transcripción de audio -> partitura editable.
//   Melodía (monofónica): WAV -> detección de tono YIN -> notas -> cuantización. Sin dependencias.
//   Polifónica: delega en `basic-pitch` (pip install basic-pitch) y lee el MIDI resultante. Opcional.
//   MIDI: se cuantiza directamente.
// El resultado es un modelo ComposeAnything normal: se puede seguir editando, exportar o empujar a MuseScore.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { newScore, writeMeasures, barLength } = require('./score');
const { midiToName, splitUnits, DUR_BY_UNITS } = require('./dsl');
const { parseMidi } = require('./midi');

// --- WAV -------------------------------------------------------------------------------------

function readWav(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('No es un WAV válido');
  let fmt = null, data = null, p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(p + 8), channels: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22), ext: size >= 26 ? buf.readUInt16LE(p + 32) : null };
    else if (id === 'data') { data = buf.subarray(p + 8, Math.min(buf.length, p + 8 + size)); break; }
    p += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV sin fmt/data');
  const kind = fmt.format === 0xfffe ? fmt.ext : fmt.format;
  const bytes = fmt.bits / 8, frames = Math.floor(data.length / (bytes * fmt.channels));
  const out = new Float32Array(frames);
  const rd = (o) => {
    if (kind === 3 && fmt.bits === 32) return data.readFloatLE(o);
    if (kind !== 1) throw new Error(`Formato WAV no soportado (códec ${kind}, ${fmt.bits} bits)`);
    if (fmt.bits === 8) return (data[o] - 128) / 128;
    if (fmt.bits === 16) return data.readInt16LE(o) / 32768;
    if (fmt.bits === 24) return data.readIntLE(o, 3) / 8388608;
    if (fmt.bits === 32) return data.readInt32LE(o) / 2147483648;
    throw new Error(`WAV de ${fmt.bits} bits no soportado`);
  };
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += rd((f * fmt.channels + c) * bytes);
    out[f] = s / fmt.channels;
  }
  return { rate: fmt.rate, samples: out };
}

function decimate(samples, rate, target = 22050) {
  const k = Math.floor(rate / target);
  if (k < 2) return { samples, rate };
  const n = Math.floor(samples.length / k), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < k; j++) s += samples[i * k + j]; out[i] = s / k; }
  return { samples: out, rate: rate / k };
}

// --- YIN -------------------------------------------------------------------------------------

function yinFrames(x, sr, { hop = 512, win = 1024, fmin = 70, fmax = 1100, threshold = 0.15, silence = 0.04 } = {}) {
  const tauMin = Math.max(2, Math.floor(sr / fmax)), tauMax = Math.min(win, Math.ceil(sr / fmin));
  const rms = (s) => { let a = 0; for (let i = 0; i < win; i++) a += x[s + i] * x[s + i]; return Math.sqrt(a / win); };
  let peak = 0;
  for (let s = 0; s + win + tauMax < x.length; s += hop) peak = Math.max(peak, rms(s));
  const out = [];
  const d = new Float32Array(tauMax + 1);
  for (let s = 0; s + win + tauMax < x.length; s += hop) {
    if (rms(s) < silence * peak || peak === 0) { out.push(null); continue; }
    for (let tau = 1; tau <= tauMax; tau++) { let a = 0; for (let j = 0; j < win; j++) { const df = x[s + j] - x[s + j + tau]; a += df * df; } d[tau] = a; }
    let run = 0; d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; d[tau] = run ? (d[tau] * tau) / run : 1; }
    let tau = -1;
    for (let t = tauMin; t < tauMax; t++) {
      if (d[t] < threshold) { while (t + 1 < tauMax && d[t + 1] < d[t]) t++; tau = t; break; }
    }
    if (tau < 0) { out.push(null); continue; }
    const a = d[tau - 1], b = d[tau], c = d[tau + 1] ?? b;
    const denom = a + c - 2 * b;
    const best = denom ? tau + (a - c) / (2 * denom) : tau;
    out.push(sr / best);
  }
  return { frames: out, hopSec: hop / sr };
}

const f2m = (f) => 69 + 12 * Math.log2(f / 440);

function segmentNotes(frames, hopSec, { minSec = 0.08, gapSec = 0.06 } = {}) {
  const minF = Math.max(2, Math.round(minSec / hopSec)), gapF = Math.round(gapSec / hopSec);
  let runs = [];
  frames.forEach((f, i) => {
    const n = f ? Math.round(f2m(f)) : null;
    const last = runs[runs.length - 1];
    if (last && last.n === n) last.e = i + 1; else runs.push({ n, s: i, e: i + 1 });
  });
  for (let changed = true, guard = 0; changed && guard < 20; guard++) {
    changed = false;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      if (r.e - r.s >= minF) continue;
      const prev = runs[i - 1], next = runs[i + 1];
      if (r.n !== null) {
        const near = (o) => o && o.n !== null && Math.abs(o.n - r.n) <= 1;
        if (near(prev) && (!near(next) || prev.e - prev.s >= next.e - next.s)) { prev.e = r.e; runs.splice(i, 1); changed = true; break; }
        if (near(next)) { next.s = r.s; runs.splice(i, 1); changed = true; break; }
        r.n = null; changed = true;
      } else if (prev && next && prev.n !== null && prev.n === next.n && r.e - r.s <= gapF) { prev.e = next.e; runs.splice(i, 2); changed = true; break; }
    }
    const merged = [];
    for (const r of runs) { const l = merged[merged.length - 1]; if (l && l.n === r.n) l.e = r.e; else merged.push({ ...r }); }
    if (merged.length !== runs.length) changed = true;
    runs = merged;
  }
  return runs.filter((r) => r.n !== null && r.e - r.s >= minF).map((r) => ({ start: r.s * hopSec, end: r.e * hopSec, midi: r.n }));
}

// --- tempo, tonalidad, cuantización ------------------------------------------------------------

function estimateBpm(notes) {
  if (notes.length < 4) return 100;
  const t0 = notes[0].start;
  let best = 100, bestScore = -Infinity;
  for (let bpm = 60; bpm <= 180; bpm++) {
    let s = 0;
    for (const n of notes) s += Math.cos(2 * Math.PI * ((n.start - t0) * bpm) / 30); // rejilla de corcheas
    s *= Math.exp(-((Math.log2(bpm / 100)) ** 2) / 0.6); // preferencia suave por tempos medios
    if (s > bestScore) { bestScore = s; best = bpm; }
  }
  return best;
}

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// Fa#/Sol♭ mayor es enarmónico: se elige Sol♭ (-6). Quien lo necesite en sostenidos puede indicar key explícitamente.
const MAJOR_FIFTHS = { 0: 0, 1: -5, 2: 2, 3: -3, 4: 4, 5: -1, 6: -6, 7: 1, 8: -4, 9: 3, 10: -2, 11: 5 };

function detectKey(notes) {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[((n.midi % 12) + 12) % 12] += Math.max(0.05, n.end - n.start);
  const corr = (a, b) => { const ma = a.reduce((x, y) => x + y) / 12, mb = b.reduce((x, y) => x + y) / 12; let n = 0, da = 0, db = 0; for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db || 1); };
  let best = { r: -2, fifths: 0, mode: 'major' };
  for (let t = 0; t < 12; t++) {
    const rot = (prof) => prof.map((_, i) => prof[(i - t + 12) % 12]);
    const rM = corr(hist, rot(MAJOR_PROFILE)), rm = corr(hist, rot(MINOR_PROFILE));
    if (rM > best.r) best = { r: rM, fifths: MAJOR_FIFTHS[t], mode: 'major' };
    if (rm > best.r) best = { r: rm, fifths: MAJOR_FIFTHS[(t + 3) % 12], mode: 'minor' };
  }
  return best;
}

/**
 * notes: [{start, end, midi}] en NEGRAS (beats). Devuelve {model, info}.
 */
function notesToModel(notes, { time = [4, 4], key = 0, mode = 'major', bpm = 100, title = 'Transcripción', split = false, grid = 6, instrument = 'Melodía' } = {}) {
  if (!notes.length) throw new Error('No se detectaron notas');
  const t0 = notes[0].start;
  const bar = barLength(time);
  const q = notes.map((n) => {
    const s = Math.round(((n.start - t0) * 24) / grid) * grid;
    return { s, e: Math.max(s + grid, Math.round(((n.end - t0) * 24) / grid) * grid), midi: n.midi };
  });
  const lo = Math.min(...notes.map((n) => n.midi)), hi = Math.max(...notes.map((n) => n.midi));
  const useSplit = split && lo < 60 && hi >= 60;
  const staffOf = (m) => (useSplit && m < 60 ? 2 : 1);
  const model = newScore({ title, key, mode, time, tempo: bpm, template: useSplit ? 'piano' : 'solo', options: { instrument, programKey: 'piano', clef: lo < 52 && !useSplit ? 'F' : 'G' } });
  const staves = useSplit ? [1, 2] : [1];
  const lines = {};
  for (const sid of staves) {
    const mine = q.filter((n) => staffOf(n.midi) === sid).sort((a, b) => a.s - b.s || a.midi - b.midi);
    const ev = [];
    for (const n of mine) {
      const last = ev[ev.length - 1];
      if (last && Math.abs(last.s - n.s) < grid) { last.midis.push(n.midi); last.e = Math.min(last.e, n.e); }
      else ev.push({ s: n.s, e: n.e, midis: [n.midi] });
    }
    for (let i = 0; i < ev.length - 1; i++) ev[i].e = Math.min(ev[i].e, ev[i + 1].s);
    lines[sid] = ev.filter((e) => e.e > e.s);
  }
  const end = Math.max(...Object.values(lines).flat().map((e) => e.e));
  const nBars = Math.max(1, Math.ceil(end / bar));
  const items = [];
  for (let n = 1; n <= nBars; n++) {
    const staffText = {};
    for (const sid of staves) {
      const a = (n - 1) * bar, b = n * bar;
      const toks = [];
      let cur = a;
      const rest = (u) => { for (const p of splitUnits(u)) toks.push(`r:${DUR_BY_UNITS[p]}`); };
      for (const e of lines[sid]) {
        if (e.e <= a || e.s >= b) continue;
        const s = Math.max(e.s, a), f = Math.min(e.e, b);
        if (s > cur) rest(s - cur);
        const head = e.midis.length > 1 ? `[${e.midis.map((m) => midiToName(m, key)).join(' ')}]` : midiToName(e.midis[0], key);
        const parts = splitUnits(f - s);
        parts.forEach((p, i) => toks.push(`${head}:${DUR_BY_UNITS[p]}${i < parts.length - 1 || e.e > b ? '!ts' : ''}`));
        cur = f;
      }
      if (cur < b) rest(b - cur);
      staffText[sid] = toks.join(' ');
    }
    items.push({ n, staves: staffText });
  }
  const r = writeMeasures(model, items);
  if (!r.ok) throw new Error('Error interno de cuantización: ' + r.errors.slice(0, 3).join('; '));
  return { model, info: { bars: nBars, notes: notes.length, bpm, key, mode, staves: useSplit ? 2 : 1 } };
}

// --- entrada -----------------------------------------------------------------------------------

function which(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function run(cmd, args, timeout = 600000) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { c.kill(); reject(new Error(`${cmd} tardó demasiado`)); }, timeout);
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`${cmd} falló (${code}): ${out.slice(-300)}`)); });
  });
}

async function toWav(file) {
  if (path.extname(file).toLowerCase() === '.wav') return { wav: file, cleanup: () => {} };
  const ff = which('ffmpeg');
  if (!ff) throw new Error('Para MP3/M4A/OGG/FLAC necesito ffmpeg en el PATH (o convierte el audio a WAV).');
  const tmp = path.join(os.tmpdir(), `ca-${Date.now()}.wav`);
  await run(ff, ['-y', '-i', file, '-ac', '1', '-ar', '22050', tmp]);
  return { wav: tmp, cleanup: () => fs.rmSync(tmp, { force: true }) };
}

function midiToNotes(buf, { keepTracks } = {}) {
  const m = parseMidi(buf);
  const notes = m.notes.filter((n) => !keepTracks || keepTracks.includes(n.track)).map((n) => ({ start: n.start / m.ppq, end: n.end / m.ppq, midi: n.midi }));
  return { notes, bpm: m.tempos[0] ? Math.round(m.tempos[0].bpm) : null, time: m.timeSig };
}

/** Transcribe un archivo de audio o MIDI a un modelo. */
async function transcribe(file, opts = {}) {
  const warnings = [];
  const ext = path.extname(file).toLowerCase();
  let notes, bpm = opts.bpm, time = opts.time, split = false;
  if (ext === '.mid' || ext === '.midi') {
    const r = midiToNotes(fs.readFileSync(file));
    notes = r.notes; bpm ||= r.bpm || 100; time ||= r.time || [4, 4]; split = true;
  } else if (opts.engine === 'polyphonic') {
    const bp = which('basic-pitch');
    if (!bp) throw new Error('El modo polifónico necesita basic-pitch (pip install basic-pitch). Para una melodía sola usa mode "melody".');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-bp-'));
    await run(bp, [out, file]);
    const mid = fs.readdirSync(out).find((f) => f.endsWith('.mid'));
    if (!mid) throw new Error('basic-pitch no generó MIDI');
    const r = midiToNotes(fs.readFileSync(path.join(out, mid)));
    notes = r.notes.map((n) => ({ ...n, start: n.start * 1, end: n.end * 1 })); split = true;
    // basic-pitch escribe el MIDI a 120 bpm: los beats equivalen a segundos*2
    const secs = notes.map((n) => ({ ...n, start: n.start / 2, end: n.end / 2 }));
    bpm ||= estimateBpm(secs); notes = secs.map((n) => ({ ...n, start: (n.start * bpm) / 60, end: (n.end * bpm) / 60 }));
    time ||= [4, 4];
  } else {
    const { wav, cleanup } = await toWav(file);
    try {
      const w = readWav(fs.readFileSync(wav));
      let { samples, rate } = decimate(w.samples, w.rate);
      const max = (opts.maxSeconds || 120) * rate;
      if (samples.length > max) { samples = samples.subarray(0, max); warnings.push(`Audio recortado a ${opts.maxSeconds || 120}s (opción maxSeconds)`); }
      const { frames, hopSec } = yinFrames(samples, rate);
      const secs = segmentNotes(frames, hopSec);
      if (!secs.length) throw new Error('No se detectó ninguna nota (¿es música monofónica y no está muy baja de volumen?)');
      bpm ||= estimateBpm(secs); time ||= [4, 4];
      notes = secs.map((n) => ({ start: (n.start * bpm) / 60, end: (n.end * bpm) / 60, midi: n.midi }));
    } finally { cleanup(); }
  }
  let { key, mode } = opts;
  if (key === undefined) { const k = detectKey(notes); key = k.fifths; mode = k.mode; warnings.push(`Tonalidad detectada automáticamente (${mode}, ${key} alteraciones): revísala.`); }
  const { model, info } = notesToModel(notes, { time, key, mode: mode || 'major', bpm, title: opts.title || path.basename(file, ext), split });
  if (!opts.bpm) warnings.push(`Tempo estimado: ${bpm} ppm; si no suena bien, repite con bpm explícito.`);
  return { model, info, warnings };
}

module.exports = { readWav, yinFrames, segmentNotes, estimateBpm, detectKey, notesToModel, midiToNotes, transcribe };
