'use strict';
// Puente seguro entre la interfaz y el proceso principal. La interfaz no tiene Node ni red: todo pasa por aquí.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

contextBridge.exposeInMainWorld('api', {
  send: (text) => invoke('chat:send', text),
  stop: () => invoke('chat:stop'),
  reset: () => invoke('chat:reset'),
  history: () => invoke('chat:history'),
  answerCheckpoint: (id, answer) => invoke('checkpoint:answer', id, answer),
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  setApiKey: (key) => invoke('secret:set', key),
  listModels: () => invoke('models:list'),
  status: () => invoke('status'),
  tool: (name, args) => invoke('tool:call', name, args),
  profile: {
    get: () => invoke('profile:get'),
    addWork: (w) => invoke('profile:addWork', w),
    removeWork: (title) => invoke('profile:removeWork', title),
    setNotes: (n) => invoke('profile:setNotes', n),
  },
  pickFile: (kind) => invoke('file:pick', kind),
  pathOf: (file) => webUtils.getPathForFile(file),
  installPlugin: () => invoke('plugin:install'),
  dock: () => invoke('window:dock'),
  pin: (on) => invoke('window:pin', on),
  reveal: (p) => invoke('shell:reveal', p),
  onEvent: (fn) => { const h = (_e, ev) => fn(ev); ipcRenderer.on('agent:event', h); return () => ipcRenderer.off('agent:event', h); },
});
