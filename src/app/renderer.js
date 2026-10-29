'use strict';
// Interfaz de ComposeAnything. No tiene Node ni red: todo pasa por window.api (preload).

const $ = (s) => document.querySelector(s);
const chat = $('#chat');
let busy = false;
let toastTimer = null;

// --- utilidades --------------------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Formato mínimo y seguro: escapa todo y luego permite **negrita**, `código` y saltos de línea. */
const fmt = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');

function node(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

function scrollDown() { chat.scrollTop = chat.scrollHeight; }

function toast(text, bad = false, ms = 5000) {
  const t = $('#toast');
  t.textContent = text;
  t.className = bad ? 'bad' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function addMsg(role, text) {
  const m = node('div', `msg ${role}`, fmt(text));
  chat.appendChild(m);
  scrollDown();
  return m;
}

function addTool(ev) {
  const d = node('details', `tool${ev.error ? ' bad' : ''}`);
  d.appendChild(node('summary', '', `${ev.error ? '⚠' : '🔧'} ${esc(ev.name)} · ${ev.ms} ms`));
  const pre = node('pre');
  pre.textContent = `${ev.args}\n→ ${ev.error ? 'ERROR: ' + ev.error : ev.result}`;
  d.appendChild(pre);
  chat.appendChild(d);
  scrollDown();
}

const QUICK_REPLIES = ['Más oscuro', 'Más suave', 'Más movimiento', 'Repite con variación', 'Rehaz este tramo'];

function addCheckpoint(ev) {
  const card = node('div', 'checkpoint');
  card.appendChild(node('h4', '', ev.auto ? 'Punto de control' : 'La IA pregunta'));
  card.appendChild(node('div', 'summary', esc(ev.summary || '')));
  if (ev.question) card.appendChild(node('div', '', esc(ev.question)));
  const input = node('input');
  input.placeholder = 'Instrucciones para lo siguiente (opcional)';
  card.appendChild(input);
  const chips = node('div', 'chips');
  for (const q of QUICK_REPLIES) {
    const b = node('button', '', esc(q));
    b.type = 'button';
    b.onclick = () => { input.value = q; answer('continue'); };
    chips.appendChild(b);
  }
  card.appendChild(chips);
  const actions = node('div', 'actions');
  const go = node('button', 'primary', 'Continuar');
  const stop = node('button', 'danger', 'Detener aquí');
  actions.append(go, stop);
  card.appendChild(actions);
  function answer(action) {
    card.classList.add('done');
    card.querySelectorAll('button,input').forEach((e) => { e.disabled = true; });
    if (input.value) addMsg('user', input.value);
    window.api.answerCheckpoint(ev.id, { action, text: input.value }).catch((e) => toast(e.message, true));
  }
  go.onclick = () => answer('continue');
  stop.onclick = () => answer('stop');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') answer('continue'); });
  chat.appendChild(card);
  scrollDown();
  input.focus();
}

function setBusy(b) {
  busy = b;
  $('#send').disabled = b;
  $('#stop').hidden = !b;
  $('#input').placeholder = b ? 'Trabajando… puedes detenerlo' : 'Pídele música, cambios o una transcripción…  (Enter envía, Shift+Enter salto de línea)';
}

// --- eventos del agente ------------------------------------------------------------------------------------
window.api.onEvent((ev) => {
  switch (ev.type) {
    case 'message': addMsg(ev.role === 'system' ? 'system' : 'assistant', ev.text); break;
    case 'tool': addTool(ev); break;
    case 'checkpoint': addCheckpoint(ev); break;
    case 'status': setBusy(ev.state !== 'idle'); break;
    case 'error': addMsg('error', ev.message); setBusy(false); break;
    case 'score': refreshStatus(); break;
    case 'notice': toast(ev.text, false, 12000); if (ev.openConnect) $('#connect').showModal(); break;
    default: break;
  }
});

// --- envío ---------------------------------------------------------------------------------------------------
async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = '';
  addMsg('user', text);
  setBusy(true);
  try { await window.api.send(text); } catch (e) { addMsg('error', e.message); setBusy(false); }
}
$('#send').onclick = send;
$('#stop').onclick = () => window.api.stop();
$('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('#reset').onclick = async () => { await window.api.reset(); chat.replaceChildren(); addMsg('system', 'Conversación nueva. La obra y el perfil se conservan.'); };

// --- estado y modos --------------------------------------------------------------------------------------------
async function refreshStatus() {
  try {
    const st = await window.api.status();
    $('#title').textContent = st.project ? st.project.title : 'ComposeAnything';
    $('#subtitle').textContent = st.project ? `${st.project.measures} compases · ${st.project.time} · ♩=${st.project.tempo}` : 'sin obra: pídeme una';
    const pill = $('#pill');
    if (st.live?.connected) {
      pill.className = 'pill on';
      pill.textContent = `MuseScore en vivo ✓ ${st.live.score ? '· ' + (st.live.score.title || 'hoja') + ' · ' + st.live.score.numMeasures + ' comp.' : ''}${st.live.plugin?.plugin === 'composeanything' ? '' : ' · plugin básico'}`;
    } else {
      pill.className = 'pill off';
      pill.textContent = 'MuseScore: sin conexión en vivo (clic para conectar)';
    }
  } catch (e) { $('#pill').textContent = 'Estado no disponible: ' + e.message; }
}
$('#pill').onclick = () => $('#connect').showModal();
setInterval(refreshStatus, 6000);

$('#autonomy').onchange = (e) => window.api.setSettings({ autonomy: e.target.value }).then(() => toast('Modo: ' + e.target.selectedOptions[0].textContent)).catch((x) => toast(x.message, true));
$('#output').onchange = (e) => window.api.setSettings({ output: e.target.value }).catch((x) => toast(x.message, true));

// --- acciones rápidas ------------------------------------------------------------------------------------------
async function runTool(name, args, ok) {
  try { const r = await window.api.tool(name, args); toast(ok(r)); return r; } catch (e) { toast(e.message, true, 8000); return null; }
}
const ACTIONS = {
  open: () => runTool('ms_open', {}, (r) => 'Abierto en MuseScore:\n' + r.file),
  push: () => runTool('ms_live_push', {}, (r) => (r.verified ? `Escrito y verificado: ${r.measuresWritten} compases` : `Escrito con diferencias: ${JSON.stringify(r.mismatches || r)}`)),
  pdf: async () => { const r = await runTool('score_export', { format: 'pdf' }, (x) => 'PDF: ' + x.files[0]); if (r) window.api.reveal(r.files[0]); },
  undo: () => runTool('score_undo', {}, (r) => (r.ok ? 'Deshecho' : 'No hay nada que deshacer')),
  import: async () => {
    const p = await window.api.pickFile('score'); if (!p) return;
    const r = await runTool('score_import', { path: p }, (x) => `Importada: ${x.title} (${x.measures} compases)${x.warnings?.length ? '\n' + x.warnings[0] : ''}`);
    if (r) addMsg('system', `Importé «${r.title}». Pídeme los cambios que quieras.`);
  },
  audio: async () => {
    const p = await window.api.pickFile('audio'); if (!p) return;
    toast('Transcribiendo…', false, 60000);
    const r = await runTool('audio_transcribe', { path: p }, (x) => `Transcrito: ${x.bars} compases, ${x.notes} notas, ♩=${x.bpm}\n${(x.warnings || []).join('\n')}`);
    if (r) addMsg('system', 'Transcripción lista. Revísala y pídeme correcciones.');
  },
};
$('#quick').addEventListener('click', (e) => { const a = e.target.closest('button')?.dataset.act; if (a) ACTIONS[a](); });

// Arrastrar un archivo a la ventana prepara el mensaje adecuado.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const p = window.api.pathOf(f);
  const audio = /\.(wav|mp3|m4a|ogg|flac)$/i.test(p);
  $('#input').value = audio ? `Transcribe este audio a partitura: ${p}` : `Importa esta partitura para editarla: ${p}`;
  $('#input').focus();
});

