'use strict';
// Revisión de la partitura: tesituras, alcance de la mano, saltos y, en coros, reglas SATB.

const { parseStream, splitVoices } = require('./dsl');
const { staffList, measureCount, validateMeasure } = require('./score');
const { checkChoir } = require('./choir');

function lintScore(model, from = 1, to = measureCount(model)) {
  const issues = [];
  const staves = staffList(model);
  for (let n = from; n <= to; n++) {
    const m = model.measures[n];
    if (!m) continue;
    for (const w of validateMeasure(model, n, m).warnings) issues.push({ severity: 'warn', measure: n, rule: 'tesitura', text: w });
    for (const [sid, src] of Object.entries(m.staves || {})) {
      const info = staves.find((s) => String(s.global) === sid);
      splitVoices(src).forEach((v, vi) => {
        let prevTop = null;
        for (const t of parseStream(v)) {
          if (t.kind !== 'note') continue;
          const mi = t.pitches.map((p) => p.midi);
          if (info?.part.range === 'piano' && Math.max(...mi) - Math.min(...mi) > 14) {
            issues.push({ severity: 'warn', measure: n, rule: 'alcance', text: `acorde de ${Math.max(...mi) - Math.min(...mi)} semitonos en ${info.part.name}#${info.local}: difícil de abarcar con una mano` });
          }
          const top = Math.max(...mi);
          if (vi === 0 && prevTop !== null && Math.abs(top - prevTop) > 24) issues.push({ severity: 'info', measure: n, rule: 'salto', text: `salto de ${Math.abs(top - prevTop)} semitonos (más de dos octavas)` });
          prevTop = top;
        }
      });
    }
  }
  const choir = checkChoir(model, from, to);
  issues.push(...choir.issues);
  issues.sort((a, b) => a.measure - b.measure);
  const counts = issues.reduce((c, i) => { c[i.severity] = (c[i.severity] || 0) + 1; return c; }, {});
  return { ok: !counts.error, counts, issues: issues.slice(0, 60), truncated: Math.max(0, issues.length - 60) };
}

module.exports = { lintScore };
