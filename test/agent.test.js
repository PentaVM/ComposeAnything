'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { Store } = require('../src/core/store');
const { Session } = require('../src/core/session');
const { Agent } = require('../src/core/agent');
const llm = require('../src/core/llm');

const TMP = path.join(__dirname, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

/** Servidor falso compatible con OpenAI: responde con el guion dado, en orden. */
function fakeOpenAI(script) {
  const requests = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'modelo-b' }, { id: 'modelo-a' }] })); }
      const payload = JSON.parse(body);
      requests.push({ auth: req.headers.authorization, ...payload });
      const step = script[i++];
      if (!step) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: 'guion agotado' } })); }
      if (typeof step === 'number') { res.statusCode = step; return res.end(JSON.stringify({ error: { message: `fallo ${step}` } })); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: step, finish_reason: step.tool_calls ? 'tool_calls' : 'stop' }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise((r) => server.close(r)),
  })));
}

const call = (name, args, id = `c${Math.random().toString(36).slice(2, 7)}`) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const calls = (...cs) => ({ role: 'assistant', content: null, tool_calls: cs });
const say = (text) => ({ role: 'assistant', content: text });

function setup(server, settings) {
  const store = new Store(fs.mkdtempSync(path.join(TMP, 'agent-')));
  store.saveSettings({ output: 'file', ...settings });
  const session = new Session({ store });
  const agent = new Agent({ session, getConfig: () => ({ baseUrl: server.url, model: 'fake', apiKey: 'sk-test', temperature: 0.2 }) });
  const events = { checkpoints: [], tools: [], messages: [], errors: [] };
  agent.on('checkpoint', (c) => events.checkpoints.push(c));
  agent.on('tool', (t) => events.tools.push(t));
  agent.on('message', (m) => events.messages.push(m));
  agent.on('error', (e) => events.errors.push(e));
  return { agent, session, events, store };
}

test('agente: modo paso a paso impone un compás por llamada y pregunta tras cada uno', async () => {
  const server = await fakeOpenAI([
    calls(call('score_new', { title: 'T', key: 'C major', time: '3/4' })),
    calls(call('score_write', { measures: [{ n: 1, staves: { 1: 'C5:hd' } }, { n: 2, staves: { 1: 'D5:hd' } }] })), // demasiado: se rechaza
    calls(call('score_write', { measures: [{ n: 1, staves: { 1: '{harm C} C5:hd' } }] })),
    calls(call('score_write', { measures: [{ n: 2, staves: { 1: 'D5:hd' } }] })),
  ]);
  const { agent, session, events } = setup(server, { autonomy: 'per_measure' });
  agent.on('checkpoint', (c) => setImmediate(() => agent.answerCheckpoint(c.id, c.id === 'cp1' ? { text: 'más oscuro' } : { action: 'stop' })));
  try {
    await agent.send('Compón una mazurka');
    assert.equal(server.requests.length, 4);
    assert.equal(server.requests[0].messages[0].role, 'system');
    assert.match(server.requests[0].messages[0].content, /Modo PASO A PASO/);
    assert.equal(server.requests[0].auth, 'Bearer sk-test');
    assert.ok(server.requests[0].tools.some((t) => t.function.name === 'score_write'));
    // la 2.ª llamada se rechazó por exceder el límite y no escribió nada
    const rejected = events.tools.find((t) => t.name === 'score_write' && t.result?.ok === false);
    assert.match(rejected.result.errors[0], /solo puedes escribir 1 compás/);
    // dos puntos de control, con resumen determinista
    assert.equal(events.checkpoints.length, 2);
    assert.match(events.checkpoints[0].summary, /Compases 1 \| armonía C/);
    // la respuesta del usuario llegó al modelo en la siguiente petición
    const last = JSON.stringify(server.requests[3].messages);
    assert.match(last, /más oscuro/);
    assert.equal(Object.keys(session.model.measures).length, 2);
    assert.equal(agent.busy, false);
  } finally { await server.close(); }
});

test('agente: modo autónomo no interrumpe y escribe varios compases de una vez', async () => {
  const server = await fakeOpenAI([
    calls(call('score_new', { title: 'Auto', time: '4/4' })),
    calls(call('score_write', { measures: [1, 2, 3].map((n) => ({ n, staves: { 1: 'C5:w' } })) })),
    say('Listo: 3 compases.'),
  ]);
  const { agent, session, events } = setup(server, { autonomy: 'autonomous' });
  try {
    await agent.send('Hazla toda');
    assert.equal(events.checkpoints.length, 0);
    assert.equal(Object.keys(session.model.measures).length, 3);
    assert.deepEqual(events.messages.map((m) => m.text), ['Listo: 3 compases.']);
  } finally { await server.close(); }
});

test('agente: se recupera de argumentos JSON rotos, de errores de herramienta y de un 500', async () => {
  const server = await fakeOpenAI([
    500, // el cliente reintenta solo
    calls(call('score_new', '{esto no es json')),
    calls(call('score_new', { title: 'Bien' })),
    calls(call('score_read', { from: 9 })),
    say('hecho'),
  ]);
  const { agent, session, events } = setup(server, { autonomy: 'autonomous' });
  try {
    await agent.send('empieza');
    const errs = events.tools.map((t) => t.error).filter(Boolean);
    assert.match(errs[0], /no son JSON válido/);
    assert.equal(session.model.meta.title, 'Bien');
    assert.equal(events.errors.length, 0);
    assert.equal(events.messages.at(-1).text, 'hecho');
    // el fallo de herramienta le llegó al modelo como resultado, para que lo corrija
    const toolMsgs = server.requests.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.ok(toolMsgs.some((c) => /no son JSON válido/.test(c)));
  } finally { await server.close(); }
});

test('agente: error de autenticación se informa y el agente queda libre', async () => {
  const server = await fakeOpenAI([401]);
  const { agent, events } = setup(server, {});
  try {
    await agent.send('hola');
    assert.match(events.errors[0].message, /HTTP 401.*fallo 401/);
    assert.equal(agent.busy, false);
  } finally { await server.close(); }
});

test('agente: stop() libera un punto de control en espera', async () => {
  const server = await fakeOpenAI([
    calls(call('score_new', { title: 'S', time: '3/4' })),
    calls(call('score_write', { measures: [{ n: 1, staves: { 1: 'C5:hd' } }] })),
  ]);
  const { agent, events } = setup(server, { autonomy: 'per_measure' });
  agent.on('checkpoint', () => setImmediate(() => agent.stop()));
  try {
    await agent.send('x');
    assert.equal(events.checkpoints.length, 1);
    assert.equal(agent.busy, false);
    assert.match(events.messages.at(-1).text, /Detenido/);
  } finally { await server.close(); }
});

test('agente: el historial se guarda y el recorte nunca deja mensajes tool huérfanos', async () => {
  const server = await fakeOpenAI([say('ok')]);
  const { agent, session } = setup(server, {});
  try {
    await agent.send('hola');
    assert.equal(JSON.parse(fs.readFileSync(session.store.file('chat.json'), 'utf8')).length, 2);
    agent.messages = [{ role: 'tool', tool_call_id: 'x', content: '{}' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'b' }];
    assert.equal(agent.compact()[0].role, 'user');
  } finally { await server.close(); }
});

test('llm: lista de modelos ordenada', async () => {
  const server = await fakeOpenAI([]);
  try { assert.deepEqual(await llm.listModels({ baseUrl: server.url }), ['modelo-a', 'modelo-b']); } finally { await server.close(); }
  await assert.rejects(llm.chat({ baseUrl: '', model: 'x', messages: [] }), /Falta la URL base/);
});
