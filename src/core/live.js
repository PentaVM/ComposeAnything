'use strict';
// Puente en vivo con el plugin de MuseScore (WebSocket local, puerto 8765).
//
// pushMeasures escribe el modelo en la hoja abierta de forma IDEMPOTENTE: para cada compás y pentagrama
// selecciona el rango, lo vacía y escribe encima, así que repetir una escritura nunca duplica notas.
// Después relee la hoja (getScore) y compara con el modelo para detectar cualquier desajuste.

const WebSocket = require('ws');
const { parseStream, splitVoices } = require('./dsl');
const { staffList, measureCount, contextAt, barLength } = require('./score');

const TICKS_PER_UNIT = 20; // 480 ticks por negra / 24 unidades por negra
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const fraction = (units) => { const g = gcd(units, 96); return { numerator: units / g, denominator: 96 / g }; };

class LiveClient {
  constructor({ url, timeout = 20000 } = {}) {
    this.url = url || process.env.COMPOSEANYTHING_WS || 'ws://127.0.0.1:8765';
    this.timeout = timeout;
    this.ws = null;
    this.queue = Promise.resolve();
  }

  get connected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const fail = (e) => reject(new Error(`No puedo conectar con MuseScore en ${this.url}. Abre una partitura y ejecuta Plugins → ComposeAnything (${e.message || e}).`));
      ws.once('open', () => { this.ws = ws; ws.on('close', () => { if (this.ws === ws) this.ws = null; }); ws.on('error', () => {}); resolve(); });
      ws.once('error', fail);
    });
  }

  _roundtrip(payload) {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      const timer = setTimeout(() => { cleanup(); reject(new Error(`MuseScore no respondió a "${payload.action}" en ${this.timeout / 1000}s`)); }, this.timeout);
      const onMsg = (data) => { cleanup(); try { resolve(JSON.parse(String(data))); } catch (e) { reject(e); } };
      const onClose = () => { cleanup(); reject(new Error('La conexión con MuseScore se cerró')); };
      const cleanup = () => { clearTimeout(timer); ws.off('message', onMsg); ws.off('close', onClose); };
      ws.once('message', onMsg);
      ws.once('close', onClose);
      ws.send(JSON.stringify(payload));
    });
  }

  /** Envía una acción y devuelve `result`. Las peticiones se serializan (el plugin responde 1 a 1). */
  send(action, params = {}) {
    const run = async () => {
      if (!this.connected) await this.connect();
      let msg;
      try { msg = await this._roundtrip({ action, params }); } catch (e) {
        this.ws = null;
        await this.connect();
        msg = await this._roundtrip({ action, params });
      }
      if (msg.status === 'error') throw new Error(msg.message || `error en ${action}`);
      const r = msg.result;
      if (r && typeof r === 'object' && r.error) throw new Error(`${action}: ${r.error}`);
      return r;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  close() { if (this.ws) { this.ws.close(); this.ws = null; } }
}

async function readScore(client) {
  const r = await client.send('getScore', {});
  const a = r && r.analysis;
  if (!a || !a.measures) throw new Error('El plugin no devolvió la partitura (¿hay una hoja abierta?)');
  return a;
}

async function getCaps(client) {
  try {
    const c = await client.send('getCapabilities', {});
    return { actions: new Set(c.actions || []), voiceParam: !!c.voiceParam, raw: c, extended: true };
  } catch {
    return { actions: new Set(), voiceParam: false, raw: null, extended: false };
  }
}

async function status(client) {
  const out = { connected: false, plugin: null, error: null };
  try {
    const pong = await client.send('ping', {});
    out.connected = pong === 'pong';
    const caps = await getCaps(client);
    out.plugin = caps.extended ? { ...caps.raw } : { plugin: 'mcp-musescore (sin extensiones)' };
    const a = await readScore(client);
    out.score = { title: a.title, numMeasures: a.numMeasures, numStaves: a.staves.length };
  } catch (e) { out.error = e.message; }
  return out;
}

function expectedSeq(tokens) {
  return tokens.filter((t) => t.kind !== 'dir').map((t) => (t.kind === 'rest'
    ? { rest: true, midis: [], names: [] }
    : { rest: false, midis: t.pitches.map((p) => p.midi).sort((a, b) => a - b), names: t.pitches.slice().sort((a, b) => a.midi - b.midi).map((p) => p.name.replace(/-?\d+$/, '')) }));
}

function actualSeq(els) {
  return (els || []).filter((e) => (e.voice || 0) === 0).sort((a, b) => a.startTick - b.startTick).map((e) => (e.name === 'Rest'
    ? { rest: true, midis: [], names: [] }
    : { rest: false, midis: (e.notes || []).map((n) => n.pitchMidi).sort((a, b) => a - b), names: (e.notes || []).slice().sort((a, b) => a.pitchMidi - b.pitchMidi).map((n) => n.pitchName) }));
}

async function applyDirective(client, caps, report, d, tick, staff) {
  const bump = (k) => { report.unsupportedLive[k] = (report.unsupportedLive[k] || 0) + 1; };
  try {
    switch (d.name) {
      case 'harm': if (caps.actions.has('addHarmony')) return await client.send('addHarmony', { tick, staff, text: d.arg }); return bump('harm');
      case 'dyn': if (caps.actions.has('addDynamic')) return await client.send('addDynamic', { tick, staff, name: d.arg }); return bump('dyn');
      case 'txt': if (caps.actions.has('addStaffText')) return await client.send('addStaffText', { tick, staff, text: d.arg }); return bump('txt');
      case 'reh': if (caps.actions.has('addRehearsalMark')) return await client.send('addRehearsalMark', { tick, staff, text: d.arg }); return bump('reh');
      case 'tempo': case 'play': {
        await client.send('selectCustomRange', { startTick: tick, endTick: tick + TICKS_PER_UNIT, startStaff: staff, endStaff: staff + 1 });
        return await client.send('setTempo', { bpm: Number(d.arg.split(/\s+/)[0]) });
      }
      default: return bump(d.name); // cresc, dim, wedge, ped: solo por MusicXML
    }
  } catch (e) {
    report.warnings.push(`directiva {${d.name}} en tick ${tick}: ${e.message}`);
  }
}

function collectLyrics(model, from, to, sid) {
  const verses = {}; // verso -> [{text, syllabic}]
  const open = {};
  for (let n = from; n <= to; n++) {
    const text = model.measures[n]?.staves?.[sid];
    if (!text) continue;
    const tokens = parseStream(splitVoices(text)[0]);
    for (const t of tokens) {
      if (t.kind !== 'note') continue;
      const seen = new Set();
      for (const m of t.mods) {
        const mm = /^l(\d?)=(.+)$/.exec(m);
        if (!mm) continue;
        const verse = Number(mm[1] || 1);
        seen.add(verse);
        let txt = mm[2];
        const cont = txt.endsWith('-');
        if (cont) txt = txt.slice(0, -1);
        const syllabic = cont ? (open[verse] ? 'middle' : 'begin') : (open[verse] ? 'end' : 'single');
        open[verse] = cont;
        (verses[verse] ||= []).push({ text: txt.replace(/_/g, ' '), syllabic });
      }
      for (const v of Object.keys(verses)) if (!seen.has(Number(v))) verses[v].push({ text: '', syllabic: 'single' });
    }
  }
  return verses;
}

/** Escribe compases del modelo en la hoja abierta. */
async function pushMeasures(client, model, { from = 1, to = measureCount(model), verify = true } = {}) {
  const report = { pushed: [], warnings: [], unsupportedLive: {}, ties: 0, verify: null, extended: false };
  const caps = await getCaps(client);
  report.extended = caps.extended;
  let analysis = await readScore(client);
  if (analysis.numMeasures < to) {
    await client.send('appendMeasure', { count: to - analysis.numMeasures });
    analysis = await readScore(client);
  }
  const modelStaves = staffList(model).length;
  if (analysis.staves.length < modelStaves) {
    throw new Error(`La hoja abierta tiene ${analysis.staves.length} pentagrama(s) y la obra necesita ${modelStaves}. Crea la hoja con los mismos instrumentos o usa export + open.`);
  }
  const starts = analysis.measures.map((m) => m.startTick);

  for (let n = from; n <= to; n++) {
    const m = model.measures[n];
    if (!m) continue;
    const ctx = contextAt(model, n);
    const startTick = starts[n - 1];
    const endTick = starts[n] ?? startTick + barLength(ctx.time) * TICKS_PER_UNIT;
    const done = [];
    if (m.time && n > 1) {
      await client.send('selectCustomRange', { startTick, endTick, startStaff: 0, endStaff: 1 });
      await client.send('setTimeSignature', { numerator: m.time[0], denominator: m.time[1] });
    }
    for (const [sid, text] of Object.entries(m.staves || {})) {
      const idx = Number(sid) - 1;
      const range = { startTick, endTick, startStaff: idx, endStaff: idx + 1 };
      await client.send('selectCustomRange', range);
      if (caps.actions.has('clearStaffRange')) await client.send('clearStaffRange', { startTick, endTick, staff: idx });
      else await client.send('deleteSelection', {});
      const voices = splitVoices(text);
      for (let vi = 0; vi < voices.length; vi++) {
        if (vi > 0 && !caps.voiceParam) { report.warnings.push(`compás ${n} pentagrama ${sid}: la voz ${vi + 1} necesita el plugin de ComposeAnything; se omite en vivo (usa export + open)`); continue; }
        const tokens = parseStream(voices[vi]);
        await client.send('selectCustomRange', range);
        let pos = 0;
        const dirs = [];
        for (const t of tokens) {
          if (t.kind === 'dir') { dirs.push({ ...t, pos }); continue; }
          const duration = fraction(t.dur);
          if (t.kind === 'rest') await client.send('addRest', { duration, advanceCursorAfterAction: true, voice: vi });
          else {
            if (t.mods.includes('ts')) report.ties++;
            for (let k = 0; k < t.pitches.length; k++) {
              await client.send('addNote', { pitch: t.pitches[k].midi, duration, advanceCursorAfterAction: k === t.pitches.length - 1, addToChord: k > 0, voice: vi });
            }
          }
          pos += t.dur;
        }
        if (vi === 0) for (const d of dirs) await applyDirective(client, caps, report, d, startTick + d.pos * TICKS_PER_UNIT, idx);
      }
      done.push(sid);
    }
    if (m.key !== undefined && n > 1 && caps.actions.has('setKeySignature')) {
      for (let i = 0; i < modelStaves; i++) await client.send('setKeySignature', { fifths: m.key, tick: startTick, staff: i });
    }
    report.pushed.push({ measure: n, staves: done });
  }

  // Letra (verso por verso, un pentagrama a la vez).
  for (const s of staffList(model)) {
    const verses = collectLyrics(model, from, to, s.global);
    for (const [verse, lyrics] of Object.entries(verses)) {
      try {
        if (caps.actions.has('addLyricsSyllabic')) await client.send('addLyricsSyllabic', { tick: starts[from - 1], staff: s.global - 1, verse: Number(verse) - 1, lyrics });
        else {
          await client.send('selectCustomRange', { startTick: starts[from - 1], endTick: starts[from - 1] + TICKS_PER_UNIT, startStaff: s.global - 1, endStaff: s.global });
          await client.send('addLyrics', { lyrics: lyrics.map((l) => l.text), verse: Number(verse) - 1 });
        }
      } catch (e) { report.warnings.push(`letra del pentagrama ${s.global}: ${e.message}`); }
    }
  }

  if (verify) report.verify = await verifyMeasures(client, model, from, to);
  return report;
}

/** Relee la hoja y compara voz 1 de cada compás/pentagrama con el modelo. */
async function verifyMeasures(client, model, from, to) {
  const a = await readScore(client);
  const mismatches = [];
  let checked = 0, spelling = 0;
  for (let n = from; n <= to; n++) {
    const m = model.measures[n];
    if (!m) continue;
    for (const [sid, text] of Object.entries(m.staves || {})) {
      const exp = expectedSeq(parseStream(splitVoices(text)[0]));
      const act = actualSeq(a.measures[n - 1]?.elements?.[`staff${Number(sid) - 1}`]);
      checked++;
      const same = exp.length === act.length && exp.every((e, i) => e.rest === act[i].rest && e.midis.join() === act[i].midis.join());
      if (!same) { if (mismatches.length < 20) mismatches.push({ measure: n, staff: sid, expected: exp.length, found: act.length }); continue; }
      if (exp.some((e, i) => e.names.join() !== act[i].names.join())) spelling++;
    }
  }
  return { checked, ok: mismatches.length === 0, mismatches, spellingDifferences: spelling };
}

/** Ajusta tempo, compás y armadura del principio de la hoja (solo si se pide explícitamente). */
async function prepareScore(client, model) {
  const caps = await getCaps(client);
  const done = [];
  await client.send('selectCustomRange', { startTick: 0, endTick: TICKS_PER_UNIT, startStaff: 0, endStaff: 1 });
  await client.send('setTimeSignature', { numerator: model.meta.time[0], denominator: model.meta.time[1] }); done.push('time');
  await client.send('setTempo', { bpm: model.meta.tempo }); done.push('tempo');
  if (caps.actions.has('setKeySignature')) {
    for (let i = 0; i < staffList(model).length; i++) await client.send('setKeySignature', { fifths: model.meta.key, tick: 0, staff: i });
    done.push('key');
  }
  return done;
}

module.exports = { LiveClient, pushMeasures, verifyMeasures, prepareScore, status, readScore, getCaps, TICKS_PER_UNIT };
