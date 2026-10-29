'use strict';
// Sesión de trabajo: la obra actual, su historial de deshacer, el perfil y la conexión con MuseScore.
// Se comparte entre procesos a través de la carpeta de datos (ver store.js): `refresh()` recarga si otro
// proceso (p. ej. el servidor MCP o la app) cambió la obra.

const { Store } = require('./store');
const { Profile } = require('./profile');
const { ScoreHistory } = require('./score');
const { LiveClient } = require('./live');

const clone = (x) => JSON.parse(JSON.stringify(x));

class Session {
  constructor({ store, live } = {}) {
    this.store = store || new Store();
    this.live = live || null;
    this.profile = new Profile(this.store);
    this.history = new ScoreHistory();
    this.model = this.store.loadProject();
    this._mtime = this.store.projectMtime();
    this.checkpoint = null; // async ({summary, question}) => texto del usuario; lo fija el agente de la app
    this.listeners = new Set();
  }

  get settings() { return this.store.settings(); }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) { try { fn(ev); } catch { /* un oyente roto no debe tumbar la herramienta */ } } }

  liveClient() {
    const url = this.settings.musescore.wsUrl;
    if (!this.live || this.live.url !== url) { this.live?.close(); this.live = new LiveClient({ url }); }
    return this.live;
  }

  refresh() {
    const m = this.store.projectMtime();
    if (m !== this._mtime) { this.model = this.store.loadProject(); this._mtime = m; this.history = new ScoreHistory(); }
    this.profile.reload();
  }

  need() {
    this.refresh();
    if (!this.model) throw new Error('No hay ninguna obra abierta. Crea una con score_new, impórtala con score_import o transcribe un audio con audio_transcribe.');
    return this.model;
  }

  /** Aplica un cambio sobre una copia; solo si no falla (ok !== false) sustituye la obra y guarda. */
  commit(mutator) {
    const draft = clone(this.need());
    const result = mutator(draft);
    if (result && result.ok === false) return result;
    this.history.push(this.model);
    this.model = draft;
    this.save();
    this.emit({ type: 'score', measures: Object.keys(draft.measures).length });
    return result;
  }

  setModel(model) {
    this.refresh();
    if (this.model) this.history.push(this.model);
    this.model = model;
    this.save();
    this.emit({ type: 'score', measures: Object.keys(model.measures).length });
  }

  undo() { const prev = this.history.undo(this.need()); if (!prev) return false; this.model = prev; this.save(); this.emit({ type: 'score' }); return true; }
  redo() { const nxt = this.history.redo(this.need()); if (!nxt) return false; this.model = nxt; this.save(); this.emit({ type: 'score' }); return true; }

  save() { this.store.saveProject(this.model); this._mtime = this.store.projectMtime(); }
}

module.exports = { Session };
