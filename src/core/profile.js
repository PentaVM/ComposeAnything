'use strict';
// Perfil de gustos: las obras y estilos que te gustan. Se inyecta en el prompt del sistema para que la IA
// componga "a tu manera" y puede ampliarse conversando (profile_add_work) o editarse a mano en la app.

const EMPTY = { likedWorks: [], dislikes: [], styleNotes: '' };

class Profile {
  constructor(store) { this.store = store; this.data = { ...EMPTY, ...(store.readJson('profile.json', {}) || {}) }; }

  reload() { this.data = { ...EMPTY, ...(this.store.readJson('profile.json', {}) || {}) }; return this.data; }
  save() { this.store.writeJson('profile.json', this.data); return this.data; }

  addWork({ title, composer = '', notes = '' }) {
    if (!title || !String(title).trim()) throw new Error('title es obligatorio');
    const key = (w) => `${w.title}|${w.composer}`.toLowerCase();
    const work = { title: String(title).trim(), composer: String(composer).trim(), notes: String(notes).trim() };
    const i = this.data.likedWorks.findIndex((w) => key(w) === key(work));
    if (i >= 0) this.data.likedWorks[i] = { ...this.data.likedWorks[i], ...work }; // sin duplicados: actualiza
    else this.data.likedWorks.push(work);
    return this.save();
  }

  removeWork(title) {
    const before = this.data.likedWorks.length;
    this.data.likedWorks = this.data.likedWorks.filter((w) => w.title.toLowerCase() !== String(title).toLowerCase());
    if (this.data.likedWorks.length === before) throw new Error(`no hay ninguna obra llamada "${title}" en el perfil`);
    return this.save();
  }

  setNotes({ styleNotes, dislikes }) {
    if (styleNotes !== undefined) this.data.styleNotes = String(styleNotes);
    if (dislikes !== undefined) this.data.dislikes = Array.isArray(dislikes) ? dislikes.map(String) : String(dislikes).split('\n').map((s) => s.trim()).filter(Boolean);
    return this.save();
  }

  toPrompt() {
    const d = this.data;
    if (!d.likedWorks.length && !d.dislikes.length && !d.styleNotes.trim()) return '';
    const lines = ['## Gustos del usuario (úsalos como brújula estilística; no copies obras literalmente)'];
    if (d.likedWorks.length) lines.push('Obras que le gustan:', ...d.likedWorks.map((w) => `- ${w.title}${w.composer ? ' — ' + w.composer : ''}${w.notes ? ': ' + w.notes : ''}`));
    if (d.styleNotes.trim()) lines.push('Notas de estilo:', d.styleNotes.trim());
    if (d.dislikes.length) lines.push('Evitar:', ...d.dislikes.map((s) => `- ${s}`));
    return lines.join('\n');
  }
}

module.exports = { Profile };
