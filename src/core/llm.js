'use strict';
// Cliente para cualquier API compatible con OpenAI (/chat/completions): OpenAI, OpenRouter, Ollama, LM Studio,
// vLLM, Together, Groq... y también Claude mediante su endpoint compatible (https://api.anthropic.com/v1/).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trimUrl = (u) => String(u || '').replace(/\/+$/, '');

class LlmError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function request(url, init, { retries = 3, signal } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.ok) return res;
      const text = await res.text();
      let detail = text.slice(0, 300);
      try { const j = JSON.parse(text); detail = j.error?.message || j.message || detail; } catch { /* texto plano */ }
      last = new LlmError(`HTTP ${res.status}: ${detail}`, res.status);
      if (![408, 429, 500, 502, 503, 504].includes(res.status) || attempt === retries) throw last;
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra > 0 ? Math.min(ra * 1000, 15000) : 400 * 2 ** attempt);
    } catch (e) {
      if (e.name === 'AbortError' || e instanceof LlmError && ![408, 429, 500, 502, 503, 504].includes(e.status)) throw e;
      last = e;
      if (attempt === retries) throw e instanceof LlmError ? e : new LlmError(`No se pudo conectar con ${new URL(url).host}: ${e.cause?.code || e.message}`);
      await sleep(400 * 2 ** attempt);
    }
  }
  throw last;
}

/** Una vuelta de chat con herramientas. Devuelve {message, finish, usage}. */
async function chat({ baseUrl, apiKey, model, messages, tools, temperature = 0.7, signal, retries = 3 }) {
  if (!baseUrl) throw new LlmError('Falta la URL base del proveedor (Ajustes → IA).');
  if (!model) throw new LlmError('Falta el modelo (Ajustes → IA).');
  const body = { model, messages, temperature, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}) };
  const res = await request(`${trimUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
  }, { retries, signal });
  const json = await res.json();
  const choice = json.choices?.[0];
  if (!choice?.message) throw new LlmError('Respuesta sin mensaje del proveedor: ' + JSON.stringify(json).slice(0, 200));
  return { message: choice.message, finish: choice.finish_reason, usage: json.usage };
}

/** Modelos disponibles (para el desplegable de la app). */
async function listModels({ baseUrl, apiKey }) {
  const res = await request(`${trimUrl(baseUrl)}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} }, { retries: 1 });
  const json = await res.json();
  return (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}

const PRESETS = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { label: 'Claude (API compatible con OpenAI)', baseUrl: 'https://api.anthropic.com/v1' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  ollama: { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1' },
  lmstudio: { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1' },
};

module.exports = { chat, listModels, LlmError, PRESETS };