// --- cabecera ------------------------------------------------------------------------------------------------------
$('#btnDock').onclick = async () => { try { const r = await window.api.dock(); toast(r.moved ? 'MuseScore a la izquierda, esta app a la derecha.' : (r.note || 'Colocada a la derecha.')); } catch (e) { toast(e.message, true); } };
$('#btnPin').onclick = async (e) => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; await window.api.pin(on); e.currentTarget.setAttribute('aria-pressed', String(on)); };

// --- ajustes ---------------------------------------------------------------------------------------------------------
async function openSettings() {
  const { settings, hasKey, encryption, presets } = await window.api.getSettings();
  $('#baseUrl').value = settings.llm.baseUrl;
  $('#model').value = settings.llm.model;
  $('#temperature').value = settings.llm.temperature;
  $('#language').value = settings.language;
  $('#wsUrl').value = settings.musescore.wsUrl;
  $('#keyState').textContent = hasKey ? 'Clave guardada ✓' : (encryption ? 'Sin clave guardada' : 'Este sistema no cifra claves: usa la variable COMPOSEANYTHING_API_KEY');
  const box = $('#presets');
  box.replaceChildren();
  for (const [id, p] of Object.entries(presets)) {
    const b = node('button', '', esc(p.label));
    b.type = 'button';
    b.onclick = () => { $('#baseUrl').value = p.baseUrl; saveLlm(); };
    box.appendChild(b);
  }
  $('#settings').showModal();
}
const saveLlm = () => window.api.setSettings({ llm: { baseUrl: $('#baseUrl').value.trim(), model: $('#model').value.trim(), temperature: Number($('#temperature').value) || 0.7 }, language: $('#language').value, musescore: { wsUrl: $('#wsUrl').value.trim() || 'ws://127.0.0.1:8765' } }).catch((e) => toast(e.message, true));
for (const id of ['baseUrl', 'model', 'temperature', 'language', 'wsUrl']) $('#' + id).addEventListener('change', saveLlm);
$('#saveKey').onclick = async () => { try { const r = await window.api.setApiKey($('#apiKey').value); $('#apiKey').value = ''; $('#keyState').textContent = r.saved ? 'Clave guardada ✓ (cifrada)' : 'Clave borrada'; } catch (e) { $('#keyState').textContent = e.message; } };
$('#loadModels').onclick = async () => {
  await saveLlm();
  try { const list = await window.api.listModels(); $('#modelList').replaceChildren(...list.map((m) => { const o = document.createElement('option'); o.value = m; return o; })); toast(`${list.length} modelos disponibles: empieza a escribir en «Modelo»`); } catch (e) { toast(e.message, true, 8000); }
};
$('#btnSettings').onclick = openSettings;

