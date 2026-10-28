'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const dsl = require('../src/core/dsl');
const score = require('../src/core/score');
const { toMusicXML, fromMusicXML } = require('../src/core/musicxml');
const { findMuseScore, convert } = require('../src/core/musescore');
const { parseChord, formatChord } = require('../src/core/chord');

const TMP = path.join(__dirname, '.tmp');
fs.mkdirSync(TMP, { recursive: true });
const MAZURKA = path.join(__dirname, '..', 'examples', 'mazurka-op1', 'Mazurka_Op1_reconstruccion.musicxml');

test('alturas: parse y deletreo según la armadura', () => {
  assert.equal(dsl.parsePitch('Eb4').midi, 63);
  assert.equal(dsl.parsePitch('Cb5').midi, 71);
  assert.equal(dsl.midiToName(71, -6), 'Cb5'); // 6 bemoles: Do bemol, no Si
  assert.equal(dsl.midiToName(66, -6), 'Gb4');
  assert.equal(dsl.midiToName(66, 2), 'F#4');
  assert.equal(dsl.midiToName(60, 0), 'C4');
  assert.throws(() => dsl.parsePitch('H4'), /altura inválida/);
});

test('DSL: errores claros y serialización estable', () => {
  assert.throws(() => dsl.parseStream('Eb4'), /sin duración/);
  assert.throws(() => dsl.parseStream('Eb4:zz'), /duración desconocida/);
  assert.throws(() => dsl.parseStream('Eb4:q!nope'), /marca desconocida/);
  assert.throws(() => dsl.parseStream('{dyn xx} r:q'), /dinámica desconocida/);
  const src = '{harm Ebm} {dyn p} [Bb2 Eb3]:q!stac Eb4:ed!acc!s( F4:s!s) r:h';
  assert.equal(dsl.serialize(dsl.parseStream(src)), src);
  assert.equal(dsl.streamLength(dsl.parseStream(src)), 24 + 18 + 6 + 48);
});

test('cifrados: parse y formato', () => {
  const c = parseChord('Gbmaj7/Cb');
  assert.deepEqual(c.bass, { step: 'C', alter: -1 });
  assert.equal(c.kind, 'major-seventh');
  assert.equal(formatChord(parseChord('Ab7b9')), 'Ab7b9');
  assert.equal(formatChord(parseChord('C#m7b5')), 'C#m7b5');
  assert.throws(() => parseChord('Hm'), /cifrado/);
  assert.throws(() => parseChord('Cfoo'), /no reconocido/);
});

test('score: la escritura es idempotente y atómica', () => {
  const m = score.newScore({ title: 'T', key: -6, mode: 'minor', time: [3, 4] });
  const ok = score.writeMeasures(m, [{ n: 1, staves: { 1: 'Eb4:hd', 2: 'Eb2:q [Bb2 Eb3]:h' } }]);
  assert.equal(ok.ok, true);
  const again = score.writeMeasures(m, [{ n: 1, staves: { 1: 'Eb4:hd', 2: 'Eb2:q [Bb2 Eb3]:h' } }]);
  assert.equal(again.ok, true);
  assert.equal(score.measureCount(m), 1);
  assert.equal(Object.keys(m.measures).length, 1);
  // Reescribir un compás lo reemplaza, no lo añade.
  score.writeMeasures(m, [{ n: 1, staves: { 1: 'F4:hd' } }]);
  assert.equal(m.measures[1].staves[1], 'F4:hd');
  assert.equal(m.measures[1].staves[2], 'Eb2:q [Bb2 Eb3]:h'); // el pentagrama no mencionado se conserva
  // Una escritura con un compás malo no aplica ninguno.
  const before = JSON.stringify(m);
  const bad = score.writeMeasures(m, [{ n: 2, staves: { 1: 'F4:hd' } }, { n: 3, staves: { 1: 'F4:q' } }]);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /compás 3.*suma 1 negras.*necesita 3/);
  assert.equal(JSON.stringify(m), before);
  // Pentagrama inexistente.
  assert.equal(score.writeMeasures(m, [{ n: 2, staves: { 9: 'F4:hd' } }]).ok, false);
});

test('score: cambios de compás de tiempo, tesitura y resumen', () => {
  const m = score.newScore({ key: 0, time: [4, 4], template: 'satb_open' });
  const r = score.writeMeasures(m, [
    { n: 1, staves: { 1: 'C5:w', 2: 'E4:w', 3: 'G3:w', 4: 'C3:w' } },
    { n: 2, time: [3, 4], staves: { 1: 'D5:hd', 2: 'F4:hd', 3: 'B3:hd', 4: 'G2:hd' } },
  ]);
  assert.equal(r.ok, true);
  assert.equal(score.writeMeasures(m, [{ n: 3, staves: { 1: 'C5:w' } }]).ok, false); // 3/4 sigue en vigor
  assert.match(score.describeRange(m, 1, 2), /Soprano: C5/);
  assert.match(score.dumpMeasures(m, 1, 2), /m2 \[time=3\/4\]/);
  const del = score.deleteMeasures(m, 1);
  assert.equal(del.newCount, 1);
});

test('historial: deshacer y rehacer', () => {
  const m = score.newScore({ time: [3, 4] });
  const h = new score.ScoreHistory();
  h.push(m);
  score.writeMeasures(m, [{ n: 1, staves: { 1: 'C4:hd' } }]);
  const prev = h.undo(m);
  assert.equal(score.measureCount(prev), 0);
  const redo = h.redo(prev);
  assert.equal(redo.measures[1].staves[1], 'C4:hd');
  assert.equal(h.undo({}) !== null, true);
});

