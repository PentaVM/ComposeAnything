'use strict';
// Registra el servidor MCP de ComposeAnything en Claude Desktop (claude_desktop_config.json).
// Solo se ejecuta cuando el usuario pulsa el botón. Mezcla con la configuración existente, hace una copia
// de seguridad la primera vez y se niega a tocar un archivo que no sea JSON válido.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = 'claude_desktop_config.json';

/** Carpetas donde Claude Desktop puede guardar su configuración, la más probable primero. */
function configDirCandidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const out = [];
    // Versión de la Microsoft Store (MSIX): %APPDATA% está virtualizado dentro del paquete.
    try {
      for (const d of fs.readdirSync(path.join(local, 'Packages'))) {
        if (/^Claude_/i.test(d)) out.push(path.join(local, 'Packages', d, 'LocalCache', 'Roaming', 'Claude'));
      }
    } catch { /* sin paquetes Store */ }
    out.push(path.join(roaming, 'Claude'));
    return out;
  }
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Claude')];
  return [path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude')];
}

/** Ruta del archivo de configuración de la instalación de Claude Desktop que exista, o null. */
function findConfigPath() {
  const dir = configDirCandidates().find((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  return dir ? path.join(dir, CONFIG_FILE) : null;
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) return { cfg: {}, existed: false };
  const txt = fs.readFileSync(configPath, 'utf8');
  if (!txt.trim()) return { cfg: {}, existed: true };
  let cfg;
  try { cfg = JSON.parse(txt); } catch { throw new Error(`${CONFIG_FILE} no es JSON válido: no lo toco. Corrígelo o añade el servidor a mano.`); }
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) throw new Error(`${CONFIG_FILE} tiene un formato inesperado: no lo toco.`);
  return { cfg, existed: true };
}

function write(configPath, cfg) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, configPath);
}

function registerMcp({ configPath = findConfigPath(), name = 'composeanything', command, args = [], env } = {}) {
  if (!configPath) throw new Error('No encuentro Claude Desktop en este equipo. Añade el servidor a mano con el comando de abajo.');
  if (!command) throw new Error('falta command');
  const { cfg, existed } = readConfig(configPath);
  let backup = null;
  if (existed) {
    backup = `${configPath}.bak-composeanything`;
    if (!fs.existsSync(backup)) fs.copyFileSync(configPath, backup);
  }
  cfg.mcpServers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  const replaced = name in cfg.mcpServers;
  cfg.mcpServers[name] = { command, args, ...(env ? { env } : {}) };
  write(configPath, cfg);
  return { path: configPath, created: !existed, replaced, backup, note: 'Reinicia Claude Desktop (ciérralo del todo, también de la bandeja) para que lo cargue.' };
}

function unregisterMcp({ configPath = findConfigPath(), name = 'composeanything' } = {}) {
  if (!configPath || !fs.existsSync(configPath)) return { removed: false };
  const { cfg } = readConfig(configPath);
  if (!cfg.mcpServers || !(name in cfg.mcpServers)) return { removed: false };
  delete cfg.mcpServers[name];
  write(configPath, cfg);
  return { removed: true, path: configPath };
}

function isRegistered({ configPath = findConfigPath(), name = 'composeanything' } = {}) {
  if (!configPath) return { found: false, registered: false, path: null };
  try { const { cfg } = readConfig(configPath); return { found: true, registered: !!cfg.mcpServers?.[name], path: configPath }; }
  catch (e) { return { found: true, registered: false, path: configPath, error: e.message }; }
}

module.exports = { configDirCandidates, findConfigPath, registerMcp, unregisterMcp, isRegistered };
