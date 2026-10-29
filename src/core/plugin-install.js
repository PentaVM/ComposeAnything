'use strict';
// Copia el plugin QML a la carpeta de plugins de MuseScore 4. Habilitarlo sigue siendo un paso manual en MuseScore.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE = path.join(__dirname, '..', '..', 'plugin', 'composeanything.qml');

function pluginDir(documents) {
  return path.join(documents || path.join(os.homedir(), 'Documents'), 'MuseScore4', 'Plugins');
}

function installPlugin({ documents } = {}) {
  if (!fs.existsSync(SOURCE)) throw new Error('No encuentro plugin/composeanything.qml en la instalación');
  const dir = pluginDir(documents);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'composeanything.qml');
  const existed = fs.existsSync(target);
  fs.copyFileSync(SOURCE, target);
  return {
    path: target, updated: existed,
    steps: [
      'Reinicia MuseScore si no ves el plugin en el menú.',
      'Plugins → Gestionar plugins… → activa "ComposeAnything" → Aceptar.',
      'Abre una partitura y elige Plugins → ComposeAnything (déjalo en marcha: escucha en el puerto 8765).',
    ],
  };
}

module.exports = { installPlugin, pluginDir, SOURCE };
