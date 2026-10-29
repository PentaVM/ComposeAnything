'use strict';
// "Pegar" la app a MuseScore: MuseScore pasa a ocupar la parte izquierda del monitor y la app la derecha.
// En Windows se mueve la ventana de MuseScore con Win32 (MoveWindow); en otros sistemas solo se coloca la app.

const path = require('path');
const { execFile } = require('child_process');
const { screen } = require('electron');

function dockWithMuseScore(win, { ratio = 0.3, processName = 'MuseScore' } = {}) {
  const display = screen.getDisplayMatching(win.getBounds());
  const wa = display.workArea; // en DIP
  const appW = Math.max(360, Math.round(wa.width * ratio));
  const appRect = { x: wa.x + wa.width - appW, y: wa.y, width: appW, height: wa.height };
  const msRect = { x: wa.x, y: wa.y, width: wa.width - appW, height: wa.height };
  win.setBounds(appRect);

  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: true, moved: false, note: 'En este sistema solo se coloca la app a la derecha; mueve MuseScore a mano.' });
  }
  const px = screen.dipToScreenRect(win, msRect); // el MoveWindow de Win32 usa píxeles físicos
  const script = path.join(__dirname, '..', '..', 'scripts', 'dock-windows.ps1');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-X', String(px.x), '-Y', String(px.y), '-Width', String(px.width), '-Height', String(px.height), '-Process', processName],
      { windowsHide: true, timeout: 15000 }, (err, out) => {
        if (err && !String(out).includes('NOT_FOUND')) return resolve({ ok: false, error: err.message });
        if (String(out).includes('NOT_FOUND')) return resolve({ ok: true, moved: false, note: 'No encuentro la ventana de MuseScore: ábrelo y repite. La app ya está a la derecha.' });
        resolve({ ok: true, moved: true });
      });
  });
}

module.exports = { dockWithMuseScore };
