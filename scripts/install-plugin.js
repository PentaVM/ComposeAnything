#!/usr/bin/env node
'use strict';
// Copia el plugin de MuseScore a Documentos\MuseScore4\Plugins.   npm run install-plugin

const { installPlugin } = require('../src/core/plugin-install');

try {
  const r = installPlugin();
  console.log(`${r.updated ? 'Plugin actualizado' : 'Plugin copiado'}: ${r.path}\n`);
  r.steps.forEach((s, i) => console.log(`${i + 1}. ${s}`));
} catch (e) {
  console.error('No se pudo instalar el plugin:', e.message);
  process.exit(1);
}
