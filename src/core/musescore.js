'use strict';
// Envoltorio de la línea de comandos de MuseScore: convertir (mscz/mscx/mxl/musicxml/mid <-> pdf/png/mp3/mid)
// y abrir archivos. Funciona aunque MuseScore ya esté abierto: la conversión corre en un proceso aparte
// y no toca la partitura que tengas en pantalla.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CANDIDATES = [
  process.env.MUSESCORE_PATH,
  'C:\\Program Files\\MuseScore 4\\bin\\MuseScore4.exe',
  'C:\\Program Files (x86)\\MuseScore 4\\bin\\MuseScore4.exe',
  'C:\\Program Files\\MuseScore 3\\bin\\MuseScore3.exe',
  '/Applications/MuseScore 4.app/Contents/MacOS/mscore',
  '/usr/bin/mscore4portable', '/usr/bin/musescore4', '/usr/bin/musescore', '/usr/bin/mscore',
  path.join(os.homedir(), 'Applications', 'MuseScore-4.AppImage'),
].filter(Boolean);

let cached;
function findMuseScore() {
  if (cached !== undefined) return cached;
  cached = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
  return cached;
}

function run(exe, args, { timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`MuseScore tardó más de ${timeout / 1000}s y se canceló`)); }, timeout);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`MuseScore terminó con código ${code}: ${out.slice(-400)}`)); });
  });
}

/** Convierte un archivo; el formato de salida lo decide la extensión de `out`. */
async function convert(input, out, opts = {}) {
  const exe = findMuseScore();
  if (!exe) throw new Error('No encuentro MuseScore. Define MUSESCORE_PATH con la ruta del ejecutable.');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = [];
  if (opts.dpi) args.push('-r', String(opts.dpi));
  args.push('-o', out, input);
  await run(exe, args, opts);
  // PNG genera out-1.png, out-2.png...: devolvemos lo que realmente existe.
  const base = path.basename(out, path.extname(out));
  const files = fs.readdirSync(path.dirname(out)).filter((f) => f.startsWith(base) && f !== path.basename(input)).map((f) => path.join(path.dirname(out), f));
  return files.length ? files : [out];
}

/** Abre un archivo en MuseScore (si ya está abierto, normalmente lo añade como pestaña nueva). */
function openInMuseScore(file) {
  const exe = findMuseScore();
  if (!exe) throw new Error('No encuentro MuseScore. Define MUSESCORE_PATH.');
  const child = spawn(exe, [file], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return true;
}

module.exports = { findMuseScore, convert, openInMuseScore };
