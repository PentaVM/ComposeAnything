'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const claude = require('../src/core/claude-desktop');
const { ensurePlugin, pluginStatus, SOURCE } = require('../src/core/plugin-install');
const { Store } = require('../src/core/store');

const TMP = path.join(__dirname, '.tmp');
fs.mkdirSync(TMP, { recursive: true });
const tmpDir = (p) => fs.mkdtempSync(path.join(TMP, p));
const LAUNCH = { command: 'C:/Apps/ComposeAnything/ComposeAnything.exe', args: ['C:/Apps/ComposeAnything/resources/app/src/mcp/server.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };

test('Claude Desktop: crea la configuración si no existe', () => {
  const file = path.join(tmpDir('cd-'), 'sub', 'claude_desktop_config.json');
  const r = claude.registerMcp({ configPath: file, ...LAUNCH });
  assert.equal(r.created, true);
  assert.equal(r.backup, null);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(cfg.mcpServers.composeanything, LAUNCH);
  assert.deepEqual(claude.isRegistered({ configPath: file }), { found: true, registered: true, path: file });
});

test('Claude Desktop: respeta lo que ya había, hace copia una vez y es idempotente', () => {
  const file = path.join(tmpDir('cd-'), 'claude_desktop_config.json');
  const original = { theme: 'dark', mcpServers: { otro: { command: 'npx', args: ['-y', 'algo'] } } };
  fs.writeFileSync(file, JSON.stringify(original));
  const r1 = claude.registerMcp({ configPath: file, ...LAUNCH });
  assert.equal(r1.created, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(r1.backup, 'utf8')), original);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.theme, 'dark');
  assert.deepEqual(cfg.mcpServers.otro, original.mcpServers.otro);

  const r2 = claude.registerMcp({ configPath: file, ...LAUNCH }); // repetir no duplica ni pisa la copia original
  assert.equal(r2.replaced, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(r2.backup, 'utf8')), original);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers).length, 2);

  assert.equal(claude.unregisterMcp({ configPath: file }).removed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers, original.mcpServers);
  assert.equal(claude.unregisterMcp({ configPath: file }).removed, false);
});

test('Claude Desktop: no toca un JSON inválido ni un formato inesperado', () => {
  const dir = tmpDir('cd-');
  const bad = path.join(dir, 'a.json');
  fs.writeFileSync(bad, '{ esto no es json');
  assert.throws(() => claude.registerMcp({ configPath: bad, ...LAUNCH }), /no es JSON válido/);
  assert.equal(fs.readFileSync(bad, 'utf8'), '{ esto no es json'); // intacto
  const arr = path.join(dir, 'b.json');
  fs.writeFileSync(arr, '[1,2]');
  assert.throws(() => claude.registerMcp({ configPath: arr, ...LAUNCH }), /formato inesperado/);
  assert.throws(() => claude.registerMcp({ configPath: null, ...LAUNCH }), /No encuentro Claude Desktop/);
  assert.equal(claude.isRegistered({ configPath: bad }).registered, false);
});

test('Claude Desktop (Windows): prefiere la ruta virtualizada de la versión Store', { skip: process.platform !== 'win32' && 'solo Windows' }, () => {
  const local = tmpDir('local-'), roaming = tmpDir('roaming-');
  const msix = path.join(local, 'Packages', 'Claude_abc123', 'LocalCache', 'Roaming', 'Claude');
  fs.mkdirSync(msix, { recursive: true });
  fs.mkdirSync(path.join(roaming, 'Claude'), { recursive: true });
  const old = { l: process.env.LOCALAPPDATA, a: process.env.APPDATA };
  process.env.LOCALAPPDATA = local; process.env.APPDATA = roaming;
  try {
    assert.equal(claude.configDirCandidates()[0], msix);
    assert.equal(claude.findConfigPath(), path.join(msix, 'claude_desktop_config.json'));
  } finally { process.env.LOCALAPPDATA = old.l; process.env.APPDATA = old.a; }
});

test('plugin: se instala la primera vez, se actualiza si cambia y no revive si lo borras', () => {
  const docs = tmpDir('docs-');
  const store = new Store(tmpDir('home-'));
  const target = path.join(docs, 'MuseScore4', 'Plugins', 'composeanything.qml');

  assert.equal(pluginStatus({ documents: docs }).installed, false);
  assert.equal(ensurePlugin({ documents: docs, store }).action, 'installed');
  assert.equal(fs.readFileSync(target, 'utf8'), fs.readFileSync(SOURCE, 'utf8'));
  assert.equal(ensurePlugin({ documents: docs, store }).action, 'ok');

  fs.writeFileSync(target, '// versión vieja');
  assert.equal(ensurePlugin({ documents: docs, store }).action, 'updated');
  assert.equal(pluginStatus({ documents: docs }).upToDate, true);

  fs.rmSync(target); // el usuario lo borró a propósito
  assert.equal(ensurePlugin({ documents: docs, store }).action, 'skipped');
  assert.equal(fs.existsSync(target), false);

  store.saveSettings({ pluginAutoInstall: false });
  assert.equal(ensurePlugin({ documents: docs, store }).action, 'disabled');
});

test('MCP con el ejecutable de Electron en modo Node (como lo lanza la app instalada)', async (t) => {
  let exe;
  try { exe = require('electron'); } catch { /* electron no instalado */ }
  if (typeof exe !== 'string' || !fs.existsSync(exe)) return t.skip('electron no instalado');
  const home = tmpDir('mcp-');
  const transport = new StdioClientTransport({
    command: exe, args: [path.join(__dirname, '..', 'src', 'mcp', 'server.js')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', COMPOSEANYTHING_HOME: home }, stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 28);
    const r = await client.callTool({ name: 'score_new', arguments: { title: 'Desde Electron', key: 'G major', time: '4/4' } });
    assert.match(r.content[0].text, /"ok": true/);
  } finally { await client.close(); }
});
