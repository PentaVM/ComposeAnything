'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const { Store } = require('../src/core/store');
const { Session } = require('../src/core/session');
const { LiveClient } = require('../src/core/live');
const { buildTools, callTool, parseKey, toOpenAITools } = require('../src/core/tools');
const { startMock } = require('../src/dev/mock-musescore');
const { findMuseScore } = require('../src/core/musescore');

const TMP = path.join(__dirname, '.tmp');
fs.mkdirSync(TMP, { recursive: true });
const newSession = (settings = {}) => {
  const store = new Store(fs.mkdtempSync(path.join(TMP, 'home-')));
  if (Object.keys(settings).length) store.saveSettings(settings);
  return new Session({ store });
};

test('parseKey: nombres y números', () => {
  assert.deepEqual(parseKey('Eb minor'), { fifths: -6, mode: 'minor' });
  assert.deepEqual(parseKey('G major'), { fifths: 1, mode: 'major' });
  assert.deepEqual(parseKey('F#m'), { fifths: 3, mode: 'minor' });
  assert.deepEqual(parseKey(-3, 'minor'), { fifths: -3, mode: 'minor' });
  assert.deepEqual(parseKey('-2'), { fifths: -2, mode: 'major' });
  assert.throws(() => parseKey('Zeta'), /no reconocida/);
});

test('herramientas: flujo completo crear → escribir → revisar → exportar', async () => {
  const s = newSession({ output: 'file' });
  const tools = buildTools(s);
  const call = (n, a) => callTool(tools, n, a);

  await assert.rejects(call('score_read', {}), /No hay ninguna obra abierta/);
  const created = await call('score_new', { title: 'Mi mazurka', key: 'Eb minor', time: '3/4', tempo: 120 });
  assert.deepEqual(created.staves, ['1 = Piano (pentagrama 1, clave G)', '2 = Piano (pentagrama 2, clave F)']);

  // Argumentos como los mandan algunos modelos locales: números y JSON en texto
  const bad = await call('score_write', { measures: JSON.stringify([{ n: '1', staves: { 1: 'Eb4:q F4:q' } }]) });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /suma 2 negras/);
  assert.equal(s.model.measures[1], undefined); // no se escribió nada

  const w = await call('score_write', { measures: [{ n: 1, staves: { 1: '{harm Ebm} Eb4:q F4:q Gb4:q', 2: 'Eb2:q [Bb2 Eb3]:q [Bb2 Eb3]:q' } }, { n: 2, staves: { 1: 'Bb4:hd', 2: 'Eb2:hd' } }] });
  assert.equal(w.ok, true);
  assert.deepEqual(w.written, [1, 2]);
  assert.match(w.summary, /armonía Ebm/);
  assert.match(w.next, /pregunta/i); // modo paso a paso por defecto
  assert.ok(fs.existsSync(w.file));

  // Idempotente: repetir no duplica
  await call('score_write', { measures: [{ n: 2, staves: { 1: 'Bb4:hd', 2: 'Eb2:hd' } }] });
  assert.equal((await call('score_read', {})).measures, 2);

  assert.equal((await call('score_lint', {})).ok, true);
  const x = await call('score_export', { format: 'musicxml', name: 'mi-mazurka' });
  assert.match(fs.readFileSync(x.files[0], 'utf8'), /<fifths>-6<\/fifths>/);

  assert.equal((await call('score_undo', {})).ok, true);
  assert.equal(s.model.measures[2].staves[1], 'Bb4:hd'); // deshizo la reescritura idéntica; la obra sigue intacta
  await assert.rejects(call('score_write', { measures: [{ n: 1 }], nope: 1 }), /parámetro desconocido "nope"/);
  await assert.rejects(call('inexistente', {}), /herramienta desconocida/);
});

