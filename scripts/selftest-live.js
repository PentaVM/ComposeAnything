#!/usr/bin/env node
'use strict';
// Autotest de la conexión en vivo con TU MuseScore.
//   npm run selftest              solo lectura: conexión, plugin, hoja abierta
//   npm run selftest -- --yes     además ESCRIBE 2 compases de prueba (sobrescribe los compases 1–2 de la hoja abierta)
//   --url ws://127.0.0.1:8765     otro puerto o el plugin simulado
// Úsalo con una hoja de prueba (piano, 3/4) y comprueba a ojo lo que no se puede leer de vuelta (dinámica, texto, cifrado).

const { LiveClient, status, pushMeasures } = require('../src/core/live');
const score = require('../src/core/score');

async function run({ url, yes = false, log = console.log } = {}) {
  const client = new LiveClient({ url, timeout: 15000 });
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok }); log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`); };
  try {
    log(`Conectando con ${client.url} …`);
    const st = await status(client);
    if (!st.connected) {
      check('Conexión con el plugin', false, st.error);
      log('\nAbre una partitura y ejecuta Plugins → ComposeAnything (instálalo antes con: npm run install-plugin).');
      return { ok: false, results };
    }
    check('Conexión con el plugin', true, st.plugin.plugin === 'composeanything' ? `ComposeAnything v${st.plugin.version}` : 'plugin básico (sin extensiones)');
    check('Hoja abierta', !!st.score, st.score ? `"${st.score.title}", ${st.score.numMeasures} compases, ${st.score.numStaves} pentagramas` : st.error);
    const actions = st.plugin.actions || [];
    log(`  Extensiones disponibles: ${actions.length ? actions.join(', ') : 'ninguna'}`);
    if (!st.score) return { ok: false, results };

    if (!yes) {
      log('\nSolo lectura. Para probar la escritura (sobrescribe los compases 1–2) repite con: npm run selftest -- --yes');
      return { ok: results.every((r) => r.ok), results };
    }
    if (st.score.numStaves < 2) { check('Hoja de prueba', false, 'necesita un piano (2 pentagramas)'); return { ok: false, results }; }

    log('\nEscribiendo compases de prueba…');
    const model = score.newScore({ title: 'selftest', time: [3, 4], key: 0 });
    score.writeMeasures(model, [
      { n: 1, staves: { 1: '{harm C} {dyn mf} {txt prueba} C5:q E5:q G5:q', 2: 'C3:q [E3 G3]:q [E3 G3]:q' } },
      { n: 2, staves: { 1: 'G5:hd', 2: 'G2:hd' } },
    ]);
    const r = await pushMeasures(client, model, { from: 1, to: 2 });
    check('Notas, acordes y silencios escritos y releídos', !!r.verify?.ok, r.verify?.ok ? `${r.verify.checked} compases verificados` : JSON.stringify(r.verify?.mismatches));
    if (r.verify?.spellingDifferences) log(`  ⚠ ${r.verify.spellingDifferences} compases con otra grafía: la armadura de la hoja no coincide con la del modelo`);
    for (const w of r.warnings) log(`  ⚠ ${w}`);

    const extras = [['addHarmony', { tick: 0, staff: 0, text: 'Am' }], ['addDynamic', { tick: 0, staff: 0, name: 'f' }], ['addStaffText', { tick: 0, staff: 0, text: 'selftest' }], ['addRehearsalMark', { tick: 0, staff: 0, text: 'A' }]];
    log('\nExtensiones (mira la hoja para confirmar que aparecen):');
    for (const [action, params] of extras) {
      if (!actions.includes(action)) { check(action, false, 'no está en este plugin'); continue; }
      try { await client.send(action, params); check(action, true, 'ejecutada'); } catch (e) { check(action, false, e.message); }
    }
    log('\nDeshaz lo escrito con Ctrl+Z en MuseScore si era una hoja de prueba.');
    return { ok: results.every((x) => x.ok), results };
  } catch (e) {
    check('Autotest', false, e.message);
    return { ok: false, results };
  } finally { client.close(); }
}

if (require.main === module) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  run({ url: arg('--url'), yes: process.argv.includes('--yes') }).then((r) => process.exit(r.ok ? 0 : 1));
}

module.exports = { run };
