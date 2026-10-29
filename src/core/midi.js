'use strict';
// Lector mínimo de archivos MIDI estándar (formato 0/1): notas, tempo y compás.

function parseMidi(buf) {
  if (buf.toString('latin1', 0, 4) !== 'MThd') throw new Error('No es un archivo MIDI (falta MThd)');
  const ntrk = buf.readUInt16BE(10);
  const division = buf.readUInt16BE(12);
  if (division & 0x8000) throw new Error('MIDI con división SMPTE no soportado');
  const ppq = division;
  const notes = [];
  const tempos = [];
  let timeSig = null;
  let pos = 8 + buf.readUInt32BE(4);

  const vlq = (b, i) => { let v = 0; let c; do { c = b[i++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80); return [v, i]; };

  for (let t = 0; t < ntrk && pos < buf.length; t++) {
    if (buf.toString('latin1', pos, pos + 4) !== 'MTrk') throw new Error('Pista MIDI corrupta');
    const len = buf.readUInt32BE(pos + 4);
    const b = buf.subarray(pos + 8, pos + 8 + len);
    pos += 8 + len;
    let i = 0, tick = 0, running = 0;
    const open = new Map(); // `${canal}:${nota}` -> {start, vel}
    while (i < b.length) {
      let dt; [dt, i] = vlq(b, i); tick += dt;
      let s = b[i];
      if (s === 0xff) {
        const type = b[i + 1]; let l; [l, i] = vlq(b, i + 2);
        if (type === 0x51 && l === 3) tempos.push({ tick, bpm: 6e7 / b.readUIntBE(i, 3) });
        if (type === 0x58 && l >= 2 && !timeSig) timeSig = [b[i], 2 ** b[i + 1]];
        i += l;
      } else if (s === 0xf0 || s === 0xf7) { let l; [l, i] = vlq(b, i + 1); i += l; }
      else {
        if (s & 0x80) { running = s; i++; } else s = running;
        const kind = running >> 4, ch = running & 0x0f;
        if (kind === 0xc || kind === 0xd) { i += 1; continue; }
        const d1 = b[i], d2 = b[i + 1]; i += 2;
        const k = `${ch}:${d1}`;
        if (kind === 0x9 && d2 > 0) { if (ch !== 9) open.set(k, { start: tick, vel: d2 }); }
        else if (kind === 0x8 || (kind === 0x9 && d2 === 0)) {
          const o = open.get(k);
          if (o) { notes.push({ start: o.start, end: Math.max(tick, o.start + 1), midi: d1, vel: o.vel, track: t }); open.delete(k); }
        }
      }
    }
  }
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  return { ppq, tempos, timeSig, notes };
}

module.exports = { parseMidi };
