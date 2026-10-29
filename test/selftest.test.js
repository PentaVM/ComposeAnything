'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../scripts/selftest-live');
const { startMock } = require('../src/dev/mock-musescore');

test('selftest: sin plugin explica cómo conectar', async () => {
  const lines = [];
  const r = await run({ url: 'ws://127.0.0.1:1', log: (l) => lines.push(l) });
  assert.equal(r.ok, false);
  assert.match(lines.join('\n'), /Plugins → ComposeAnything/);
});

test('selftest: solo lectura y escritura completa contra el plugin simulado', async () => {
  const mock = await startMock({ staves: 2, measures: 2 });
  try {
    const ro = await run({ url: mock.url, log: () => {} });
    assert.equal(ro.ok, true);
    assert.equal(mock.state.extras.length, 0); // sin --yes no escribe nada

    const lines = [];
    const rw = await run({ url: mock.url, yes: true, log: (l) => lines.push(l) });
    assert.equal(rw.ok, true, lines.join('\n'));
    assert.match(lines.join('\n'), /Notas, acordes y silencios escritos y releídos/);
    assert.deepEqual(['addHarmony', 'addDynamic', 'addStaffText', 'addRehearsalMark'].every((a) => mock.state.extras.some((e) => e.action === a)), true);
  } finally { await mock.close(); }
});
