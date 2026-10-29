'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const audio = require('../src/core/audio');
const score = require('../src/core/score');
const choir = require('../src/core/choir');
const { lintScore } = require('../src/core/lint');
const { Store } = require('../src/core/store');
const { Profile } = require('../src/core/profile');

const TMP = path.join(__dirname, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

// --- utilidades de síntesis -------------------------------------------------------------------

function wav(samples, rate = 22050) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => b.writeInt16LE(Math.max(-1, Math.min(1, s)) * 32767, 44 + i * 2));
  return b;
}

function synth(notes, bpm, rate = 22050) {
  const beat = 60 / bpm;
  const total = Math.ceil((notes.reduce((m, n) => Math.max(m, n.beat + n.len), 0) + 0.2) * beat * rate);
  const out = new Float32Array(total);
  for (const n of notes) {
    const f = 440 * 2 ** ((n.midi - 69) / 12);
    const a = Math.round(n.beat * beat * rate), b = Math.round((n.beat + n.len) * beat * rate - 0.04 * rate);
    for (let i = a; i < b; i++) {
      const env = Math.min(1, (i - a) / 200, (b - i) / 200);
      out[i] += 0.5 * env * (Math.sin((2 * Math.PI * f * i) / rate) + 0.3 * Math.sin((4 * Math.PI * f * i) / rate));
    }
  }
  return out;
}

function midiFile(events, ppq = 480, bpm = 90) {
  const vlq = (v) => { const o = [v & 0x7f]; while ((v >>= 7)) o.unshift((v & 0x7f) | 0x80); return o; };
  const trk = [0, 0xff, 0x51, 3, ...Buffer.from([(6e7 / bpm >> 16) & 255, (6e7 / bpm >> 8) & 255, (6e7 / bpm) & 255])];
  let t = 0;
  for (const e of events.sort((a, b) => a.tick - b.tick || a.on - b.on)) { trk.push(...vlq(e.tick - t), e.on ? 0x90 : 0x80, e.midi, e.on ? 80 : 0); t = e.tick; }
  trk.push(0, 0xff, 0x2f, 0);
  const head = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 255]);
  const len = Buffer.alloc(4); len.writeUInt32BE(trk.length);
  return Buffer.concat([head, Buffer.from('MTrk'), len, Buffer.from(trk)]);
}

// --- audio ------------------------------------------------------------------------------------

test('audio: WAV de 16 bits se lee de vuelta', () => {
  const s = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5) * 0.5);
  const r = audio.readWav(wav(s, 8000));
  assert.equal(r.rate, 8000);
  assert.equal(r.samples.length, 100);
  assert.ok(Math.abs(r.samples[20] - s[20]) < 1e-3);
});

test('audio: transcribe una melodía sintética a partitura editable', async () => {
  const melody = [60, 64, 67, 72, 67, 64].map((midi, i) => ({ midi, beat: i, len: 1 }));
  const file = path.join(TMP, 'melodia.wav');
  fs.writeFileSync(file, wav(synth(melody, 100)));
  const { model, info, warnings } = await audio.transcribe(file, { bpm: 100, key: 0, mode: 'major', title: 'Prueba' });
  assert.equal(info.bars, 2);
  assert.equal(model.meta.title, 'Prueba');
  assert.equal(model.measures[1].staves[1], 'C4:q E4:q G4:q C5:q');
  assert.equal(model.measures[2].staves[1], 'G4:q E4:q r:h');
  assert.equal(warnings.some((w) => /Tonalidad detectada/.test(w)), false);
  // El modelo es normal: se puede seguir escribiendo encima.
  assert.equal(score.writeMeasures(model, [{ n: 3, staves: { 1: 'C5:w' } }]).ok, true);
});

test('audio: estima tempo y tonalidad', () => {
  const notes = Array.from({ length: 10 }, (_, k) => ({ start: k * 0.6, end: k * 0.6 + 0.5, midi: 60 }));
  assert.equal(audio.estimateBpm(notes), 100);
  const em = [63, 65, 66, 68, 70, 71, 73, 75, 63, 66, 70, 63].map((midi, i) => ({ start: i, end: i + 1, midi }));
  assert.deepEqual({ ...audio.detectKey(em), r: 0 }, { r: 0, fifths: -6, mode: 'minor' });
  const g = [67, 69, 71, 72, 74, 76, 78, 67, 71, 74, 67].map((midi, i) => ({ start: i, end: i + 1, midi }));
  assert.equal(audio.detectKey(g).fifths, 1);
});

test('MIDI: dos manos, acorde y ligadura entre compases', async () => {
  const ppq = 480;
  const ev = [];
  const note = (midi, beat, len) => { ev.push({ tick: beat * ppq, midi, on: 1 }, { tick: (beat + len) * ppq, midi, on: 0 }); };
  note(72, 0, 1); note(74, 1, 1); note(76, 2, 1); note(79, 3, 2); // el sol dura 2 negras: cruza la barra
  note(48, 0, 4); note(52, 0, 4); // bajo + acorde largo en la mano izquierda
  const file = path.join(TMP, 'dos-manos.mid');
  fs.writeFileSync(file, midiFile(ev, ppq, 90));
  const { model, info } = await audio.transcribe(file, { key: 0, mode: 'major' });
  assert.equal(info.bpm, 90);
  assert.equal(model.meta.template, 'piano'); // se reparte en dos pentagramas
  assert.equal(model.measures[1].staves[1], 'C5:q D5:q E5:q G5:q!ts');
  assert.equal(model.measures[2].staves[1], 'G5:q r:hd');
  assert.equal(model.measures[1].staves[2], '[C3 E3]:w');
});

