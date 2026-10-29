'use strict';
// Agente: bucle de chat con herramientas para cualquier API compatible con OpenAI.
// Los puntos de control (preguntar tras cada compás / frase / sección) los impone ESTE código, no el prompt:
//  - score_write se limita a `checkpointEvery` compases por llamada.
//  - al alcanzar el umbral se detiene el bucle, se emite un resumen determinista y se espera al usuario.

const { EventEmitter } = require('events');
const { buildTools, callTool, toOpenAITools } = require('./tools');
const { systemPrompt } = require('./prompt');
const { describeRange } = require('./score');
const llm = require('./llm');

const MAX_STEPS = 60;
const MAX_TOOL_CHARS = 7000;
const KEEP_RECENT = 24;

const trunc = (s, n = MAX_TOOL_CHARS) => (s.length > n ? s.slice(0, n) + `…[recortado ${s.length - n} caracteres]` : s);

class Agent extends EventEmitter {
  /**
   * @param {object} o
   * @param {Session} o.session
   * @param {() => {baseUrl,model,temperature,apiKey}} o.getConfig  configuración del proveedor en cada vuelta
   * @param {Function} [o.chat]  inyectable para pruebas
   */
  constructor({ session, getConfig, chat = llm.chat }) {
    super();
    this.session = session;
    this.getConfig = getConfig;
    this.chat = chat;
    this.tools = buildTools(session);
    this.messages = session.store.readJson('chat.json', []) || [];
    this.busy = false;
    this.abort = null;
    this.waiting = new Map();
    this.seq = 0;
    session.checkpoint = (p) => this.askCheckpoint({ ...p, auto: false }).then((r) => (r.action === 'stop' ? 'El usuario pidió detenerse aquí.' : r.text || 'Continúa.'));
  }

  reset() { this.messages = []; this.persist(); }
  persist() { try { this.session.store.writeJson('chat.json', this.messages.slice(-80)); } catch { /* no crítico */ } }

  stop() {
    this.abort?.abort();
    for (const [, w] of this.waiting) w.resolve({ action: 'stop', text: '' });
  }

  answerCheckpoint(id, { action = 'continue', text = '' } = {}) {
    const w = this.waiting.get(id);
    if (!w) return false;
    this.waiting.delete(id);
    w.resolve({ action, text });
    return true;
  }

  askCheckpoint({ summary, question, auto = true }) {
    if (!this.listenerCount('checkpoint')) return Promise.resolve({ action: 'continue', text: '' }); // sin interfaz: no bloquear
    const id = `cp${++this.seq}`;
    return new Promise((resolve) => {
      this.waiting.set(id, { resolve });
      this.emit('checkpoint', { id, summary, question, auto });
      this.emit('status', { state: 'waiting' });
    });
  }

  /** Limita score_write a `every` compases por llamada según el modo de autonomía. */
  guardedTools() {
    const every = this.session.settings.checkpointEvery;
    return this.tools.map((t) => {
      if (t.name !== 'score_write' || !Number.isFinite(every)) return t;
      return {
        ...t,
        handler: async (a) => {
          const n = Array.isArray(a.measures) ? a.measures.length : 0;
          if (n > every) return { ok: false, errors: [`En este modo de trabajo solo puedes escribir ${every} compás(es) por llamada (intentaste ${n}). No se escribió nada: reenvía los primeros ${every}.`] };
          return t.handler(a);
        },
      };
    });
  }

  /** Historial acotado: empieza siempre en un mensaje del usuario (los proveedores rechazan `tool` huérfanos). */
  compact() {
    let win = this.messages.slice(-80);
    const firstUser = win.findIndex((m) => m.role === 'user');
    win = firstUser > 0 ? win.slice(firstUser) : win;
    return win.map((m, i) => (m.role === 'tool' && i < win.length - KEEP_RECENT && m.content.length > 500 ? { ...m, content: '{"omitido":"resultado antiguo recortado"}' } : m));
  }

  async send(text) {
    if (this.busy) throw new Error('El agente ya está trabajando. Espera o detenlo.');
    this.busy = true;
    this.abort = new AbortController();
    this.messages.push({ role: 'user', content: text });
    let pending = [];
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        this.emit('status', { state: 'thinking' });
        this.session.refresh();
        const cfg = this.getConfig();
        const sys = systemPrompt({ settings: this.session.settings, profile: this.session.profile, model: this.session.model });
        const tools = this.guardedTools();
        const res = await this.chat({ ...cfg, messages: [{ role: 'system', content: sys }, ...this.compact()], tools: toOpenAITools(tools), signal: this.abort.signal });
        const msg = res.message;
        this.messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
        if (msg.content) this.emit('message', { role: 'assistant', text: msg.content });
        if (!msg.tool_calls?.length) break;

        let stopRequested = false, userNote = null, deferred = false;
        for (const call of msg.tool_calls) {
          if (deferred) { this.messages.push({ role: 'tool', tool_call_id: call.id, content: '{"omitido":"punto de control pendiente; se retomará tras la respuesta del usuario"}' }); continue; }
          const name = call.function?.name;
          let args = {}, result, error;
          try { args = JSON.parse(call.function?.arguments || '{}'); } catch { error = 'los argumentos no son JSON válido; reenvía la llamada con JSON correcto'; }
          const t0 = Date.now();
          if (!error) { try { result = await callTool(tools, name, args); } catch (e) { error = e.message; } }
          this.emit('tool', { name, args, result, error, ms: Date.now() - t0 });
          this.messages.push({ role: 'tool', tool_call_id: call.id, content: trunc(JSON.stringify(error ? { error } : result ?? null)) });

          if (name === 'score_write' && result?.ok) pending.push(...result.written);
          const every = this.session.settings.checkpointEvery;
          if (pending.length && Number.isFinite(every) && pending.length >= every) {
            const lo = Math.min(...pending), hi = Math.max(...pending);
            const r = await this.askCheckpoint({ summary: describeRange(this.session.model, lo, hi), question: '¿Sigo con el siguiente tramo o quieres cambios?', auto: true });
            pending = [];
            deferred = true;
            if (r.action === 'stop') stopRequested = true;
            userNote = r.text ? `Punto de control — respuesta del usuario: ${r.text}` : (r.action === 'stop' ? null : 'Punto de control — el usuario dice: continúa.');
          }
        }
        if (stopRequested) { this.messages.push({ role: 'user', content: 'Punto de control — el usuario pidió detenerse aquí. Resume brevemente y espera instrucciones.' }); this.emit('message', { role: 'system', text: 'Detenido en el punto de control.' }); break; }
        if (userNote) this.messages.push({ role: 'user', content: userNote });
      }
    } catch (e) {
      if (e.name === 'AbortError') this.emit('message', { role: 'system', text: 'Detenido.' });
      else this.emit('error', { message: e.message });
    } finally {
      this.busy = false;
      this.abort = null;
      this.persist();
      this.emit('status', { state: 'idle' });
    }
  }
}

module.exports = { Agent };
