'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { startMock } = require('../src/dev/mock-musescore');
const { LiveClient, pushMeasures, status, prepareScore } = require('../src/core/live');
const score = require('../src/core/score');

function sample() {
  const m = score.newScore({ title: 'Live', key: -6, mode: 'minor', time: [3, 4], tempo: 120 });
  const w = score.writeMeasures(m, [
    { n: 1, staves: { 1: '{harm Ebm} {dyn p} Eb4:ed F4:s Gb4:q Bb4:q', 2: '{ped s} Eb2:q [Bb2 Eb3 Gb3]:q [Bb2 Eb3 Gb3]:q' } },
    { n: 2, staves: { 1: 'Cb5:q!ten r:q [Gb4 Bb4]:q', 2: 'Eb2:hd' } },
    { n: 3, staves: { 1: '{txt dolce} Eb5:hd!fer', 2: 'r:hd' } },
  ]);
  assert.equal(w.ok, true, JSON.stringify(w));
  return m;
}

test('en vivo: estado, escritura, verificación y reescritura idempotente', async () => {
  const mock = await startMock({ staves: 2, measures: 1, fifths: -6 });
  const client = new LiveClient({ url: mock.url });
  try {
    const st = await status(client);
    assert.equal(st.connected, true);
    assert.equal(st.plugin.plugin, 'composeanything');

    const model = sample();
    const r1 = await pushMeasures(client, model);
    assert.deepEqual(r1.pushed.map((p) => p.measure), [1, 2, 3]);
    assert.equal(mock.state.nMeasures, 3); // añadió los compases que faltaban
    assert.equal(r1.verify.ok, true, JSON.stringify(r1.verify));
    assert.equal(r1.verify.checked, 6);
    assert.equal(r1.verify.spellingDifferences, 0);
    // directivas en el tick correcto: {harm} en el compás 1, {txt} en el compás 3 (tick 2*1440 = 2880)
    const harm = mock.state.extras.find((e) => e.action === 'addHarmony');
    assert.deepEqual(harm.params, { tick: 0, staff: 0, text: 'Ebm' });
    const txt = mock.state.extras.find((e) => e.action === 'addStaffText');
    assert.equal(txt.params.tick, 2880);
    assert.equal(r1.unsupportedLive.ped, 1); // el pedal solo viaja por MusicXML

    const snapshot = JSON.stringify(mock.state.staves);
    const r2 = await pushMeasures(client, model); // idempotente: mismo resultado, sin duplicar
    assert.equal(r2.verify.ok, true);
    assert.equal(JSON.stringify(mock.state.staves), snapshot);

    // Reescribir un compás lo reemplaza
    score.writeMeasures(model, [{ n: 2, staves: { 1: 'D5:hd' } }]);
    const r3 = await pushMeasures(client, model, { from: 2, to: 2 });
    assert.equal(r3.verify.ok, true);
    const m2 = mock.state.staves[0].filter((e) => e.tick >= 1440 && e.tick < 2880);
    assert.equal(m2.length, 1);
    assert.deepEqual(m2[0].notes, [74]);
  } finally { client.close(); await mock.close(); }
});

test('en vivo: detecta pentagramas insuficientes y grafías distintas', async () => {
  const mock = await startMock({ staves: 1, measures: 1, fifths: 0 });
  const client = new LiveClient({ url: mock.url });
  try {
    await assert.rejects(pushMeasures(client, sample()), /necesita 2/);
  } finally { client.close(); await mock.close(); }

  const mock2 = await startMock({ staves: 2, measures: 1, fifths: 0 }); // la hoja deletrea en sostenidos
  const c2 = new LiveClient({ url: mock2.url });
  try {
    const r = await pushMeasures(c2, sample());
    assert.equal(r.verify.ok, true); // mismas alturas...
    assert.ok(r.verify.spellingDifferences > 0); // ...pero la armadura de la hoja no coincide
  } finally { c2.close(); await mock2.close(); }
});

test('en vivo: sin las extensiones del plugin degrada con avisos, sin romper', async () => {
  const mock = await startMock({ staves: 2, measures: 3, extras: false });
  const client = new LiveClient({ url: mock.url });
  try {
    const model = sample();
    score.writeMeasures(model, [{ n: 1, staves: { 1: '{harm Ebm} Eb4:ed F4:s Gb4:q Bb4:q || Bb3:hd' } }]);
    const r = await pushMeasures(client, model);
    assert.equal(r.extended, false);
    assert.equal(r.verify.ok, true);
    assert.equal(r.unsupportedLive.harm, 1);
    assert.match(r.warnings.join('\n'), /voz 2 necesita el plugin de ComposeAnything/);
  } finally { client.close(); await mock.close(); }
});

test('en vivo: voces múltiples y reconexión', async () => {
  const mock = await startMock({ staves: 2, measures: 1 });
  const client = new LiveClient({ url: mock.url });
  try {
    const model = sample();
    score.writeMeasures(model, [{ n: 1, staves: { 1: 'Eb4:hd || Bb3:hd' } }]);
    await pushMeasures(client, model, { from: 1, to: 1 });
    const v1 = mock.state.staves[0].filter((e) => e.voice === 1);
    assert.equal(v1.length, 1);
    assert.deepEqual(v1[0].notes, [58]);

    client.ws.terminate(); // se cae la conexión: la siguiente petición reconecta sola
    assert.equal(await client.send('ping'), 'pong');
    assert.deepEqual(await prepareScore(client, model), ['time', 'tempo', 'key']);
  } finally { client.close(); await mock.close(); }
});

test('en vivo: error claro cuando MuseScore no está', async () => {
  const client = new LiveClient({ url: 'ws://127.0.0.1:1', timeout: 1000 });
  await assert.rejects(client.send('ping'), /No puedo conectar con MuseScore.*Plugins → ComposeAnything/);
});