// --- coro -------------------------------------------------------------------------------------

function satb(extra = {}) {
  const m = score.newScore({ key: 0, time: [4, 4], template: 'satb_open' });
  const r = score.writeMeasures(m, [
    { n: 1, staves: { 1: 'G4:q A4:q B4:h', 2: 'E4:w', 3: 'C4:w', 4: 'C3:q D3:q G2:h', ...extra } },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  return m;
}

test('coro: detecta quintas paralelas, cruces y tesitura', () => {
  const r = choir.checkChoir(satb());
  assert.equal(r.applicable, true);
  const rules = r.issues.map((i) => i.rule);
  assert.ok(rules.includes('quintas'), JSON.stringify(r.issues));
  assert.ok(!rules.includes('cruce'));

  const crossed = choir.checkChoir(satb({ 2: 'B4:w' })); // el alto por encima de la soprano en algún tiempo
  assert.ok(crossed.issues.some((i) => i.rule === 'cruce'));
  const range = choir.checkChoir(satb({ 4: 'C5:w' }));
  assert.ok(range.issues.some((i) => i.rule === 'tesitura' && /bajo/.test(i.text)));
  assert.equal(lintScore(satb()).ok, false);
});

test('coro cerrado: SA y TB comparten pentagrama con dos voces', () => {
  const m = score.newScore({ key: 0, time: [4, 4], template: 'satb_closed' });
  const w = score.writeMeasures(m, [{ n: 1, staves: { 1: 'E5:w || C5:w', 2: 'G3:w || C3:w' } }]);
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.deepEqual(choir.choirVoices(m).map((v) => `${v.label}${v.staff}${v.voice}`), ['S10', 'A11', 'T20', 'B21']);
  assert.equal(choir.checkChoir(m).issues.filter((i) => i.severity === 'error').length, 0);
});

test('coro: la letra se reparte, respeta ligaduras y se reemplaza sin duplicar', () => {
  assert.deepEqual(choir.syllabify('Glo-ri-a in ex-cel-sis'), ['Glo-', 'ri-', 'a', 'in', 'ex-', 'cel-', 'sis']);
  const m = score.newScore({ key: 0, time: [4, 4], template: 'satb_open' });
  score.writeMeasures(m, [
    { n: 1, staves: { 1: 'C5:q D5:q E5:h!ts' } },
    { n: 2, staves: { 1: 'E5:h F5:h' } }, // el mi del compás 2 es la nota ligada: sin sílaba propia
  ]);
  const r = choir.setLyrics(m, { staff: 1, from: 1, text: 'Glo-ri-a in' });
  assert.equal(r.assigned, 4);
  assert.equal(m.measures[1].staves[1], 'C5:q!l=Glo- D5:q!l=ri- E5:h!ts!l=a');
  assert.equal(m.measures[2].staves[1], 'E5:h F5:h!l=in');
  choir.setLyrics(m, { staff: 1, from: 1, text: 'Glo-ri-a in' }); // idempotente
  assert.equal(m.measures[1].staves[1], 'C5:q!l=Glo- D5:q!l=ri- E5:h!ts!l=a');
  choir.setLyrics(m, { staff: 1, from: 1, text: 'Ky-ri-e', verse: 2 });
  assert.match(m.measures[1].staves[1], /!l2=Ky-/);
  assert.equal(score.validateMeasure(m, 1, m.measures[1]).errors.length, 0);
});

// --- perfil y almacén -------------------------------------------------------------------------

test('perfil de gustos: añade sin duplicar y se convierte en prompt', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'home-'));
  const store = new Store(dir);
  const p = new Profile(store);
  p.addWork({ title: 'Mazurka Op. 33 n.º 2', composer: 'Chopin', notes: 'rubato y cantabile' });
  p.addWork({ title: 'Mazurka Op. 33 n.º 2', composer: 'Chopin', notes: 'oom-pah-pah' });
  p.setNotes({ styleNotes: 'oscuro y expresionista', dislikes: ['final alegre'] });
  assert.equal(p.data.likedWorks.length, 1);
  assert.equal(p.data.likedWorks[0].notes, 'oom-pah-pah');
  assert.match(new Profile(store).toPrompt(), /Chopin[\s\S]*oscuro y expresionista[\s\S]*final alegre/);
  assert.throws(() => p.removeWork('no existe'), /no hay ninguna obra/);
});

test('almacén: ajustes por defecto, autonomía fija el intervalo y escritura atómica', () => {
  const store = new Store(fs.mkdtempSync(path.join(TMP, 'home-')));
  assert.equal(store.settings().autonomy, 'per_measure');
  const s = store.saveSettings({ autonomy: 'per_phrase' });
  assert.equal(s.checkpointEvery, 4);
  assert.equal(store.saveSettings({ autonomy: 'autonomous' }).checkpointEvery, Infinity);
  store.saveProject({ hola: 1 });
  assert.deepEqual(store.loadProject(), { hola: 1 });
  assert.deepEqual(fs.readdirSync(store.file('projects')).filter((f) => f.endsWith('.tmp')), []);
});