// --- perfil ----------------------------------------------------------------------------------------------------------
async function renderWorks() {
  const p = await window.api.profile.get();
  const ul = $('#works');
  ul.replaceChildren();
  for (const w of p.likedWorks) {
    const li = node('li', '', `<span><b>${esc(w.title)}</b>${w.composer ? ' — ' + esc(w.composer) : ''}${w.notes ? '<br><small>' + esc(w.notes) + '</small>' : ''}</span>`);
    const rm = node('button', '', '×');
    rm.type = 'button';
    rm.onclick = async () => { await window.api.profile.removeWork(w.title); renderWorks(); };
    li.appendChild(rm);
    ul.appendChild(li);
  }
  $('#styleNotes').value = p.styleNotes || '';
  $('#dislikes').value = (p.dislikes || []).join('\n');
}
$('#btnProfile').onclick = async () => { await renderWorks(); $('#profile').showModal(); };
$('#addWork').onclick = async () => {
  try { await window.api.profile.addWork({ title: $('#wTitle').value, composer: $('#wComposer').value, notes: $('#wNotes').value }); for (const id of ['wTitle', 'wComposer', 'wNotes']) $('#' + id).value = ''; renderWorks(); } catch (e) { toast(e.message, true); }
};
$('#saveProfile').onclick = async () => { await window.api.profile.setNotes({ styleNotes: $('#styleNotes').value, dislikes: $('#dislikes').value.split('\n').map((s) => s.trim()).filter(Boolean) }); toast('Perfil guardado'); };

// --- conexión ---------------------------------------------------------------------------------------------------------
$('#installPlugin').onclick = async () => { try { const r = await window.api.installPlugin(); $('#installState').textContent = (r.updated ? 'Actualizado en ' : 'Copiado a ') + r.path; } catch (e) { $('#installState').textContent = e.message; } };
$('#checkConn').onclick = async () => { $('#connState').textContent = 'Comprobando…'; const st = await window.api.status(); $('#connState').textContent = st.live.connected ? `Conectado ✓ ${st.live.plugin?.plugin || ''}` : `Sin conexión: ${st.live.error || ''}`; refreshStatus(); };

async function refreshClaude() {
  try {
    const c = await window.api.claude.status();
    $('#claudeCode').value = c.claudeCode;
    $('#claudeState').textContent = !c.found ? 'No encuentro Claude Desktop' : c.error ? c.error : c.registered ? 'Añadido ✓ (reinicia Claude Desktop)' : 'Sin añadir';
  } catch (e) { $('#claudeState').textContent = e.message; }
}
$('#regClaude').onclick = async () => { try { const r = await window.api.claude.register(); $('#claudeState').textContent = 'Añadido ✓. ' + r.note; } catch (e) { $('#claudeState').textContent = e.message; } };
$('#unregClaude').onclick = async () => { try { const r = await window.api.claude.unregister(); $('#claudeState').textContent = r.removed ? 'Quitado' : 'No estaba añadido'; } catch (e) { $('#claudeState').textContent = e.message; } };
$('#claudeCode').onfocus = (e) => e.target.select();
$('#connect').addEventListener('toggle', () => { if ($('#connect').open) refreshClaude(); });

// --- arranque -----------------------------------------------------------------------------------------------------------
(async function init() {
  const { settings } = await window.api.getSettings();
  $('#autonomy').value = settings.autonomy;
  $('#output').value = settings.output;
  for (const m of await window.api.history()) addMsg(m.role, m.text);
  if (!chat.children.length) addMsg('system', 'Hola. Cuéntame qué quieres componer, editar o transcribir. Configura tu IA en ⚙ y conecta MuseScore con el botón de arriba.');
  refreshStatus();
})();
