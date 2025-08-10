import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

let logFilePath: string | null = null;
let maxSizeBytes = 5 * 1024 * 1024; // 5 MB
let maxBackups = 3;

export function initLogger(baseDir: string, filename = 'recallos.log', maxSizeMB = 5, backups = 3) {
  logFilePath = join(baseDir, 'logs', filename);
  maxSizeBytes = Math.max(1, Math.floor(maxSizeMB)) * 1024 * 1024;
  maxBackups = Math.max(1, Math.floor(backups));
}

async function ensureDir(p: string) {
  try { await fsp.mkdir(p, { recursive: true }); } catch {}
}

async function rotateIfNeeded() {
  if (!logFilePath) return;
  try {
    const st = await fsp.stat(logFilePath);
    if (st.size < maxSizeBytes) return;
  } catch { return; }
  // Rotate: .2 -> .3, .1 -> .2, base -> .1
  const base = logFilePath;
  const dir = base.substring(0, base.lastIndexOf('/'));
  await ensureDir(dir);
  for (let i = maxBackups - 1; i >= 1; i--) {
    const from = `${base}.${i}`;
    const to = `${base}.${i + 1}`;
    try { await fsp.rename(from, to); } catch {}
  }
  try { await fsp.rename(base, `${base}.1`); } catch {}
}

async function write(level: 'INFO' | 'WARN' | 'ERROR', msg: string) {
  if (!logFilePath) return;
  const dir = logFilePath.substring(0, logFilePath.lastIndexOf('/'));
  await ensureDir(dir);
  const ts = new Date().toISOString();
  const line = `${ts} ${level} ${msg}\n`;
  try { await fsp.appendFile(logFilePath, line, 'utf8'); } catch {}
  try { await rotateIfNeeded(); } catch {}
}

export function logInfo(msg: string) { write('INFO', msg); }
export function logWarn(msg: string) { write('WARN', msg); }
export function logError(msg: string) { write('ERROR', msg); }