test('herramientas: perfil, autonomía, proyectos y coro', async () => {
  const s = newSession();
  const tools = buildTools(s);
  const call = (n, a) => callTool(tools, n, a);
  await call('profile_add_work', { title: 'Mazurka Op. 67 n.º 4', composer: 'Chopin', notes: 'melancólica' });
  assert.equal((await call('profile_get', {})).likedWorks.length, 1);

  const a = await call('autonomy_set', { mode: 'per_phrase' });
  assert.equal(a.checkpointEvery, 4);
  assert.equal((await call('autonomy_set', { mode: 'autonomous' })).checkpointEvery, null);

  await call('score_new', { title: 'Coral', key: 'C major', time: '4/4', template: 'satb_open' });
  await call('score_write', { measures: [{ n: 1, staves: { 1: 'C5:q D5:q E5:h', 2: 'E4:w', 3: 'G3:w', 4: 'C3:w' } }] });
  const l = await call('choir_lyrics', { staff: 1, text: 'Glo-ri-a' });
  assert.equal(l.assigned, 3);
  assert.match(s.model.measures[1].staves[1], /!l=Glo-/);
  assert.equal((await call('choir_check', {})).applicable, true);

  await call('project_save', { name: 'coral v1' });
  await call('score_new', { title: 'Otra' });
  assert.deepEqual((await call('project_list', {})).projects, ['coral v1']);
  assert.equal((await call('project_open', { name: 'coral v1' })).title, 'Coral');
  assert.equal(toOpenAITools(tools).length, tools.length);
  assert.ok(tools.length >= 28);
});

test('herramientas: escritura en vivo contra el plugin simulado', async () => {
  const mock = await startMock({ staves: 2, measures: 1 });
  const s = newSession({ output: 'both', musescore: { wsUrl: mock.url } });
  const tools = buildTools(s);
  const call = (n, a) => callTool(tools, n, a);
  try {
    await call('score_new', { title: 'Vivo', key: 'C major', time: '3/4' });
    const w = await call('score_write', { measures: [{ n: 1, staves: { 1: 'C5:q D5:q E5:q', 2: 'C3:hd' } }, { n: 2, staves: { 1: 'G4:hd', 2: 'G2:hd' } }] });
    assert.equal(w.live.verified, true, JSON.stringify(w.live));
    assert.equal(w.live.measuresWritten, 2);
    assert.equal(mock.state.nMeasures, 2);
    const read = await call('ms_live_read', { from: 1, to: 2 });
    assert.match(read.content, /m1 staff0: C D E/);
    const off = await call('score_write', { measures: [{ n: 3, staves: { 1: 'C5:hd' } }], live: false });
    assert.equal(off.live, undefined);
    assert.equal(mock.state.nMeasures, 2); // live:false no toca la hoja
    assert.equal((await call('status', {})).live.connected, true);
  } finally { s.live?.close(); await mock.close(); }
});

test('MCP real: un cliente externo lista y llama herramientas por stdio', async () => {
  const home = fs.mkdtempSync(path.join(TMP, 'mcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'src', 'mcp', 'server.js')], env: { ...process.env, COMPOSEANYTHING_HOME: home }, stderr: 'ignore' });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  try {
    assert.match(client.getInstructions() || '', /Notación de ComposeAnything/);
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'score_write'));
    assert.equal(tools.find((t) => t.name === 'score_write').inputSchema.required[0], 'measures');
    const txt = (r) => r.content[0].text;
    await client.callTool({ name: 'score_new', arguments: { title: 'Por MCP', key: 'D major', time: '2/4' } });
    const bad = await client.callTool({ name: 'score_write', arguments: { measures: [{ n: 1, staves: { 1: 'D5:q' } }] } });
    assert.match(txt(bad), /"ok": false/);
    const ok = await client.callTool({ name: 'score_write', arguments: { measures: [{ n: 1, staves: { 1: 'D5:q F#5:q', 2: 'D3:h' } }] } });
    assert.match(txt(ok), /"ok": true/);
    const err = await client.callTool({ name: 'score_clear', arguments: {} });
    assert.equal(err.isError, true);
    assert.match(txt(err), /falta el parámetro "from"/);
    // el estado quedó en disco y lo ve cualquier otro proceso (p. ej. la app)
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'projects', 'current.json'), 'utf8')).measures[1].staves[1], 'D5:q F#5:q');
  } finally { await client.close(); }
});

test('MuseScore real: score_export a PDF desde las herramientas', { skip: !findMuseScore() && 'MuseScore no instalado' }, async () => {
  const s = newSession();
  const tools = buildTools(s);
  await callTool(tools, 'score_new', { title: 'PDF', key: 'F major', time: '4/4' });
  await callTool(tools, 'score_write', { measures: [{ n: 1, staves: { 1: '{harm F} F4:q A4:q C5:h', 2: 'F2:q [C3 F3]:q [C3 F3]:h' } }], live: false });
  const r = await callTool(tools, 'score_export', { format: 'pdf', name: 'prueba' });
  assert.ok(fs.statSync(r.files[0]).size > 2000);
});
