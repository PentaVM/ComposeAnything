'use strict';
// Proceso principal de la app de escritorio.

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('../core/store');
const { Session } = require('../core/session');
const { Agent } = require('../core/agent');
const { callTool } = require('../core/tools');
const { installPlugin } = require('../core/plugin-install');
const llm = require('../core/llm');
const { dockWithMuseScore } = require('./dock');

const SMOKE = process.argv.includes('--smoke-test');
const SHOT = (process.argv.find((a) => a.startsWith('--screenshot=')) || '').slice(13) || null;
const TOOL_ALLOWLIST = new Set(['status', 'ms_open', 'score_export', 'ms_live_push', 'ms_live_status', 'ms_live_prepare', 'score_undo', 'score_redo', 'score_describe', 'score_lint', 'score_read', 'score_import', 'audio_transcribe', 'autonomy_set', 'project_list', 'project_open', 'project_save']);

let win = null;
const store = new Store();
const session = new Session({ store });

// --- clave de API: cifrada con el almacén del sistema (DPAPI en Windows, Keychain en macOS) --------------
const secretFile = () => store.file('secret.bin');
function getApiKey() {
  try {
    if (fs.existsSync(secretFile()) && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(fs.readFileSync(secretFile()));
  } catch { /* clave ilegible: se ignora */ }
  return process.env.COMPOSEANYTHING_API_KEY || '';
}
function setApiKey(key) {
  if (!key) { fs.rmSync(secretFile(), { force: true }); return { saved: false }; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Este sistema no ofrece cifrado seguro. Define la variable de entorno COMPOSEANYTHING_API_KEY en su lugar.');
  fs.writeFileSync(secretFile(), safeStorage.encryptString(key));
  return { saved: true };
}

const agent = new Agent({
  session,
  getConfig: () => { const l = session.settings.llm; return { baseUrl: l.baseUrl, model: l.model, temperature: l.temperature, apiKey: getApiKey() }; },
});

const emit = (ev) => { if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev); };
const clip = (v, n = 1800) => { const s = JSON.stringify(v ?? null); return s.length > n ? s.slice(0, n) + '…' : s; };
agent.on('message', (m) => emit({ type: 'message', ...m }));
agent.on('tool', (t) => emit({ type: 'tool', name: t.name, args: clip(t.args, 600), result: clip(t.result), error: t.error, ms: t.ms }));
agent.on('checkpoint', (c) => emit({ type: 'checkpoint', ...c }));
agent.on('status', (s) => emit({ type: 'status', ...s }));
agent.on('error', (e) => emit({ type: 'error', message: e.message }));
session.on((ev) => emit(ev));

// --- IPC ---------------------------------------------------------------------------------------------------
const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (e) { return { ok: false, error: e.message }; }
});

handle('chat:send', (text) => { if (!String(text).trim()) throw new Error('Mensaje vacío'); agent.send(String(text)); return true; });
handle('chat:stop', () => { agent.stop(); return true; });
handle('chat:reset', () => { agent.reset(); return true; });
handle('chat:history', () => agent.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && !String(m.content).startsWith('Punto de control')).map((m) => ({ role: m.role, text: m.content })));
handle('checkpoint:answer', (id, answer) => agent.answerCheckpoint(id, answer));

handle('settings:get', () => ({ settings: session.settings, hasKey: !!getApiKey(), encryption: safeStorage.isEncryptionAvailable(), presets: llm.PRESETS, version: app.getVersion() }));
handle('settings:set', (patch) => store.saveSettings(patch));
handle('secret:set', (key) => setApiKey(String(key || '').trim()));
handle('models:list', () => { const l = session.settings.llm; return llm.listModels({ baseUrl: l.baseUrl, apiKey: getApiKey() }); });

handle('status', () => callTool(agent.tools, 'status', {}));
handle('tool:call', (name, args) => { if (!TOOL_ALLOWLIST.has(name)) throw new Error(`herramienta no permitida desde la interfaz: ${name}`); return callTool(agent.tools, name, args || {}); });

