'use strict';
// Copia el plugin QML a la carpeta de plugins de MuseScore 4. Habilitarlo sigue siendo un paso manual en MuseScore.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SOURCE = path.join(__dirname, '..', '..', 'plugin', 'composeanything.qml');
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function pluginDir(documents) {
  return path.join(documents || path.join(os.homedir(), 'Documents'), 'MuseScore4', 'Plugins');
}

const STEPS = [
  'Reinicia MuseScore si no ves el plugin en el menú.',
  'Plugins → Gestionar plugins… → activa "ComposeAnything" → Aceptar.',
  'Abre una partitura y elige Plugins → ComposeAnything (déjalo en marcha: escucha en el puerto 8765).',
];

function installPlugin({ documents } = {}) {
  if (!fs.existsSync(SOURCE)) throw new Error('No encuentro plugin/composeanything.qml en la instalación');
  const dir = pluginDir(documents);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'composeanything.qml');
  const existed = fs.existsSync(target);
  fs.copyFileSync(SOURCE, target);
  return { path: target, updated: existed, steps: STEPS };
}

function pluginStatus({ documents } = {}) {
  const target = path.join(pluginDir(documents), 'composeanything.qml');
  const installed = fs.existsSync(target);
  return { path: target, installed, upToDate: installed && hash(target) === hash(SOURCE) };
}

/**
 * Autoinstalación al arrancar la app: la primera vez copia el plugin; después lo actualiza si cambió.
 * Si el usuario lo borró a propósito no se vuelve a instalar. Se desactiva con settings.pluginAutoInstall = false.
 */
function ensurePlugin({ documents, store }) {
  const settings = store.settings();
  if (settings.pluginAutoInstall === false) return { action: 'disabled' };
  const s = pluginStatus({ documents });
  if (s.installed && s.upToDate) return { action: 'ok', path: s.path };
  if (!s.installed && settings.pluginInstalledOnce) return { action: 'skipped', path: s.path };
  const r = installPlugin({ documents });
  store.saveSettings({ pluginInstalledOnce: true });
  return { action: s.installed ? 'updated' : 'installed', ...r };
}

module.exports = { installPlugin, pluginStatus, ensurePlugin, pluginDir, SOURCE, STEPS };
