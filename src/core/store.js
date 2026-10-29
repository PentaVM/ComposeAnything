'use strict';
// Persistencia en disco (JSON, escritura atómica). El servidor MCP y la app de escritorio comparten esta carpeta,
// así que cualquiera de los dos ve la misma obra, el mismo perfil de gustos y los mismos ajustes.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SETTINGS = {
  language: 'es',
  autonomy: 'per_measure',     // per_measure | per_phrase | per_section | autonomous
  checkpointEvery: 1,          // compases entre preguntas (lo fija el modo; editable)
  output: 'file',              // file | live | both
  llm: { baseUrl: 'https://api.openai.com/v1', model: '', temperature: 0.7 },
  musescore: { wsUrl: 'ws://127.0.0.1:8765' },
  pluginAutoInstall: true,     // la app copia/actualiza el plugin de MuseScore al arrancar
  pluginInstalledOnce: false,  // true tras la primera copia: si lo borras, no se reinstala
};

const AUTONOMY_EVERY = { per_measure: 1, per_phrase: 4, per_section: 8, autonomous: Infinity };

function homeDir() {
  return process.env.COMPOSEANYTHING_HOME || path.join(os.homedir(), '.composeanything');
}

const safeName = (n) => String(n).replace(/[^\w\-áéíóúüñÁÉÍÓÚÜÑ .]/g, '_').slice(0, 80) || 'obra';

class Store {
  constructor(dir = homeDir()) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(...p) { return path.join(this.dir, ...p); }

  readJson(rel, fallback = null) {
    try { return JSON.parse(fs.readFileSync(this.file(rel), 'utf8')); } catch { return fallback; }
  }

  writeJson(rel, data) {
    const target = this.file(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  }

  mtime(rel) { try { return fs.statSync(this.file(rel)).mtimeMs; } catch { return 0; } }

  settings() {
    const s = this.readJson('settings.json', {});
    return { ...DEFAULT_SETTINGS, ...s, llm: { ...DEFAULT_SETTINGS.llm, ...(s.llm || {}) }, musescore: { ...DEFAULT_SETTINGS.musescore, ...(s.musescore || {}) } };
  }

  saveSettings(patch) {
    const cur = this.settings();
    const next = { ...cur, ...patch, llm: { ...cur.llm, ...(patch.llm || {}) }, musescore: { ...cur.musescore, ...(patch.musescore || {}) } };
    if (patch.autonomy && patch.checkpointEvery === undefined) next.checkpointEvery = AUTONOMY_EVERY[patch.autonomy] ?? next.checkpointEvery;
    this.writeJson('settings.json', next);
    return next;
  }

  // Proyectos: projects/<nombre>.json ; "current" es el que se está editando.
  loadProject(name = 'current') { return this.readJson(`projects/${safeName(name)}.json`, null); }
  saveProject(model, name = 'current') { this.writeJson(`projects/${safeName(name)}.json`, model); }
  projectMtime(name = 'current') { return this.mtime(`projects/${safeName(name)}.json`); }
  listProjects() {
    try { return fs.readdirSync(this.file('projects')).filter((f) => f.endsWith('.json') && f !== 'current.json').map((f) => f.slice(0, -5)); } catch { return []; }
  }
  exportsDir() { const d = this.file('exports'); fs.mkdirSync(d, { recursive: true }); return d; }
}

module.exports = { Store, DEFAULT_SETTINGS, AUTONOMY_EVERY, homeDir, safeName };