handle('profile:get', () => { session.profile.reload(); return session.profile.data; });
handle('profile:addWork', (w) => session.profile.addWork(w));
handle('profile:removeWork', (t) => session.profile.removeWork(t));
handle('profile:setNotes', (n) => session.profile.setNotes(n));

handle('file:pick', async (kind) => {
  const filters = kind === 'audio' ? [{ name: 'Audio o MIDI', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'flac', 'mid', 'midi'] }]
    : [{ name: 'Partituras', extensions: ['mscz', 'mscx', 'musicxml', 'xml', 'mxl', 'mid', 'midi'] }];
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  return r.canceled ? null : r.filePaths[0];
});
handle('plugin:install', () => installPlugin({ documents: app.getPath('documents') }));
handle('window:dock', () => dockWithMuseScore(win));
handle('window:pin', (on) => { win.setAlwaysOnTop(!!on); return !!on; });
handle('shell:reveal', (p) => { shell.showItemInFolder(String(p)); return true; });

// --- ventana --------------------------------------------------------------------------------------------------
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: 420, height: Math.min(900, wa.height), x: wa.x + wa.width - 420, y: wa.y,
    minWidth: 340, minHeight: 480, show: !SMOKE && !SHOT, backgroundColor: '#14161a', title: 'ComposeAnything',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
  if (SMOKE) win.webContents.once('did-finish-load', runSmokeTest);
  if (SHOT) win.webContents.once('did-finish-load', runScreenshot);
}

// Captura con contenido de ejemplo (para el README): electron . --screenshot=ruta.png
async function runScreenshot() {
  try {
    await new Promise((r) => setTimeout(r, 600));
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#chat').replaceChildren();
      addMsg('user', 'Compón una mazurka oscura en Mi bemol menor, 3/4. Me gusta la Op. 67 n.º 4 de Chopin.');
      addMsg('assistant', 'Perfecto. Empiezo por **4 compases de introducción** con quintas huecas y luego el tema A, que asciende hacia Solb maj7. Voy compás a compás.');
      addTool({ name: 'score_write', args: '{"measures":[{"n":5,"staves":{"1":"Eb4:ed F4:s Gb4:q Bb4:q"}}]}', result: '{"ok":true,"written":[5],"live":{"verified":true}}', ms: 41 });
      addCheckpoint({ id: 'demo', auto: true, summary: 'Compases 5 | armonía Ebm | dinámica p | Piano#1: Eb4↗Bb4 (rango Eb4–Bb4, 4 notas) | Piano#2: Eb2→Gb3 (1 notas, 2 acordes)', question: '¿Sigo con el siguiente tramo o quieres cambios?' });
      const pill = document.querySelector('#pill'); pill.className = 'pill on'; pill.textContent = 'MuseScore en vivo ✓ · Mazurka Op. 1 · 5 comp.';
      document.querySelector('#title').textContent = 'Mazurka Op. 1'; document.querySelector('#subtitle').textContent = '5 compases · 3/4 · ♩=120';
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(SHOT, img.toPNG());
    console.log('SHOT_OK ' + SHOT);
    app.exit(0);
  } catch (e) { console.log('SHOT_FAIL ' + e.message); app.exit(1); }
}

async function runSmokeTest() {
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  try {
    await new Promise((r) => setTimeout(r, 800));
    const r = await win.webContents.executeJavaScript(`(async () => {
      const q = (s) => !!document.querySelector(s);
      const st = await window.api.getSettings();
      const status = await window.api.status();
      return { ui: q('#chat') && q('#input') && q('#autonomy') && q('#pill'), hasApi: typeof window.api.send === 'function', autonomy: st.settings.autonomy, tools: Object.keys(status).includes('live') };
    })()`);
    const ok = r.ui && r.hasApi && r.tools && errors.length === 0;
    console.log(ok ? 'SMOKE_OK ' + JSON.stringify(r) : 'SMOKE_FAIL ' + JSON.stringify({ r, errors }));
    app.exit(ok ? 0 : 1);
  } catch (e) { console.log('SMOKE_FAIL ' + e.message); app.exit(1); }
}

if (!app.requestSingleInstanceLock() && !SMOKE) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
