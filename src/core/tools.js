'use strict';
// Registro único de herramientas. Lo consumen el servidor MCP (clientes externos) y el agente de la app.

const fs = require('fs');
const os = require('os');
const path = require('path');

const score = require('./score');
const { toMusicXML, fromMusicXML } = require('./musicxml');
const { findMuseScore, convert, openInMuseScore } = require('./musescore');
const live = require('./live');
const choir = require('./choir');
const audio = require('./audio');
const { lintScore } = require('./lint');
const { autonomyInstruction } = require('./prompt');
const { safeName, AUTONOMY_EVERY } = require('./store');

const MAJOR_KEYS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7 };
const MINOR_KEYS = { A: 0, E: 1, B: 2, 'F#': 3, 'C#': 4, 'G#': 5, 'D#': 6, 'A#': 7, D: -1, G: -2, C: -3, F: -4, Bb: -5, Eb: -6, Ab: -7 };

/** 6, "-6", "Eb minor", "Gb major", "do menor" no: usa notas en inglés. -> {fifths, mode} */
function parseKey(key, mode) {
  if (typeof key === 'number' || /^-?\d+$/.test(String(key))) return { fifths: Number(key), mode: mode || 'major' };
  const m = /^([A-Ga-g])([b#♭♯]?)\s*(m|min|minor|menor|major|maj|mayor)?$/i.exec(String(key).trim());
  if (!m) throw new Error(`tonalidad no reconocida: "${key}" (usa p. ej. "Eb minor", "G major" o el número de alteraciones: -6..7)`);
  const name = m[1].toUpperCase() + m[2].replace('♭', 'b').replace('♯', '#');
  const minor = /^(m|min|minor|menor)$/i.test(m[3] || '') && m[3] !== 'M';
  const table = minor ? MINOR_KEYS : MAJOR_KEYS;
  if (!(name in table)) throw new Error(`tonalidad inexistente: ${key}`);
  return { fifths: table[name], mode: minor ? 'minor' : 'major' };
}

function parseTime(t) {
  if (Array.isArray(t) && t.length === 2) return t.map(Number);
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(t));
  if (!m) throw new Error(`compás no válido: "${t}" (usa "3/4")`);
  return [Number(m[1]), Number(m[2])];
}

const staffMap = (model) => score.staffList(model).map((s) => `${s.global} = ${s.part.name}${s.part.staves.length > 1 ? ' (pentagrama ' + s.local + ', clave ' + s.staff.clef + ')' : ''}`);

// Los modelos pequeños suelen mandar números, booleanos o JSON como texto (también anidados): se corrige según el esquema.
function coerceValue(def, v) {
  if (v === undefined || v === null || !def) return v;
  const types = [].concat(def.type || []);
  if (typeof v === 'string') {
    if ((types.includes('integer') || types.includes('number')) && !types.includes('string') && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    if (types.includes('boolean') && !types.includes('string')) return v === 'true' ? true : v === 'false' ? false : v;
    if ((types.includes('array') || types.includes('object')) && !types.includes('string') && /^\s*[\[{]/.test(v)) {
      try { v = JSON.parse(v); } catch { return v; }
    }
  }
  if (Array.isArray(v) && def.items) return v.map((x) => coerceValue(def.items, x));
  if (v && typeof v === 'object' && !Array.isArray(v) && def.properties) {
    const o = { ...v };
    for (const k of Object.keys(def.properties)) if (k in o) o[k] = coerceValue(def.properties[k], o[k]);
    return o;
  }
  return v;
}

function coerce(schema, args) {
  const out = { ...(args || {}) };
  for (const [k, def] of Object.entries(schema.properties || {})) {
    if (out[k] === undefined || out[k] === null) delete out[k]; else out[k] = coerceValue(def, out[k]);
  }
  return out;
}

function validateArgs(tool, args) {
  const errs = [];
  for (const r of tool.inputSchema.required) if (args[r] === undefined) errs.push(`falta el parámetro "${r}"`);
  for (const k of Object.keys(args)) if (!(k in tool.inputSchema.properties)) errs.push(`parámetro desconocido "${k}" (válidos: ${Object.keys(tool.inputSchema.properties).join(', ') || 'ninguno'})`);
  if (errs.length) throw new Error(`${tool.name}: ${errs.join('; ')}`);
}

function buildTools(s) {
  const T = [];
  const add = (name, description, properties, required, handler) => T.push({ name, description, inputSchema: { type: 'object', properties, required: required || [], additionalProperties: false }, handler });
  const INT = { type: 'integer' };
  const range = { from: { ...INT, description: 'Primer compás (por defecto 1)' }, to: { ...INT, description: 'Último compás (por defecto el final)' } };
  const wantLive = (a) => (a.live !== undefined ? a.live : ['live', 'both'].includes(s.settings.output));
  const exportXml = (name) => {
    const model = s.need();
    const file = path.join(s.store.exportsDir(), `${safeName(name || model.meta.title)}.musicxml`);
    fs.writeFileSync(file, toMusicXML(model), 'utf8');
    return file;
  };
  const summarizeLive = (r) => ({
    measuresWritten: r.pushed.length, verified: r.verify ? r.verify.ok : null, mismatches: r.verify?.mismatches?.slice(0, 5),
    spellingDifferences: r.verify?.spellingDifferences, notWrittenLive: r.unsupportedLive, ties: r.ties || undefined, warnings: r.warnings.slice(0, 5),
    extendedPlugin: r.extended,
  });

  add('status', 'Estado general: obra abierta, conexión en vivo con MuseScore (y versión del plugin), ajustes de autonomía/salida y perfil. Úsalo al empezar.', {}, [], async () => {
    s.refresh();
    const model = s.model;
    const out = {
      project: model ? { title: model.meta.title, measures: score.measureCount(model), key: `${model.meta.key} (${model.meta.mode})`, time: model.meta.time.join('/'), tempo: model.meta.tempo, staves: staffMap(model) } : null,
      museScoreExecutable: findMuseScore(),
      settings: { autonomy: s.settings.autonomy, checkpointEvery: s.settings.checkpointEvery === Infinity ? null : s.settings.checkpointEvery, output: s.settings.output },
      profileWorks: s.profile.data.likedWorks.length,
    };
    out.live = await live.status(s.liveClient());
    return out;
  });

  add('score_new', 'Crea una obra nueva (sustituye a la actual; se puede deshacer con score_undo). Plantillas: piano, satb_open (4 pentagramas), satb_closed (SA/TB en 2 pentagramas), voice_piano, solo.', {
    title: { type: 'string' }, subtitle: { type: 'string' }, composer: { type: 'string' },
    key: { type: ['string', 'integer'], description: 'Alteraciones (-7..7; bemoles negativos) o nombre: "Eb minor", "G major"' },
    mode: { type: 'string', enum: ['major', 'minor'] },
    time: { type: ['string', 'array'], description: '"3/4" o [3,4]', items: { type: 'integer' } },
    tempo: { type: 'integer', description: 'Negras por minuto' },
    template: { type: 'string', enum: ['piano', 'satb_open', 'satb_closed', 'voice_piano', 'solo'] },
    instrument: { type: 'string', description: 'Solo para template solo: nombre del instrumento' },
  }, ['title'], async (a) => {
    const k = a.key !== undefined ? parseKey(a.key, a.mode) : { fifths: 0, mode: a.mode || 'major' };
    const model = score.newScore({ title: a.title, subtitle: a.subtitle || '', composer: a.composer || '', key: k.fifths, mode: k.mode, time: a.time ? parseTime(a.time) : [4, 4], tempo: a.tempo || 100, template: a.template || 'piano', options: { instrument: a.instrument } });
    s.setModel(model);
    return { ok: true, staves: staffMap(model), hint: model.meta.hint || undefined, note: 'Obra vacía. Escribe con score_write.' };
  });

  add('score_read', 'Devuelve la partitura en notación DSL (un bloque por compás) y la numeración de pentagramas.', range, [], async (a) => {
    const model = s.need();
    const text = score.dumpMeasures(model, a.from || 1, a.to || score.measureCount(model));
    const MAX = 14000;
    return { title: model.meta.title, key: model.meta.key, mode: model.meta.mode, time: model.meta.time.join('/'), tempo: model.meta.tempo, staves: staffMap(model), measures: score.measureCount(model), score: text.length > MAX ? text.slice(0, MAX) + '\n… (recortado: pide un rango más pequeño con from/to)' : text };
  });

  add('score_write', 'Escribe uno o varios compases. ATÓMICO e IDEMPOTENTE: valida todo antes de aplicar nada y reescribir un compás lo reemplaza (nunca duplica). Cada pentagrama se da en DSL y cada voz debe sumar justo el compás.', {
    measures: { type: 'array', description: 'Lista de compases a escribir', items: { type: 'object', properties: { n: INT, staves: { type: 'object', description: 'Número de pentagrama -> DSL, p. ej. {"1":"Eb4:q F4:q Gb4:q","2":"Eb2:q [Bb2 Eb3]:q [Bb2 Eb3]:q"}', additionalProperties: { type: 'string' } }, time: { type: 'array', items: INT }, key: INT, mode: { type: 'string' }, partial: { type: 'boolean' } }, required: ['n', 'staves'] } },
    live: { type: 'boolean', description: 'Forzar (true) o impedir (false) que además se escriba en la hoja abierta de MuseScore' },
  }, ['measures'], async (a) => {
    const r = s.commit((m) => score.writeMeasures(m, a.measures));
    if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings, note: 'No se escribió nada. Corrige los errores y repite.' };
    const model = s.model;
    const lo = Math.min(...r.written), hi = Math.max(...r.written);
    const out = { ok: true, written: r.written, warnings: r.warnings, summary: score.describeRange(model, lo, hi), totalMeasures: score.measureCount(model) };
    if (['file', 'both'].includes(s.settings.output)) out.file = exportXml('current');
    if (wantLive(a)) {
      try { out.live = summarizeLive(await live.pushMeasures(s.liveClient(), model, { from: lo, to: hi, only: r.written })); } catch (e) { out.live = { error: e.message }; }
    }
    if (s.settings.autonomy !== 'autonomous') out.next = 'Resume al usuario cómo va (usa summary) y pregunta si continúas o quiere cambios, antes de escribir más.';
    return out;
  });

  add('score_clear', 'Vacía compases (quedan como silencios); no renumera.', range, ['from'], async (a) => ({ ok: true, cleared: s.commit((m) => score.clearMeasures(m, a.from, a.to || a.from)) }));
  add('score_delete', 'Elimina compases y renumera los siguientes.', range, ['from'], async (a) => ({ ok: true, ...s.commit((m) => score.deleteMeasures(m, a.from, a.to || a.from)) }));
  add('score_undo', 'Deshace el último cambio de la obra.', {}, [], async () => ({ ok: s.undo() }));
  add('score_redo', 'Rehace el cambio deshecho.', {}, [], async () => ({ ok: s.redo() }));

  add('score_set_meta', 'Cambia título, subtítulo, compositor, tonalidad, compás de tiempo o tempo de la obra.', {
    title: { type: 'string' }, subtitle: { type: 'string' }, composer: { type: 'string' }, key: { type: ['string', 'integer'] }, mode: { type: 'string', enum: ['major', 'minor'] },
    time: { type: ['string', 'array'], items: { type: 'integer' } }, tempo: { type: 'integer' },
  }, [], async (a) => {
    const patch = { ...a };
    if (a.key !== undefined) { const k = parseKey(a.key, a.mode); patch.key = k.fifths; patch.mode = k.mode; }
    if (a.time) patch.time = parseTime(a.time);
    s.commit((m) => score.setMeta(m, patch));
    return { ok: true, meta: s.model.meta };
  });

  add('score_describe', 'Resumen determinista de un tramo: armonía, contorno melódico, rango y dinámicas.', range, [], async (a) => ({ summary: score.describeRange(s.need(), a.from || 1, a.to || score.measureCount(s.model)) }));
  add('score_lint', 'Revisa tesituras, alcance de la mano, saltos y (en coros) cruces y quintas/octavas paralelas.', range, [], async (a) => lintScore(s.need(), a.from || 1, a.to || score.measureCount(s.model)));

  add('score_export', 'Exporta la obra. musicxml (completo, no requiere MuseScore), pdf, png, mp3, mid o mscz (estos usan MuseScore). Devuelve las rutas de los archivos.', {
    format: { type: 'string', enum: ['musicxml', 'pdf', 'png', 'mp3', 'mid', 'mscz'] }, name: { type: 'string', description: 'Nombre del archivo sin extensión' },
  }, ['format'], async (a) => {
    const xml = exportXml(a.name);
    if (a.format === 'musicxml') return { ok: true, files: [xml] };
    const out = xml.replace(/\.musicxml$/, '.' + a.format);
    return { ok: true, files: await convert(xml, out, { dpi: a.format === 'png' ? 110 : undefined }) };
  });

  add('ms_open', 'Exporta la obra a MusicXML y la abre en MuseScore (como pestaña nueva, sin tocar la hoja que tengas abierta). Es la vía con TODAS las marcas.', {}, [], async () => {
    const file = exportXml();
    openInMuseScore(file);
    return { ok: true, file };
  });

  add('score_import', 'Importa una partitura existente para editarla: .musicxml/.xml, .mxl, .mscz/.mscx (vía MuseScore) o .mid. Sustituye la obra actual (se puede deshacer).', {
    path: { type: 'string', description: 'Ruta absoluta del archivo' },
  }, ['path'], async (a) => {
    if (!fs.existsSync(a.path)) throw new Error(`no existe el archivo: ${a.path}`);
    const ext = path.extname(a.path).toLowerCase();
    let model, warnings = [];
    if (ext === '.mid' || ext === '.midi') { const r = await audio.transcribe(a.path, {}); model = r.model; warnings = r.warnings; }
    else {
      let xmlFile = a.path;
      if (!['.musicxml', '.xml'].includes(ext)) {
        const tmp = path.join(os.tmpdir(), `ca-import-${Date.now()}.musicxml`);
        await convert(a.path, tmp);
        xmlFile = tmp;
      }
      const r = fromMusicXML(fs.readFileSync(xmlFile, 'utf8'), { title: path.basename(a.path, ext) });
      model = r.model; warnings = r.warnings;
    }
    s.setModel(model);
    return { ok: true, title: model.meta.title, measures: score.measureCount(model), staves: staffMap(model), key: model.meta.key, warnings };
  });

  add('ms_live_status', 'Comprueba la conexión con el plugin de MuseScore (puerto 8765), qué extensiones tiene y qué hoja está abierta.', {}, [], async () => live.status(s.liveClient()));
  add('ms_live_push', 'Escribe (o reescribe) compases de la obra en la hoja abierta de MuseScore y los verifica leyéndolos de vuelta. Idempotente. En vivo solo viajan notas, silencios, cifrados, textos y letra; pedal, reguladores y ligaduras van por score_export/ms_open.', {
    ...range, verify: { type: 'boolean', description: 'Releer la hoja y comparar (por defecto true)' },
  }, [], async (a) => {
    const model = s.need();
    return summarizeLive(await live.pushMeasures(s.liveClient(), model, { from: a.from || 1, to: a.to || score.measureCount(model), verify: a.verify !== false }));
  });
  add('ms_live_prepare', 'Ajusta compás de tiempo, tempo y (si el plugin lo permite) armadura al principio de la hoja abierta. Solo si se pide: modifica la hoja.', {}, [], async () => ({ applied: await live.prepareScore(s.liveClient(), s.need()) }));
  add('ms_live_read', 'Lee lo que hay realmente en la hoja abierta (notas por compás y pentagrama, voz 1).', range, [], async (a) => {
    const an = await live.readScore(s.liveClient());
    const from = a.from || 1, to = Math.min(a.to || from + 15, an.numMeasures);
    const lines = [];
    for (let n = from; n <= to; n++) {
      const m = an.measures[n - 1];
      for (const [staff, els] of Object.entries(m.elements)) {
        const seq = els.filter((e) => (e.voice || 0) === 0).sort((x, y) => x.startTick - y.startTick).map((e) => (e.name === 'Rest' ? 'r' : (e.notes || []).map((nn) => nn.pitchName).join('+')));
        lines.push(`m${n} ${staff}: ${seq.join(' ') || '-'}`);
      }
    }
    return { title: an.title, numMeasures: an.numMeasures, staves: an.staves.length, content: lines.join('\n') };
  });
  add('ms_live_undo', 'Deshace en MuseScore la última operación hecha por el plugin.', {}, [], async () => live.status(s.liveClient()).then(async () => s.liveClient().send('undo', {})));

  add('choir_lyrics', 'Reparte una letra sobre las notas de una voz. "Glo-ri-a in ex-cel-sis": el guion une sílabas. Reemplaza la letra previa de ese verso (idempotente).', {
    staff: INT, from: { ...INT, description: 'Compás inicial' }, text: { type: 'string' }, verse: { ...INT, description: 'Verso (1 por defecto)' }, voice: { ...INT, description: 'Voz dentro del pentagrama, 0 = la primera' },
  }, ['staff', 'text'], async (a) => s.commit((m) => ({ ok: true, ...choir.setLyrics(m, { staff: a.staff, from: a.from || 1, text: a.text, verse: a.verse || 1, voice: a.voice || 0 }) })));
  add('choir_check', 'Reglas SATB: tesituras, cruces de voces, espaciado y quintas/octavas paralelas.', range, [], async (a) => choir.checkChoir(s.need(), a.from || 1, a.to || score.measureCount(s.model)));

  add('audio_transcribe', 'Transcribe un audio (WAV, o MP3/M4A con ffmpeg) o MIDI a una partitura nueva y editable. mode "melody" (monofónico, sin dependencias) o "polyphonic" (requiere basic-pitch). Sustituye la obra actual (se puede deshacer).', {
    path: { type: 'string' }, mode: { type: 'string', enum: ['melody', 'polyphonic'] }, bpm: { type: 'integer', description: 'Tempo si lo sabes (mejora mucho el resultado)' },
    time: { type: ['string', 'array'], items: { type: 'integer' } }, key: { type: ['string', 'integer'] }, title: { type: 'string' },
  }, ['path'], async (a) => {
    if (!fs.existsSync(a.path)) throw new Error(`no existe el archivo: ${a.path}`);
    const k = a.key !== undefined ? parseKey(a.key) : {};
    const r = await audio.transcribe(a.path, { engine: a.mode, bpm: a.bpm, time: a.time ? parseTime(a.time) : undefined, key: k.fifths, mode: k.mode, title: a.title });
    s.setModel(r.model);
    return { ok: true, ...r.info, warnings: r.warnings, staves: staffMap(r.model), next: 'Revisa con score_read y corrige lo que haga falta.' };
  });

  add('profile_get', 'Perfil de gustos del usuario: obras que le gustan, estilo, cosas a evitar.', {}, [], async () => { s.profile.reload(); return s.profile.data; });
  add('profile_add_work', 'Guarda en el perfil una obra o estilo que le gusta al usuario (sin duplicados).', { title: { type: 'string' }, composer: { type: 'string' }, notes: { type: 'string', description: 'Qué le gusta de ella' } }, ['title'], async (a) => ({ ok: true, works: s.profile.addWork(a).likedWorks.length }));
  add('profile_remove_work', 'Quita una obra del perfil.', { title: { type: 'string' } }, ['title'], async (a) => ({ ok: true, works: s.profile.removeWork(a.title).likedWorks.length }));
  add('profile_set_notes', 'Fija las notas de estilo y/o lo que se debe evitar.', { styleNotes: { type: 'string' }, dislikes: { type: 'array', items: { type: 'string' } } }, [], async (a) => ({ ok: true, profile: s.profile.setNotes(a) }));

  add('autonomy_set', 'Cambia el modo de trabajo: per_measure (pregunta tras cada compás), per_phrase (cada 4), per_section (cada 8) o autonomous (toda la obra sin parar).', {
    mode: { type: 'string', enum: Object.keys(AUTONOMY_EVERY) }, every: { ...INT, description: 'Compases entre preguntas (opcional)' },
  }, ['mode'], async (a) => {
    const next = s.store.saveSettings({ autonomy: a.mode, ...(a.every ? { checkpointEvery: a.every } : {}) });
    return { ok: true, autonomy: next.autonomy, checkpointEvery: next.checkpointEvery === Infinity ? null : next.checkpointEvery, instruction: autonomyInstruction(next) };
  });
  add('checkpoint', 'Detén el trabajo y pregunta al usuario cómo va (resumen) y qué prefiere. Devuelve su respuesta.', { summary: { type: 'string' }, question: { type: 'string' } }, ['summary'], async (a) => {
    if (s.checkpoint) return { reply: await s.checkpoint({ summary: a.summary, question: a.question || '' }) };
    return { ask_user: true, message: 'Muestra el resumen al usuario en el chat, formula la pregunta y espera su respuesta antes de continuar.', summary: a.summary, question: a.question || '' };
  });

  add('project_list', 'Lista las obras guardadas con project_save.', {}, [], async () => ({ projects: s.store.listProjects() }));
  add('project_save', 'Guarda una copia con nombre de la obra actual.', { name: { type: 'string' } }, ['name'], async (a) => { s.store.saveProject(s.need(), a.name); return { ok: true, saved: safeName(a.name) }; });
  add('project_open', 'Abre una obra guardada (sustituye a la actual; se puede deshacer).', { name: { type: 'string' } }, ['name'], async (a) => {
    const m = s.store.loadProject(a.name);
    if (!m) throw new Error(`no existe la obra "${a.name}" (usa project_list)`);
    s.setModel(m);
    return { ok: true, title: m.meta.title, measures: score.measureCount(m) };
  });

  return T;
}

async function callTool(tools, name, rawArgs) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`herramienta desconocida: ${name}`);
  const args = coerce(tool.inputSchema, rawArgs);
  validateArgs(tool, args);
  return tool.handler(args);
}

const toOpenAITools = (tools) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

module.exports = { buildTools, callTool, toOpenAITools, parseKey, parseTime, coerce };