test('MusicXML: exportar es XML válido con armadura, cifrados, letra y ligaduras', () => {
  const m = score.newScore({ title: 'Coral', key: -3, mode: 'major', time: [4, 4], template: 'satb_open' });
  const w = score.writeMeasures(m, [
    { n: 1, staves: { 1: '{harm Eb} {dyn mp} G4:h!l=Glo- G4:h!ts!l=ria', 2: 'Bb3:w', 3: 'G3:w', 4: 'Eb3:w' } },
    { n: 2, staves: { 1: 'G4:w!fer!l=_', 2: 'Bb3:w', 3: 'G3:w', 4: 'Eb3:w' } },
  ]);
  assert.equal(w.ok, true, JSON.stringify(w));
  const xml = toMusicXML(m);
  const doc = new XMLParser({ ignoreAttributes: false }).parse(xml);
  const pw = doc['score-partwise'];
  assert.equal(pw['part-list']['score-part'].length, 4);
  assert.match(xml, /<fifths>-3<\/fifths>/);
  assert.match(xml, /<syllabic>begin<\/syllabic><text>Glo<\/text>/);
  assert.match(xml, /<syllabic>end<\/syllabic><text>ria<\/text>/);
  assert.match(xml, /<tie type="start"\/>/);
  assert.match(xml, /<clef-octave-change>-1<\/clef-octave-change>/); // tenor
  assert.match(xml, /<fermata type="upright"\/>/);
});

test('MusicXML: ida y vuelta conserva el DSL (piano, dos voces por pentagrama)', () => {
  const m = score.newScore({ title: 'RT', key: -6, mode: 'minor', time: [3, 4], tempo: 120, template: 'piano' });
  const w = score.writeMeasures(m, [
    { n: 1, staves: { 1: '{harm Ebm} {dyn p} Eb4:ed!acc F4:s Gb4:q Bb4:q || Bb3:hd', 2: '{ped s} Eb2:q [Bb2 Eb3 Gb3]:q [Bb2 Eb3 Gb3]:q' } },
    { n: 2, staves: { 1: 'Cb5:q!ten!s( Db5:e Eb5:e!s) Eb6:q!acc!ts', 2: '{ped c} Eb2:q [Gb2 Bb2 Eb3]:q [Gb2 Bb2 Eb3]:q' } },
    { n: 3, staves: { 1: 'Eb6:hd!fer', 2: 'r:hd' } },
  ]);
  assert.equal(w.ok, true, JSON.stringify(w));
  const back = fromMusicXML(toMusicXML(m));
  assert.deepEqual(back.warnings, []);
  assert.equal(back.model.meta.key, -6);
  assert.deepEqual(back.model.meta.time, [3, 4]);
  assert.equal(back.model.parts[0].staves.length, 2);
  for (const n of [1, 2, 3]) {
    for (const s of ['1', '2']) assert.equal(back.model.measures[n].staves[s], m.measures[n].staves[s], `m${n} staff ${s}`);
  }
});

test('MusicXML: importa la mazurka real y la reexporta sin perder notas', () => {
  const xml = fs.readFileSync(MAZURKA, 'utf8');
  const { model, warnings } = fromMusicXML(xml);
  assert.deepEqual(warnings, []);
  assert.equal(score.measureCount(model), 43);
  assert.equal(model.meta.key, -6);
  assert.equal(model.parts[0].staves.length, 2);
  const out = toMusicXML(model);
  const notes = (s) => (s.match(/<note>/g) || []).length;
  assert.equal(notes(out), notes(xml));
  const again = fromMusicXML(out).model;
  for (let n = 1; n <= 43; n++) assert.deepEqual(again.measures[n].staves, model.measures[n].staves, `compás ${n}`);
  // Cada compás importado debe seguir siendo válido para el validador del modelo.
  for (let n = 1; n <= 43; n++) assert.deepEqual(score.validateMeasure(model, n, model.measures[n]).errors, [], `compás ${n}`);
});

const exe = findMuseScore();
test('MuseScore real: el XML generado abre y se exporta a PDF', { skip: !exe && 'MuseScore no instalado' }, async () => {
  const m = score.newScore({ title: 'CLI', key: -3, time: [4, 4], template: 'voice_piano' });
  score.writeMeasures(m, [{ n: 1, staves: { 1: '{harm Cm} G4:q!l=Ho- A4:q!l=la C5:h!l=_', 2: 'Eb4:w', 3: 'Eb3:q [G3 C4]:q [G3 C4]:q [G3 C4]:q' } }]);
  const xml = path.join(TMP, 'cli.musicxml');
  fs.writeFileSync(xml, toMusicXML(m));
  const out = await convert(xml, path.join(TMP, 'cli.pdf'));
  assert.ok(fs.statSync(out[0]).size > 2000);
});

test('MuseScore real: mscz -> MusicXML -> modelo (editar partituras existentes)', { skip: !exe && 'MuseScore no instalado' }, async () => {
  const mscz = path.join(TMP, 'rt.mscz');
  await convert(MAZURKA, mscz);
  const mxml = path.join(TMP, 'rt-from-mscz.musicxml');
  await convert(mscz, mxml);
  const { model } = fromMusicXML(fs.readFileSync(mxml, 'utf8'));
  assert.equal(score.measureCount(model), 43);
  assert.equal(model.meta.key, -6);
  assert.ok(Object.keys(model.measures[1].staves).length >= 2);
});
