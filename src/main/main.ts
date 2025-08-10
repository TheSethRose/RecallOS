import { app, BrowserWindow, ipcMain, systemPreferences, shell, session, desktopCapturer, dialog } from 'electron';
import { join } from 'node:path';
import { ensureAllBinaries } from '../bin/manager';
import { ensureWhisperModel, ensureWhisperModelByName } from '../models/manager';
import { ensureTesseractLang } from '../ocr/lang';
import { detectSqlFeatures } from '../db/sqlite';
import { openAppDatabase } from '../db/init';
import { runMigrations } from '../db/migrate';
import { promises as fsp } from 'node:fs';
import { ensureParentDir } from '../util/file';
import { detectFFmpegCaps, listRecentWebmFiles, repairWebmInPlace, extractAudioWav, isAudioLikelySilent } from '../util/ffmpeg';
import { startProcessor, JobQueue } from '../jobs/queue';
import { extractFrames } from '../util/ffmpeg';
import { resolveTesseract, resolveWhisper } from '../bin/manager';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { initLogger, logError } from '../util/log';
const errStr = (e: any) => {
  try {
    if (!e) return 'unknown';
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    if (typeof e.message === 'string') return e.message;
    return JSON.stringify(e);
  } catch { return 'unknown'; }
};
const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  // When built, index.html is copied into dist/renderer
  win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  // Initialize rolling logger under userData
  try { initLogger(app.getPath('userData')); } catch {}
  // First-run checks: binaries, model, tessdata
  try {
    const binResults = await ensureAllBinaries();
    // Minimal logging for now; later wire IPC to renderer for UI progress
    console.log('Binary check results:', binResults);
  } catch (e) {
    console.error('Binary check failed:', e);
  try { logError(`Binary check failed: ${errStr(e)}`); } catch {}
  }
  try {
  const modelRes = await ensureWhisperModel();
  console.log('Model ensure:', modelRes);
  try { (app as any)._recallosModelPath = modelRes; } catch {}
  } catch (e) {
    console.error('Model ensure failed:', e);
  try { logError(`Model ensure failed: ${errStr(e)}`); } catch {}
  }
  try {
    const langRes = await ensureTesseractLang('eng');
    console.log('Tesseract lang ensure:', langRes);
  } catch (e) {
    console.error('Tesseract lang ensure failed:', e);
  try { logError(`Tesseract lang ensure failed: ${errStr(e)}`); } catch {}
  }

  try {
    const features = detectSqlFeatures();
    console.log('SQLite features:', features);
  } catch (e) {
    console.error('SQLite feature detection failed:', e);
  try { logError(`SQLite feature detection failed: ${errStr(e)}`); } catch {}
  }

  // Detect FFmpeg capabilities for diagnostics; best-effort only
  try {
    const caps = await detectFFmpegCaps();
    console.log('FFmpeg:', caps.path || 'not found');
    if (caps.path) {
      console.log('  HW:', caps.hwaccels.join(', ') || '(none)');
    }
  } catch (e) {
    console.warn('FFmpeg capability detection failed:', e);
  try { logError(`FFmpeg capability detection failed: ${errStr(e)}`); } catch {}
  }

  // Open application database (encrypted if SQLCipher is linked and passphrase provided)
  try {
    const baseDir = app.getPath('userData');
  const { db, encrypted, cipherVersion, path } = openAppDatabase(baseDir);
    console.log(`DB opened at ${path}. Encrypted=${encrypted}${cipherVersion ? ` (cipher ${cipherVersion})` : ''}`);
  const { applied } = runMigrations(db);
  if (applied.length) console.log('DB migrations applied:', applied);
    // Keep DB reference on app for longevity; close on exit
    (app as any)._recallosDb = db;
    // Load configured OCR language (default 'eng') and ensure language pack
    try {
      const row = db.prepare?.('SELECT value FROM settings WHERE key = ?').get('ocr_lang');
      const lang = String(row?.value || 'eng').trim() || 'eng';
      (app as any)._recallosOcrLang = lang;
      if (lang && lang !== 'eng') {
        const ensureRes = await ensureTesseractLang(lang);
        console.log('Tesseract lang ensure (configured):', ensureRes);
      }
    } catch (e) {
      console.warn('Failed to ensure configured OCR lang:', e);
      (app as any)._recallosOcrLang = 'eng';
    }
    // Start background job processor (simple inline handler for now)
    const q = new JobQueue(db);
    const stopProcessor = await startProcessor(db, 1, 1000, async (job) => {
      try {
        if (job.type === 'index:chunk') {
          const chunkId = Number(job.payload?.chunk_id);
          const path = String(job.payload?.path || '');
          if (!chunkId || !path) return true;
          // Extract low-frequency frames (e.g., 0.2 fps) to process OCR
          const outDir = join(tmpdir(), `recallos-frames-${chunkId}-${Date.now()}`);
          const ex = await extractFrames(path, outDir, 0.2);
          if (!ex.ok) return true; // skip OCR if extraction failed
          // List frames and enqueue ocr:frame jobs
          const frames = (await require('node:fs').promises.readdir(outDir)).filter((n: string) => n.endsWith('.png'));
          let ts = 0;
          for (const f of frames) {
            q.enqueue('ocr:frame', { chunk_id: chunkId, frame_path: join(outDir, f), ts_ms: ts });
            ts += 5000; // rough spacing; refine later using exact timings if needed
          }
          // Also enqueue STT job for this chunk
          try { q.enqueue('stt:chunk', { chunk_id: chunkId, path, started_at_ms: job.payload?.started_at_ms, duration_ms: job.payload?.duration_ms }); } catch {}
          return true;
        }
    if (job.type === 'ocr:frame') {
          const chunkId = Number(job.payload?.chunk_id);
          const framePath = String(job.payload?.frame_path || '');
          const tsMs = Number(job.payload?.ts_ms || 0);
          const tess = resolveTesseract();
          if (!tess || !framePath) return true; // continue gracefully
          const lang = (app as any)._recallosOcrLang || 'eng';
          // Generate TSV and parse word-level boxes
          const base = join(tmpdir(), `recallos-ocr-${chunkId}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
          try {
            await execFileAsync(tess, [framePath, base, '-l', lang, 'tsv']);
          } catch (err) {
            // Throw to trigger retry/backoff
      try { logError(`OCR exec failed (chunk=${chunkId}, frame=${framePath}): ${errStr(err)}`); } catch {}
            throw err;
          }
          try {
            const tsvPath = `${base}.tsv`;
            const raw = await fsp.readFile(tsvPath, 'utf8');
            const lines = raw.split(/\r?\n/);
            // Columns: level,page_num,block_num,par_num,line_num,word_num,left,top,width,height,conf,text
            for (let i = 1; i < lines.length; i++) {
              const line = lines[i];
              if (!line) continue;
              const parts = line.split('\t');
              if (parts.length < 12) continue;
              const level = Number(parts[0]);
              if (level !== 5) continue; // words only
              const left = Number(parts[6]);
              const top = Number(parts[7]);
              const width = Number(parts[8]);
              const height = Number(parts[9]);
              const conf = Number(parts[10]);
              const text = (parts[11] || '').trim();
              if (!text) continue;
              if (isNaN(conf) || conf < 0) continue;
              const normText = text.replace(/[\u0000-\u001F\u007F]+/g, ' ').normalize('NFC');
              db.prepare?.('INSERT INTO ocr_blocks(chunk_id, ts_ms, text, bbox_x, bbox_y, bbox_w, bbox_h, confidence) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
                .run(chunkId, tsMs, normText, left, top, width, height, conf);
            }
          } finally {
            try { await fsp.unlink(`${base}.tsv`); } catch {}
          }
          return true;
        }
        if (job.type === 'stt:chunk') {
          const chunkId = Number(job.payload?.chunk_id);
          const path = String(job.payload?.path || '');
          if (!chunkId || !path) return true;
          // Extract WAV
          const wavPath = join(tmpdir(), `recallos-stt-${chunkId}-${Date.now()}.wav`);
          const ex = await extractAudioWav(path, wavPath, 16000);
          if (!ex.ok) return true;
          try {
            const st = await fsp.stat(wavPath);
            // Skip if very small (e.g., <10KB) suggesting silence/empty
            if (!st || st.size < 10 * 1024) { try { await fsp.unlink(wavPath); } catch {}; return true; }
          } catch {}
          try {
            const silent = await isAudioLikelySilent(wavPath);
            if (silent) { try { await fsp.unlink(wavPath); } catch {}; return true; }
          } catch {}
          const whisper = resolveWhisper();
          if (!whisper) return true;
          // Run whisper.cpp to SRT with timestamps; prefer base.en model ensured earlier
          const modelRow = (app as any)._recallosModelPath || null;
          const modelPath = modelRow?.path || join(process.cwd(), 'models', 'ggml-base.en.bin');
          const baseOut = join(tmpdir(), `recallos-stt-${chunkId}-${Date.now()}`);
          const srtPath = `${baseOut}.srt`;
          try {
            await execFileAsync(whisper, ['-m', modelPath, '-f', wavPath, '-osrt', '-of', baseOut, '-pp'], { maxBuffer: 10 * 1024 * 1024 });
          } catch (e) {
            // If SRT failed, fall back to txt without timing
            try { logError(`Whisper SRT generation failed (chunk=${chunkId}): ${errStr(e)}`); } catch {}
          }
          try { await fsp.unlink(wavPath); } catch {}
          const db = (app as any)._recallosDb;
          const speaker = (job.payload?.speaker || job.payload?.audio_role || 'unknown');
          let hadAny = false;
          // Prefer SRT with timestamps
          try {
            const srt = await fsp.readFile(srtPath, 'utf8');
            const segs: Array<{ start: number; end: number; text: string }> = [];
            const blocks = srt.split(/\r?\n\r?\n/).map(b => b.trim()).filter(Boolean);
            for (const b of blocks) {
              const lines = b.split(/\r?\n/);
              if (lines.length < 2) continue;
              // lines[0] may be index; lines[1] is timing
              const timingLine = lines[1].includes('-->') ? lines[1] : (lines[0].includes('-->') ? lines[0] : '');
              if (!timingLine) continue;
              const m = timingLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
              if (!m) continue;
              const toMs = (hh: string, mm: string, ss: string, ms: string) => ((+hh)*3600 + (+mm)*60 + (+ss))*1000 + (+ms);
              const start = toMs(m[1],m[2],m[3],m[4]);
              const end = toMs(m[5],m[6],m[7],m[8]);
              const text = lines.slice(timingLine === lines[1] ? 2 : 1).join('\n').trim();
              if (!text) continue;
              segs.push({ start, end, text });
            }
            if (segs.length) {
              for (const s of segs) {
                db.prepare?.('INSERT INTO transcripts(chunk_id, ts_ms, speaker, text, confidence) VALUES(?, ?, ?, ?, ?)')
                  .run(chunkId, s.start, speaker, s.text, null);
              }
              hadAny = true;
            }
          } catch (e) { try { logError(`Read/parse SRT failed (chunk=${chunkId}): ${errStr(e)}`); } catch {} }
          // Fallback: if no SRT, attempt TXT lines without timestamps
          if (!hadAny) {
            try {
              const txt = await fsp.readFile(`${baseOut}.txt`, 'utf8');
              const lines = txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
              let tsMs = 0;
              const approxStep = Math.floor(Number(job.payload?.duration_ms || 0) / Math.max(1, lines.length));
              for (const ln of lines) {
                db.prepare?.('INSERT INTO transcripts(chunk_id, ts_ms, speaker, text, confidence) VALUES(?, ?, ?, ?, ?)')
                  .run(chunkId, tsMs, speaker, ln, null);
                tsMs += approxStep;
              }
            } catch (e) { try { logError(`Read TXT failed (chunk=${chunkId}): ${errStr(e)}`); } catch {} }
          }
          // Cleanup
          try { await fsp.unlink(srtPath); } catch {}
          try { await fsp.unlink(`${baseOut}.txt`); } catch {}
          return true;
        }
        return true;
      } catch {
        return false;
      }
    });
    (app as any)._recallosStopProcessor = stopProcessor;
  } catch (e) {
    console.error('Failed to open app database:', e);
  }

  // Attempt auto-repair for recent .webm chunks (in case of prior crash)
  try {
    const chunksRoot = join(app.getPath('userData'), 'chunks');
    const since = Date.now() - 60 * 60 * 1000; // last hour
    const files = await listRecentWebmFiles(chunksRoot, since);
    for (const f of files) {
      const res = await repairWebmInPlace(f);
      if (!res.ok && res.error && res.error !== 'ffmpeg-missing') {
        console.warn('Chunk repair failed:', f, res.error);
        try {
          // Quarantine the file to avoid repeated repair attempts
          const qDir = join(chunksRoot, '_corrupt');
          await fsp.mkdir(qDir, { recursive: true });
          const target = join(qDir, `${Date.now()}-${Math.random().toString(36).slice(2,8)}-${f.split('/').pop()}`);
          await fsp.rename(f, target);
          console.warn('Quarantined corrupt chunk:', target);
        } catch (e) {
          console.warn('Failed to quarantine corrupt chunk:', f, e);
        }
      }
    }
  } catch (e) {
    console.warn('Chunk auto-repair scan failed:', e);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // IPC wiring — simple, validated
  // Enable getDisplayMedia in renderer by handling display media requests
  try {
    const sess = session.defaultSession;
    if (sess && (sess as any).setDisplayMediaRequestHandler) {
      (sess as any).setDisplayMediaRequestHandler(
        (request: any, callback: Function) => {
          // Grant the first available screen; expand later with a proper picker
          desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
            if (sources && sources.length > 0) {
              callback({ video: sources[0], audio: 'none' });
            } else {
              callback({});
            }
          }).catch(() => callback({}));
        },
        { useSystemPicker: true }
      );
    }
  } catch (e) {
    console.warn('setDisplayMediaRequestHandler not available:', e);
  }

  // IPC wiring — simple, validated
  ipcMain.handle('recallos:ocr:ensureLang', async (_evt, payload: any) => {
    try {
      const lang = String(payload?.lang || '').trim();
      if (!lang) throw new Error('invalid-lang');
      const res = await ensureTesseractLang(lang);
      const db = (app as any)._recallosDb;
      db.prepare?.('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('ocr_lang', lang);
      (app as any)._recallosOcrLang = lang;
      return { ok: true, res };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  // STT model selection & ensure
  ipcMain.handle('recallos:stt:setModel', async (_evt, payload: any) => {
    try {
      const name = String(payload?.name || '').trim();
      if (!name) throw new Error('invalid');
      const res = await ensureWhisperModelByName(name);
      if (res.status === 'error' || !res.path) throw new Error(res.error || 'ensure-failed');
      const db = (app as any)._recallosDb;
      db.prepare?.('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('stt_model', name);
      (app as any)._recallosModelPath = { name, path: res.path };
      return { ok: true, path: res.path };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle('recallos:perm:mic:status', async () => {
    try {
      if (process.platform !== 'darwin') return { platform: process.platform, status: 'granted' };
      const status = systemPreferences.getMediaAccessStatus('microphone');
      return { platform: 'darwin', status };
    } catch (e: any) {
      return { error: e?.message || String(e) };
    }
  });

  ipcMain.handle('recallos:perm:mic:request', async () => {
    try {
      if (process.platform !== 'darwin') return { platform: process.platform, granted: true };
      const granted = await systemPreferences.askForMediaAccess('microphone');
      return { platform: 'darwin', granted };
    } catch (e: any) {
      return { error: e?.message || String(e) };
    }
  });

  ipcMain.handle('recallos:perm:screen:openSettings', async () => {
    if (process.platform !== 'darwin') return { ok: false, error: 'not-macos' };
    try {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  // Expose SQLite/SQLCipher feature detection to renderer
  ipcMain.handle('recallos:sql:features', async () => {
    try {
      const feats = detectSqlFeatures();
      return { ok: true, ...feats };
    } catch (e: any) {
      try { logError(`SQL features IPC failed: ${errStr(e)}`); } catch {}
      return { ok: false, error: e?.message || String(e) };
    }
  });
  // Simple directory chooser for first-run setup
  ipcMain.handle('recallos:dialog:chooseDir', async () => {
    try {
      const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
      return { ok: true, path: res.filePaths[0] };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle('recallos:enqueueJob', async (_evt, payload: any) => {
    const db = (app as any)._recallosDb;
    try {
      if (!payload || typeof payload.type !== 'string') throw new Error('Invalid payload');
      const type = String(payload.type);
      const data = payload.payload ?? {};
      const delay = Number(payload.delaySec || 0);
      db.prepare?.(
        'INSERT INTO jobs(type, payload_json, status, attempts, created_at, updated_at, next_run_at) VALUES(?, ?, ?, ?, strftime("%s","now"), NULL, ?)' 
      ).run(type, JSON.stringify(data), delay > 0 ? 'delayed' : 'queued', 0, Math.floor(Date.now()/1000) + Math.max(0, delay));
      const id = db.prepare?.('SELECT last_insert_rowid() AS id').get()?.id ?? null;
      return { ok: true, id };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('recallos:queueStats', async () => {
    const db = (app as any)._recallosDb;
    try {
      const rows = db.prepare?.(`
        SELECT status, COUNT(*) as n FROM jobs GROUP BY status
      `).all() || [];
      const stats: Record<string, number> = {};
      for (const r of rows) stats[r.status] = r.n;
      return stats;
    } catch {
      return {};
    }
  });
  ipcMain.handle('recallos:getSettings', async () => {
    const db = (app as any)._recallosDb;
    try {
      const rows = db.prepare?.('SELECT key, value FROM settings').all() || [];
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    } catch {
      return {};
    }
  });

  ipcMain.handle('recallos:setSetting', async (_evt, payload: any) => {
    if (!payload || typeof payload.key !== 'string' || typeof payload.value !== 'string') {
      throw new Error('Invalid payload');
    }
    const db = (app as any)._recallosDb;
    try {
      db.prepare?.('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(payload.key, payload.value);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Saved searches: stored as JSON under key 'saved_searches'
  ipcMain.handle('recallos:saved:get', async () => {
    const db = (app as any)._recallosDb;
    try {
      const row = db.prepare?.('SELECT value FROM settings WHERE key = ?').get('saved_searches');
      const obj = row?.value ? JSON.parse(row.value) : {};
      return { ok: true, searches: obj };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('recallos:saved:put', async (_evt, payload: any) => {
    const db = (app as any)._recallosDb;
    try {
      const name = String(payload?.name || '').trim();
      const query = String(payload?.query || '').trim();
      if (!name || !query) throw new Error('invalid');
      const row = db.prepare?.('SELECT value FROM settings WHERE key = ?').get('saved_searches');
      const obj = row?.value ? JSON.parse(row.value) : {};
      obj[name] = query;
      db.prepare?.('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('saved_searches', JSON.stringify(obj));
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('recallos:saved:del', async (_evt, payload: any) => {
    const db = (app as any)._recallosDb;
    try {
      const name = String(payload?.name || '').trim();
      if (!name) throw new Error('invalid');
      const row = db.prepare?.('SELECT value FROM settings WHERE key = ?').get('saved_searches');
      const obj = row?.value ? JSON.parse(row.value) : {};
      delete obj[name];
      db.prepare?.('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('saved_searches', JSON.stringify(obj));
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('recallos:search', async (_evt, payload: any) => {
    const q = typeof payload?.q === 'string' ? payload.q.trim() : '';
    const limit = Math.max(1, Math.min(100, Number(payload?.limit || 20)));
    const offset = Math.max(0, Number(payload?.offset || 0));
    const speaker = typeof payload?.speaker === 'string' && payload.speaker ? payload.speaker : null; // 'me' | 'others'
    const typeFilter = typeof payload?.type === 'string' && payload.type ? payload.type : null; // 'ocr' | 'transcript'
    const from = Number(payload?.from || 0) || null; // epoch seconds
    const to = Number(payload?.to || 0) || null; // epoch seconds
  const appBundle = typeof payload?.app === 'string' && payload.app ? payload.app : null; // apps.bundle_or_exe
  const windowLike = typeof payload?.window === 'string' && payload.window ? payload.window : null; // substring/LIKE
    if (!q) return [];
    const db = (app as any)._recallosDb;
    // Simple query parser for LIKE fallback: supports phrases in quotes, AND/OR, and prefix* terms
    const parseQuery = (input: string) => {
      const tokens: Array<string | 'AND' | 'OR'> = [];
      let i = 0;
      while (i < input.length) {
        if (input[i] === ' ') { i++; continue; }
        if (input[i] === '"') {
          let j = i + 1; let buf = '';
          while (j < input.length && input[j] !== '"') { buf += input[j]; j++; }
          tokens.push(buf.trim());
          i = (j < input.length) ? j + 1 : j;
        } else {
          let j = i; let buf = '';
          while (j < input.length && input[j] !== ' ') { buf += input[j]; j++; }
          const up = buf.toUpperCase();
          if (up === 'AND' || up === 'OR') tokens.push(up as 'AND' | 'OR');
          else tokens.push(buf.trim());
          i = j;
        }
      }
      // Build disjunctive normal form: groups separated by OR, tokens within group are ANDed
      const groups: string[][] = [[]];
      let curr = groups[0];
      for (const t of tokens) {
        if (t === 'OR') { curr = []; groups.push(curr); }
        else if (t === 'AND') { continue; }
        else if (typeof t === 'string' && t.length) { curr.push(t); }
      }
      // Remove empty groups
      return groups.filter(g => g.length > 0);
    };
    const escapeLike = (s: string) => s.replace(/[\\%_]/g, ch => `\\${ch}`);
    const groups = parseQuery(q);
    const applyDateJoin = (alias = 't') => (from || to || appBundle || windowLike) ? `INNER JOIN media_chunks mc ON mc.id = ${alias}.chunk_id` : '';
    const applyDateWhere = (alias = 'mc') => {
      const parts: string[] = [];
      if (from) parts.push(`${alias}.started_at >= ${Math.floor(from)}`);
      if (to) parts.push(`${alias}.started_at <= ${Math.floor(to)}`);
      return parts.length ? ` AND ${parts.join(' AND ')}` : '';
    };
    // Extract an exact phrase (first quoted string) to boost ranking
    const exactPhrase = (() => {
      const m = q.match(/"([^"]+)"/);
      return m && m[1] ? m[1] : '';
    })();
    const exactPhraseLike = exactPhrase ? `%${escapeLike(exactPhrase)}%` : '';
    const windowBoostLike = (exactPhrase || q) ? `%${escapeLike(exactPhrase || q)}%` : '';
    // Try FTS5 first with optional type/speaker/date filters and ranking
    try {
      if (db.prepare) {
        // Base select with score parts; join media_chunks when needed for time-based scoring
        let sql = `SELECT 
            f.rowid, f.content, f.type, f.chunk_id, f.ts_ms,
            (
              COALESCE(-bm25(f), 0)
              + (CASE WHEN mc.id IS NOT NULL THEN (1.0 / (1.0 + ((strftime('%s','now') - (mc.started_at + (f.ts_ms/1000.0))) / 86400.0))) * 0.7 ELSE 0 END)
              + (CASE WHEN EXISTS (
                    SELECT 1 FROM activity_segments seg2
                    WHERE seg2.started_at <= (mc.started_at + (f.ts_ms/1000.0))
                      AND (seg2.ended_at IS NULL OR seg2.ended_at >= (mc.started_at + (f.ts_ms/1000.0)))
                      AND ${windowLike ? 'seg2.window_title LIKE ? ESCAPE "\\"' : exactPhraseLike ? 'seg2.window_title LIKE ? ESCAPE "\\"' : '0'}
                ) THEN 0.3 ELSE 0 END)
              + (CASE WHEN ${exactPhraseLike ? 'f.content LIKE ? ESCAPE "\\"' : '0'} THEN 0.5 ELSE 0 END)
            ) AS score
          FROM fts_content f LEFT JOIN media_chunks mc ON mc.id = f.chunk_id
          WHERE f.fts_content MATCH ?`;
        const args: any[] = [];
        // Window boost bind (if any) goes first due to placement above
        if (windowLike) args.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
        else if (exactPhraseLike) args.push(exactPhraseLike);
        if (exactPhraseLike) args.push(exactPhraseLike);
        args.push(q);
        if (typeFilter) { sql += ' AND f.type = ?'; args.push(typeFilter); }
        if (speaker) {
          // Rebuild with transcript join to access speaker and hit time for window filter
          const needMc = true; // for scoring
          const hitSecExpr = '(mc.started_at + (t.ts_ms/1000.0))';
          sql = `SELECT 
              f.rowid, f.content, f.type, f.chunk_id, f.ts_ms,
              (
                COALESCE(-bm25(f), 0)
                + (1.0 / (1.0 + ((strftime('%s','now') - ${hitSecExpr}) / 86400.0))) * 0.7
                + (CASE WHEN EXISTS (
                      SELECT 1 FROM activity_segments seg2
                      WHERE seg2.started_at <= ${hitSecExpr}
                        AND (seg2.ended_at IS NULL OR seg2.ended_at >= ${hitSecExpr})
                        AND ${windowLike ? 'seg2.window_title LIKE ? ESCAPE "\\"' : exactPhraseLike ? 'seg2.window_title LIKE ? ESCAPE "\\"' : '0'}
                  ) THEN 0.3 ELSE 0 END)
                + (CASE WHEN ${exactPhraseLike ? 'f.content LIKE ? ESCAPE "\\"' : '0'} THEN 0.5 ELSE 0 END)
              ) AS score
            FROM fts_content f INNER JOIN transcripts t ON t.id = f.rowid AND f.type = 'transcript' ${needMc ? 'INNER JOIN media_chunks mc ON mc.id = f.chunk_id' : ''}
            WHERE f.fts_content MATCH ? AND t.speaker = ?${applyDateWhere()}`;
          args.length = 0;
          if (windowLike) args.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`); else if (exactPhraseLike) args.push(exactPhraseLike);
          if (exactPhraseLike) args.push(exactPhraseLike);
          args.push(q, speaker);
          // App/window filter via EXISTS over activity_segments at hit time
          if (appBundle || windowLike) {
            sql += ` AND EXISTS (SELECT 1 FROM activity_segments seg INNER JOIN apps a ON a.id = seg.app_id WHERE seg.started_at <= ${hitSecExpr} AND (seg.ended_at IS NULL OR seg.ended_at >= ${hitSecExpr})${appBundle ? ' AND a.bundle_or_exe = ?' : ''}${windowLike ? ' AND seg.window_title LIKE ? ESCAPE "\\"' : ''})`;
            if (appBundle) args.push(appBundle);
            if (windowLike) args.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
          }
        } else if (from || to || appBundle || windowLike) {
          const hitSecExpr = '(mc.started_at + (f.ts_ms/1000.0))';
          sql = `SELECT 
              f.rowid, f.content, f.type, f.chunk_id, f.ts_ms,
              (
                COALESCE(-bm25(f), 0)
                + (1.0 / (1.0 + ((strftime('%s','now') - ${hitSecExpr}) / 86400.0))) * 0.7
                + (CASE WHEN EXISTS (
                      SELECT 1 FROM activity_segments seg2
                      WHERE seg2.started_at <= ${hitSecExpr}
                        AND (seg2.ended_at IS NULL OR seg2.ended_at >= ${hitSecExpr})
                        AND ${windowLike ? 'seg2.window_title LIKE ? ESCAPE "\\"' : exactPhraseLike ? 'seg2.window_title LIKE ? ESCAPE "\\"' : '0'}
                  ) THEN 0.3 ELSE 0 END)
                + (CASE WHEN ${exactPhraseLike ? 'f.content LIKE ? ESCAPE "\\"' : '0'} THEN 0.5 ELSE 0 END)
              ) AS score
            FROM fts_content f INNER JOIN media_chunks mc ON mc.id = f.chunk_id
            WHERE f.fts_content MATCH ?${typeFilter ? ' AND f.type = ?' : ''}${applyDateWhere('mc')}`;
          if (appBundle || windowLike) {
            sql += ` AND EXISTS (SELECT 1 FROM activity_segments seg INNER JOIN apps a ON a.id = seg.app_id WHERE seg.started_at <= ${hitSecExpr} AND (seg.ended_at IS NULL OR seg.ended_at >= ${hitSecExpr})${appBundle ? ' AND a.bundle_or_exe = ?' : ''}${windowLike ? ' AND seg.window_title LIKE ? ESCAPE "\\"' : ''})`;
          }
          args.length = 0;
          if (windowLike) args.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`); else if (exactPhraseLike) args.push(exactPhraseLike);
          if (exactPhraseLike) args.push(exactPhraseLike);
          args.push(q); if (typeFilter) args.push(typeFilter); if (appBundle) args.push(appBundle); if (windowLike) args.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
        }
        sql += ' ORDER BY score DESC, f.rowid DESC LIMIT ? OFFSET ?'; args.push(limit, offset);
        const stmt = db.prepare(sql);
        const rows = stmt.all(...args);
        if (rows) return rows;
      }
    } catch {}
    // Fallback: LIKE on OCR and transcripts with filters
    try {
      const buildWhere = (alias: 'o' | 't') => {
        const parts: string[] = [];
        const bind: any[] = [];
        // Build (g1 AND) OR (g2 AND) ...
        const groupSql: string[] = [];
        for (const g of groups) {
          const ands: string[] = [];
          for (const tok of g) {
            const isPrefix = tok.endsWith('*');
            const raw = isPrefix ? tok.slice(0, -1) : tok;
            const esc = escapeLike(raw);
            const pat = isPrefix ? `${esc}%` : `%${esc}%`;
            ands.push(`${alias}.text LIKE ? ESCAPE '\\'`);
            bind.push(pat);
          }
          if (ands.length) groupSql.push(`(${ands.join(' AND ')})`);
        }
        if (groupSql.length) parts.push(`(${groupSql.join(' OR ')})`);
        if (alias === 't' && speaker) { parts.push(`t.speaker = ?`); bind.push(speaker); }
        const where = parts.length ? `WHERE ${parts.join(' AND ')}` : 'WHERE 1=1';
        return { where, bind };
      };
      const argsAll: any[] = [];
      const selects: string[] = [];
      if (!typeFilter || typeFilter === 'ocr') {
        const { where, bind } = buildWhere('o');
        const hitSecExpr = '(mc.started_at + (o.ts_ms/1000.0))';
        let sql = `SELECT 
            o.id as rowid, o.text as content, 'ocr' as type, o.chunk_id, o.ts_ms,
            (
              0
              + (CASE WHEN mc.id IS NOT NULL THEN (1.0 / (1.0 + ((strftime('%s','now') - ${hitSecExpr}) / 86400.0))) * 0.7 ELSE 0 END)
              + (CASE WHEN EXISTS (
                    SELECT 1 FROM activity_segments seg2
                    WHERE seg2.started_at <= ${hitSecExpr}
                      AND (seg2.ended_at IS NULL OR seg2.ended_at >= ${hitSecExpr})
                      AND ${windowLike ? 'seg2.window_title LIKE ? ESCAPE "\\"' : windowBoostLike ? 'seg2.window_title LIKE ? ESCAPE "\\"' : '0'}
                ) THEN 0.3 ELSE 0 END)
              + (CASE WHEN ${exactPhraseLike ? 'o.text LIKE ? ESCAPE "\\"' : '0'} THEN 0.5 ELSE 0 END)
              + (${groups.length ? groups.map(g => `(${g.map(tok => {
                const isPrefix = tok.endsWith('*');
                const raw = isPrefix ? tok.slice(0, -1) : tok;
                const esc = escapeLike(raw);
                const pat = isPrefix ? `${esc}%` : `%${esc}%`;
                argsAll.push(pat);
                return `CASE WHEN o.text LIKE ? ESCAPE '\\' THEN 0.1 ELSE 0 END`;
              }).join(' + ')})`).join(' + ') : '0'})
            ) AS score
          FROM ocr_blocks o ${applyDateJoin('o')} ${where}${applyDateWhere()}`;
        if (appBundle || windowLike) {
          sql += ` AND EXISTS (SELECT 1 FROM activity_segments seg INNER JOIN apps a ON a.id=seg.app_id WHERE seg.started_at <= ${hitSecExpr} AND (seg.ended_at IS NULL OR seg.ended_at >= ${hitSecExpr})${appBundle ? ' AND a.bundle_or_exe = ?' : ''}${windowLike ? ' AND seg.window_title LIKE ? ESCAPE "\\"' : ''})`;
        }
        // Window/phrase boost binds (if any) precede where binds added above
        if (windowLike) argsAll.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`); else if (windowBoostLike) argsAll.push(windowBoostLike);
        if (exactPhraseLike) argsAll.push(exactPhraseLike);
        selects.push(sql); argsAll.push(...bind); if (appBundle) argsAll.push(appBundle); if (windowLike) argsAll.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
      }
      if (!typeFilter || typeFilter === 'transcript') {
        const { where, bind } = buildWhere('t');
        const hitSecExpr = '(mc.started_at + (t.ts_ms/1000.0))';
        let sql = `SELECT 
            t.id as rowid, t.text as content, 'transcript' as type, t.chunk_id, t.ts_ms,
            (
              0
              + (CASE WHEN mc.id IS NOT NULL THEN (1.0 / (1.0 + ((strftime('%s','now') - ${hitSecExpr}) / 86400.0))) * 0.7 ELSE 0 END)
              + (CASE WHEN EXISTS (
                    SELECT 1 FROM activity_segments seg2
                    WHERE seg2.started_at <= ${hitSecExpr}
                      AND (seg2.ended_at IS NULL OR seg2.ended_at >= ${hitSecExpr})
                      AND ${windowLike ? 'seg2.window_title LIKE ? ESCAPE "\\"' : windowBoostLike ? 'seg2.window_title LIKE ? ESCAPE "\\"' : '0'}
                ) THEN 0.3 ELSE 0 END)
              + (CASE WHEN ${exactPhraseLike ? 't.text LIKE ? ESCAPE "\\"' : '0'} THEN 0.5 ELSE 0 END)
              + (${groups.length ? groups.map(g => `(${g.map(tok => {
                const isPrefix = tok.endsWith('*');
                const raw = isPrefix ? tok.slice(0, -1) : tok;
                const esc = escapeLike(raw);
                const pat = isPrefix ? `${esc}%` : `%${esc}%`;
                argsAll.push(pat);
                return `CASE WHEN t.text LIKE ? ESCAPE '\\' THEN 0.1 ELSE 0 END`;
              }).join(' + ')})`).join(' + ') : '0'})
            ) AS score
          FROM transcripts t ${applyDateJoin('t')} ${where}${applyDateWhere()}${speaker ? '' : ''}`;
        if (appBundle || windowLike) {
          sql += ` AND EXISTS (SELECT 1 FROM activity_segments seg INNER JOIN apps a ON a.id=seg.app_id WHERE seg.started_at <= ${hitSecExpr} AND (seg.ended_at IS NULL OR seg.ended_at >= ${hitSecExpr})${appBundle ? ' AND a.bundle_or_exe = ?' : ''}${windowLike ? ' AND seg.window_title LIKE ? ESCAPE "\\"' : ''})`;
        }
        if (windowLike) argsAll.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`); else if (windowBoostLike) argsAll.push(windowBoostLike);
        if (exactPhraseLike) argsAll.push(exactPhraseLike);
        selects.push(sql); argsAll.push(...bind); if (appBundle) argsAll.push(appBundle); if (windowLike) argsAll.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
      }
      const finalSql = `${selects.join(' UNION ALL ')} ORDER BY score DESC, ts_ms DESC LIMIT ? OFFSET ?`;
      argsAll.push(limit, offset);
      const rows = db.prepare?.(finalSql).all(...argsAll) || [];
      return rows;
    } catch {
      return [];
    }
  });

  ipcMain.handle('recallos:searchSnippets', async (_evt, payload: any) => {
    const q = typeof payload?.q === 'string' ? payload.q.trim() : '';
    const limit = Math.max(1, Math.min(100, Number(payload?.limit || 20)));
    const offset = Math.max(0, Number(payload?.offset || 0));
  const windowChars = Math.max(30, Math.min(200, Number(payload?.windowChars || 80)));
  const windowSecs = Math.max(0, Math.min(60, Number(payload?.windowSecs ?? 0)));
    const speaker = typeof payload?.speaker === 'string' && payload.speaker ? payload.speaker : null;
    const typeFilter = typeof payload?.type === 'string' && payload.type ? payload.type : null;
    const from = Number(payload?.from || 0) || null;
    const to = Number(payload?.to || 0) || null;
    const appBundle = typeof payload?.app === 'string' && payload.app ? payload.app : null;
    const windowLike = typeof payload?.window === 'string' && payload.window ? payload.window : null;
    if (!q) return [];
    const db = (app as any)._recallosDb;
    // Helper to build a time-window snippet around a hit using nearby rows in same chunk
    const buildTimeSnippet = (row: any): string | null => {
      try {
        if (!windowSecs || !db?.prepare) return null;
        const start = Math.max(0, Number(row.ts_ms) - windowSecs * 1000);
        const end = Number(row.ts_ms) + windowSecs * 1000;
        const table = row.type === 'transcript' ? 'transcripts' : 'ocr_blocks';
        const stmt = db.prepare?.(`SELECT text FROM ${table} WHERE chunk_id = ? AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms`);
        const rowsCtx = stmt?.all(row.chunk_id, start, end) || [];
        if (!rowsCtx.length) return null;
        const glue = ' … ';
        const combined = rowsCtx.map((r: any) => String(r.text || '')).join(glue);
        const lower = combined.toLowerCase();
        const qLower = q.toLowerCase();
        const idx = lower.indexOf(qLower);
        if (idx >= 0) {
          const pre = combined.slice(0, idx);
          const mid = combined.slice(idx, idx + q.length);
          const post = combined.slice(idx + q.length);
          return `${pre}[${mid}]${post}`;
        }
        return combined.length > windowChars * 2 ? combined.slice(0, windowChars * 2) + ' …' : combined;
      } catch { return null; }
    };
    // Try FTS5 snippet first with filters and ranking identical to search()
    try {
      if (db.prepare) {
        let sql = `SELECT 
            snippet(f, 0, "[", "]", " … ", 10) as snippet,
            f.type, f.chunk_id, f.ts_ms,
            (
              COALESCE(-bm25(f), 0)
              + (CASE WHEN mc.id IS NOT NULL THEN (1.0 / (1.0 + ((strftime('%s','now') - (mc.started_at + (f.ts_ms/1000.0))) / 86400.0))) * 0.7 ELSE 0 END)
              + (CASE WHEN EXISTS (
                    SELECT 1 FROM activity_segments seg2
                    WHERE seg2.started_at <= (mc.started_at + (f.ts_ms/1000.0))
                      AND (seg2.ended_at IS NULL OR seg2.ended_at >= (mc.started_at + (f.ts_ms/1000.0)))
                      AND ${windowLike ? 'seg2.window_title LIKE ? ESCAPE "\\"' : (q ? `seg2.window_title LIKE ? ESCAPE "\\"` : '0')}
                ) THEN 0.3 ELSE 0 END)
            ) AS score,
            (SELECT a.bundle_or_exe FROM media_chunks mc2
               JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (f.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (f.ts_ms/1000.0)))
               JOIN apps a ON a.id = seg.app_id
             WHERE mc2.id = f.chunk_id ORDER BY seg.id DESC LIMIT 1) AS app_bundle,
            (SELECT COALESCE(a.display_name, a.bundle_or_exe) FROM media_chunks mc2
               JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (f.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (f.ts_ms/1000.0)))
               JOIN apps a ON a.id = seg.app_id
             WHERE mc2.id = f.chunk_id ORDER BY seg.id DESC LIMIT 1) AS app_name,
            (SELECT seg.window_title FROM media_chunks mc2
               JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (f.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (f.ts_ms/1000.0)))
             WHERE mc2.id = f.chunk_id ORDER BY seg.id DESC LIMIT 1) AS window_title
          FROM fts_content f LEFT JOIN media_chunks mc ON mc.id = f.chunk_id WHERE f.fts_content MATCH ?`;
        const args: any[] = [];
        if (windowLike) args.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`); else if (q) args.push(`%${String(q).replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
        args.push(q);
        if (typeFilter) { sql += ' AND f.type = ?'; args.push(typeFilter); }
        if (speaker) {
          const needMc = (from || to || appBundle || windowLike);
          const hitSecExpr = '(mc.started_at + (f.ts_ms/1000.0))';
          sql = `SELECT 
              snippet(f, 0, "[", "]", " … ", 10) as snippet, f.type, f.chunk_id, f.ts_ms,
              (
                COALESCE(-bm25(f), 0)
                + (CASE WHEN mc.id IS NOT NULL THEN (1.0 / (1.0 + ((strftime('%s','now') - ${hitSecExpr}) / 86400.0))) * 0.7 ELSE 0 END)
                + (CASE WHEN EXISTS (
                      SELECT 1 FROM activity_segments seg2
                      WHERE seg2.started_at <= ${hitSecExpr}
                        AND (seg2.ended_at IS NULL OR seg2.ended_at >= ${hitSecExpr})
                        AND ${windowLike ? 'seg2.window_title LIKE ? ESCAPE "\\"' : (q ? `seg2.window_title LIKE ? ESCAPE "\\"` : '0')}
                  ) THEN 0.3 ELSE 0 END)
              ) AS score,
              (SELECT a.bundle_or_exe FROM media_chunks mc2 JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (f.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (f.ts_ms/1000.0))) JOIN apps a ON a.id = seg.app_id WHERE mc2.id = f.chunk_id ORDER BY seg.id DESC LIMIT 1) AS app_bundle,
              (SELECT COALESCE(a.display_name, a.bundle_or_exe) FROM media_chunks mc2 JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (f.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (f.ts_ms/1000.0))) JOIN apps a ON a.id = seg.app_id WHERE mc2.id = f.chunk_id ORDER BY seg.id DESC LIMIT 1) AS app_name,
              (SELECT seg.window_title FROM media_chunks mc2 JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (f.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (f.ts_ms/1000.0))) WHERE mc2.id = f.chunk_id ORDER BY seg.id DESC LIMIT 1) AS window_title
            FROM fts_content f ${needMc ? 'INNER JOIN media_chunks mc ON mc.id = f.chunk_id' : ''} INNER JOIN transcripts t ON t.id = f.rowid AND f.type = 'transcript' WHERE f.fts_content MATCH ? AND t.speaker = ?${from || to ? `${from ? ` AND mc.started_at >= ${Math.floor(from)}` : ''}${to ? ` AND mc.started_at <= ${Math.floor(to)}` : ''}` : ''}${appBundle || windowLike ? `${appBundle ? ' AND EXISTS (SELECT 1 FROM activity_segments seg INNER JOIN apps a ON a.id=seg.app_id WHERE a.bundle_or_exe = ? AND seg.started_at <= ' + hitSecExpr + ' AND (seg.ended_at IS NULL OR seg.ended_at >= ' + hitSecExpr + '))' : ''}${windowLike ? ' AND EXISTS (SELECT 1 FROM activity_segments seg2 WHERE seg2.started_at <= ' + hitSecExpr + ' AND (seg2.ended_at IS NULL OR seg2.ended_at >= ' + hitSecExpr + ') AND seg2.window_title LIKE ? ESCAPE "\\")' : ''}` : ''}`;
          args.length = 0; if (windowLike) args.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`); else if (q) args.push(`%${String(q).replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
          args.push(q, speaker); if (appBundle) args.push(appBundle); if (windowLike) args.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
        } else if (from || to || appBundle || windowLike) {
          const hitSecExpr = '(mc.started_at + (f.ts_ms/1000.0))';
          sql = `SELECT 
              snippet(f, 0, "[", "]", " … ", 10) as snippet, f.type, f.chunk_id, f.ts_ms,
              (
                COALESCE(-bm25(f), 0)
                + (1.0 / (1.0 + ((strftime('%s','now') - ${hitSecExpr}) / 86400.0))) * 0.7
                + (CASE WHEN EXISTS (
                      SELECT 1 FROM activity_segments seg2
                      WHERE seg2.started_at <= ${hitSecExpr}
                        AND (seg2.ended_at IS NULL OR seg2.ended_at >= ${hitSecExpr})
                        AND ${windowLike ? 'seg2.window_title LIKE ? ESCAPE "\\"' : (q ? `seg2.window_title LIKE ? ESCAPE "\\"` : '0')}
                  ) THEN 0.3 ELSE 0 END)
              ) AS score,
              (SELECT a.bundle_or_exe FROM media_chunks mc2 JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (f.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (f.ts_ms/1000.0))) JOIN apps a ON a.id = seg.app_id WHERE mc2.id = f.chunk_id ORDER BY seg.id DESC LIMIT 1) AS app_bundle,
              (SELECT COALESCE(a.display_name, a.bundle_or_exe) FROM media_chunks mc2 JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (f.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (f.ts_ms/1000.0))) JOIN apps a ON a.id = seg.app_id WHERE mc2.id = f.chunk_id ORDER BY seg.id DESC LIMIT 1) AS app_name,
              (SELECT seg.window_title FROM media_chunks mc2 JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (f.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (f.ts_ms/1000.0))) WHERE mc2.id = f.chunk_id ORDER BY seg.id DESC LIMIT 1) AS window_title
            FROM fts_content f INNER JOIN media_chunks mc ON mc.id = f.chunk_id WHERE f.fts_content MATCH ?${typeFilter ? ' AND f.type = ?' : ''}${from ? ` AND mc.started_at >= ${Math.floor(from)}` : ''}${to ? ` AND mc.started_at <= ${Math.floor(to)}` : ''}${appBundle || windowLike ? `${appBundle ? ' AND EXISTS (SELECT 1 FROM activity_segments seg INNER JOIN apps a ON a.id=seg.app_id WHERE a.bundle_or_exe = ? AND seg.started_at <= ' + hitSecExpr + ' AND (seg.ended_at IS NULL OR seg.ended_at >= ' + hitSecExpr + '))' : ''}${windowLike ? ' AND EXISTS (SELECT 1 FROM activity_segments seg2 WHERE seg2.started_at <= ' + hitSecExpr + ' AND (seg2.ended_at IS NULL OR seg2.ended_at >= ' + hitSecExpr + ') AND seg2.window_title LIKE ? ESCAPE "\\")' : ''}` : ''}`;
          args.length = 0; if (windowLike) args.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`); else if (q) args.push(`%${String(q).replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
          args.push(q); if (typeFilter) args.push(typeFilter); if (appBundle) args.push(appBundle); if (windowLike) args.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
        }
        sql += ' ORDER BY score DESC, f.rowid DESC LIMIT ? OFFSET ?'; args.push(limit, offset);
        const rows = db.prepare(sql).all(...args);
        if (rows) {
          if (windowSecs > 0) {
            return rows.map((r: any) => ({
              ...r,
              snippet: buildTimeSnippet(r) || r.snippet,
            }));
          }
          return rows;
        }
      }
    } catch {}
    // Fallback: LIKE with manual snippet and filters
    try {
      const escapeLike = (s: string) => s.replace(/[\\%_]/g, ch => `\\${ch}`);
      const pat = `%${escapeLike(q)}%`;
      const applyDateJoin = (alias = 't') => from || to ? `INNER JOIN media_chunks mc ON mc.id = ${alias}.chunk_id` : '';
      const applyDateWhere = (alias = 'mc') => {
        const parts: string[] = [];
        if (from) parts.push(`${alias}.started_at >= ${Math.floor(from)}`);
        if (to) parts.push(`${alias}.started_at <= ${Math.floor(to)}`);
        return parts.length ? ` AND ${parts.join(' AND ')}` : '';
      };
      const selects: string[] = [];
      const argsAll: any[] = [];
      if (!typeFilter || typeFilter === 'ocr') {
        selects.push(`SELECT o.text as content, 'ocr' as type, o.chunk_id, o.ts_ms,
            (SELECT a.bundle_or_exe FROM media_chunks mc2 JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (o.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (o.ts_ms/1000.0))) JOIN apps a ON a.id=seg.app_id WHERE mc2.id = o.chunk_id ORDER BY seg.id DESC LIMIT 1) AS app_bundle,
            (SELECT COALESCE(a.display_name, a.bundle_or_exe) FROM media_chunks mc2 JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (o.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (o.ts_ms/1000.0))) JOIN apps a ON a.id=seg.app_id WHERE mc2.id = o.chunk_id ORDER BY seg.id DESC LIMIT 1) AS app_name,
            (SELECT seg.window_title FROM media_chunks mc2 JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (o.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (o.ts_ms/1000.0))) WHERE mc2.id = o.chunk_id ORDER BY seg.id DESC LIMIT 1) AS window_title
          FROM ocr_blocks o ${applyDateJoin('o')} WHERE o.text LIKE ? ESCAPE '\\'${applyDateWhere()}`);
        argsAll.push(pat);
        if (appBundle || windowLike) {
          const hitSecExpr = '(mc.started_at + (o.ts_ms/1000.0))';
          selects[selects.length-1] += ` AND EXISTS (SELECT 1 FROM activity_segments seg INNER JOIN apps a ON a.id=seg.app_id WHERE seg.started_at <= ${hitSecExpr} AND (seg.ended_at IS NULL OR seg.ended_at >= ${hitSecExpr})${appBundle ? ' AND a.bundle_or_exe = ?' : ''}${windowLike ? ' AND seg.window_title LIKE ? ESCAPE "\\"' : ''})`;
          if (appBundle) argsAll.push(appBundle);
          if (windowLike) argsAll.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
        }
      }
      if (!typeFilter || typeFilter === 'transcript') {
        selects.push(`SELECT t.text as content, 'transcript' as type, t.chunk_id, t.ts_ms,
            (SELECT a.bundle_or_exe FROM media_chunks mc2 JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (t.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (t.ts_ms/1000.0))) JOIN apps a ON a.id=seg.app_id WHERE mc2.id = t.chunk_id ORDER BY seg.id DESC LIMIT 1) AS app_bundle,
            (SELECT COALESCE(a.display_name, a.bundle_or_exe) FROM media_chunks mc2 JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (t.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (t.ts_ms/1000.0))) JOIN apps a ON a.id=seg.app_id WHERE mc2.id = t.chunk_id ORDER BY seg.id DESC LIMIT 1) AS app_name,
            (SELECT seg.window_title FROM media_chunks mc2 JOIN activity_segments seg ON seg.started_at <= (mc2.started_at + (t.ts_ms/1000.0)) AND (seg.ended_at IS NULL OR seg.ended_at >= (mc2.started_at + (t.ts_ms/1000.0))) WHERE mc2.id = t.chunk_id ORDER BY seg.id DESC LIMIT 1) AS window_title
          FROM transcripts t ${applyDateJoin('t')} WHERE t.text LIKE ? ESCAPE '\\'${applyDateWhere()}${speaker ? ' AND t.speaker = ?' : ''}`);
        argsAll.push(pat); if (speaker) argsAll.push(speaker);
        if (appBundle || windowLike) {
          const hitSecExpr = '(mc.started_at + (t.ts_ms/1000.0))';
          selects[selects.length-1] += ` AND EXISTS (SELECT 1 FROM activity_segments seg INNER JOIN apps a ON a.id=seg.app_id WHERE seg.started_at <= ${hitSecExpr} AND (seg.ended_at IS NULL OR seg.ended_at >= ${hitSecExpr})${appBundle ? ' AND a.bundle_or_exe = ?' : ''}${windowLike ? ' AND seg.window_title LIKE ? ESCAPE "\\"' : ''})`;
          if (appBundle) argsAll.push(appBundle);
          if (windowLike) argsAll.push(`%${String(windowLike).replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
        }
      }
      const rows = db.prepare?.(`${selects.join(' UNION ALL ')} ORDER BY ts_ms ASC LIMIT ? OFFSET ?`).all(...argsAll, limit, offset) || [];
      if (windowSecs > 0) {
        return rows.map((r: any) => ({
          snippet: buildTimeSnippet(r) || ((): string => {
            const content = String(r.content || '');
            const idx = content.toLowerCase().indexOf(q.toLowerCase());
            if (idx < 0) return content.slice(0, windowChars * 2);
            const start = Math.max(0, idx - windowChars);
            const end = Math.min(content.length, idx + q.length + windowChars);
            const pre = content.slice(start, idx);
            const mid = content.slice(idx, idx + q.length);
            const post = content.slice(idx + q.length, end);
            const ellipsisPre = start > 0 ? '… ' : '';
            const ellipsisPost = end < content.length ? ' …' : '';
            return `${ellipsisPre}${pre}[${mid}]${post}${ellipsisPost}`;
          })(),
          type: r.type, chunk_id: r.chunk_id, ts_ms: r.ts_ms,
          app_bundle: r.app_bundle, app_name: r.app_name, window_title: r.window_title,
        }));
      }
      return rows.map((r: any) => {
        const content = String(r.content || '');
        const idx = content.toLowerCase().indexOf(q.toLowerCase());
        if (idx < 0) return { snippet: content.slice(0, windowChars * 2), type: r.type, chunk_id: r.chunk_id, ts_ms: r.ts_ms };
        const start = Math.max(0, idx - windowChars);
        const end = Math.min(content.length, idx + q.length + windowChars);
        const pre = content.slice(start, idx);
        const mid = content.slice(idx, idx + q.length);
        const post = content.slice(idx + q.length, end);
        const ellipsisPre = start > 0 ? '… ' : '';
        const ellipsisPost = end < content.length ? ' …' : '';
        return { snippet: `${ellipsisPre}${pre}[${mid}]${post}${ellipsisPost}`, type: r.type, chunk_id: r.chunk_id, ts_ms: r.ts_ms };
      });
    } catch {
      return [];
    }
  });

  // Jump to moment: given chunk_id and ts_ms, return file path and absolute timestamp (ms)
  ipcMain.handle('recallos:getMoment', async (_evt, payload: any) => {
    try {
      const chunkId = Number(payload?.chunk_id);
      const tsMs = Number(payload?.ts_ms || 0);
      if (!chunkId || chunkId <= 0) throw new Error('Invalid chunk_id');
      const db = (app as any)._recallosDb;
      const row = db.prepare?.('SELECT id, path, started_at FROM media_chunks WHERE id = ?').get(chunkId);
      if (!row) return { ok: false, error: 'not-found' };
      const startedAtMs = (Number(row.started_at) || 0) * 1000;
      const absMs = startedAtMs + tsMs;
      return { ok: true, path: row.path, absMs };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Apps IPC: list, rename, and current app/window
  ipcMain.handle('recallos:apps:list', async () => {
    try {
      const db = (app as any)._recallosDb;
      const rows = db.prepare?.('SELECT id, bundle_or_exe, COALESCE(display_name, bundle_or_exe) AS display_name FROM apps ORDER BY LOWER(COALESCE(display_name, bundle_or_exe)) ASC').all() || [];
      return { ok: true, apps: rows };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle('recallos:apps:rename', async (_evt, payload: any) => {
    try {
      const bundle = String(payload?.bundle || '').trim();
      const name = String(payload?.display_name || '').trim();
      if (!bundle) throw new Error('invalid');
      const db = (app as any)._recallosDb;
      const row = db.prepare?.('SELECT id FROM apps WHERE bundle_or_exe = ?').get(bundle);
      if (row?.id) {
        db.prepare?.('UPDATE apps SET display_name = ? WHERE id = ?').run(name || null, row.id);
      } else {
        db.prepare?.('INSERT INTO apps(bundle_or_exe, display_name) VALUES(?, ?)').run(bundle, name || null);
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle('recallos:app:current', async () => {
    try {
      const db = (app as any)._recallosDb;
      const row = db.prepare?.(`SELECT a.bundle_or_exe, COALESCE(a.display_name, a.bundle_or_exe) AS display_name, seg.window_title
        FROM activity_segments seg INNER JOIN apps a ON a.id = seg.app_id
        ORDER BY seg.id DESC LIMIT 1`).get();
      return { ok: true, current: row || null };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Recording indicator: set a visible OS hint (dock badge on macOS; title suffix elsewhere)
  ipcMain.handle('recallos:recording:set', async (_evt, payload: any) => {
    try {
      const active = !!payload?.active;
      if (process.platform === 'darwin' && app.dock && app.dock.setBadge) {
        app.dock.setBadge(active ? 'REC' : '');
      } else {
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) {
          const base = 'RecallOS';
          win.setTitle(active ? `${base} • REC` : base);
        }
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // macOS: foreground app/window tracking sampler (Phase 8)
  try {
    if (process.platform === 'darwin') {
      const db = (app as any)._recallosDb;
      const sample = async () => {
        try {
          // AppleScript to get frontmost app name and window title
          const script = `osascript -e 'tell application "System Events" to tell (first application process whose frontmost is true) to return name & "\t" & (try
            (name of window 1)
          on error
            ""
          end try)'`;
          const { stdout } = await execAsync(script);
          const out = String(stdout || '').trim();
          if (!out) return;
          const [appName, windowTitleRaw] = out.split('\t');
          const appKey = appName || 'Unknown';
          const windowTitle = (windowTitleRaw || '').slice(0, 512);
          // Upsert app in apps table
          let appId: number | null = null;
          try {
            const row = db.prepare?.('SELECT id FROM apps WHERE bundle_or_exe = ?').get(appKey);
            if (row?.id) {
              appId = row.id;
            } else {
              db.prepare?.('INSERT INTO apps(bundle_or_exe, display_name) VALUES(?, ?)').run(appKey, appName);
              const idRow = db.prepare?.('SELECT last_insert_rowid() AS id').get();
              appId = idRow?.id ?? null;
            }
          } catch {}
          const now = Math.floor(Date.now() / 1000);
          // Merge with last open segment when same app/window
          try {
            const last = db.prepare?.('SELECT id, app_id, window_title, started_at, ended_at FROM activity_segments ORDER BY id DESC LIMIT 1').get();
            if (last && last.app_id === appId && String(last.window_title || '') === String(windowTitle || '')) {
              // Extend existing segment by updating ended_at to null (keep it open) or bump ended_at to now (we keep open-ended)
              if (last.ended_at != null) {
                db.prepare?.('UPDATE activity_segments SET ended_at = NULL WHERE id = ?').run(last.id);
              }
            } else {
              // Close prior open segment
              if (last && last.ended_at == null) {
                db.prepare?.('UPDATE activity_segments SET ended_at = ? WHERE id = ?').run(now, last.id);
              }
              // Start new segment (open-ended)
              db.prepare?.('INSERT INTO activity_segments(app_id, window_title, started_at, ended_at) VALUES(?, ?, ?, NULL)').run(appId, windowTitle, now);
            }
          } catch {}
        } catch {}
      };
      // Initial sample + interval
      setTimeout(sample, 1000);
      const timer = setInterval(sample, 1500);
      (app as any)._recallosAppTrackTimer = timer;
      // Close open segment on quit
      app.on('before-quit', () => {
        try {
          const db = (app as any)._recallosDb;
          const now = Math.floor(Date.now() / 1000);
          db.prepare?.('UPDATE activity_segments SET ended_at = ? WHERE ended_at IS NULL').run(now);
        } catch {}
      });
    }
  } catch {}

  // Save a recorded media chunk to disk and persist metadata
  ipcMain.handle('recallos:saveChunk', async (_evt, payload: any) => {
    try {
      if (!payload || !(payload.buffer instanceof ArrayBuffer)) throw new Error('Invalid buffer');
      const startedAtMs = Number(payload.startedAt || Date.now());
      const durationMs = Math.max(1, Number(payload.durationMs || 0));
      const type = typeof payload.type === 'string' ? payload.type : 'video';
      const width = Number(payload.width || 0) || null;
      const height = Number(payload.height || 0) || null;
      const sample_rate = Number(payload.sample_rate || 0) || null;
      const channel_layout = typeof payload.channel_layout === 'string' ? payload.channel_layout : null;
  const codec = typeof payload.codec === 'string' ? payload.codec : 'webm';
      const ext = typeof payload.ext === 'string' ? payload.ext : 'webm';
  const audio_role = typeof payload.audio_role === 'string' ? payload.audio_role : undefined;

      // Enforce per-app defaults: if current app is opted-out, skip saving
      try {
        const db = (app as any)._recallosDb;
        const atSec = Math.floor(startedAtMs / 1000);
        const seg = db.prepare?.('SELECT app_id FROM activity_segments WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY id DESC LIMIT 1').get(atSec, atSec);
        if (seg?.app_id) {
          const a = db.prepare?.('SELECT bundle_or_exe FROM apps WHERE id = ?').get(seg.app_id);
          const row = db.prepare?.('SELECT value FROM settings WHERE key = ?').get('app_opt_in_defaults');
          const obj = row?.value ? JSON.parse(row.value) : {};
          const def = obj?.[a?.bundle_or_exe];
          if (def === 'off') {
            return { ok: true, skipped: 'per-app-off' };
          }
        }
      } catch {}

      // Respect configured media data directory if set
      const db = (app as any)._recallosDb;
      let baseDir = app.getPath('userData');
      try {
        const row = db?.prepare?.('SELECT value FROM settings WHERE key = ?').get('data_dir');
        if (row?.value && typeof row.value === 'string' && row.value.length > 0) baseDir = row.value;
      } catch {}
      const d = new Date(startedAtMs);
      const ym = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const fileName = `${startedAtMs}-${Math.random().toString(36).slice(2,8)}.${ext}`;
      const filePath = join(baseDir, 'chunks', ym, fileName);
      ensureParentDir(filePath);
      const buf = Buffer.from(new Uint8Array(payload.buffer));
      await fsp.writeFile(filePath, buf);

      
      let id: number | null = null;
      try {
        const stmt = db.prepare?.(`INSERT INTO media_chunks(path, type, started_at, duration_ms, codec, width, height, sample_rate, channel_layout)
                                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const res = stmt?.run(filePath, type, Math.floor(startedAtMs/1000), durationMs, codec, width, height, sample_rate, channel_layout);
        const row = db.prepare?.('SELECT last_insert_rowid() AS id').get();
        id = row?.id ?? null;
        // Enqueue indexing job for this chunk (stub handler will succeed)
        if (id != null) {
          try {
            db.prepare?.(
              'INSERT INTO jobs(type, payload_json, status, attempts, created_at, updated_at, next_run_at) VALUES(?, ?, ?, ?, strftime("%s","now"), NULL, strftime("%s","now"))'
            ).run('index:chunk', JSON.stringify({ chunk_id: id, path: filePath, started_at_ms: startedAtMs, duration_ms: durationMs, codec, type }), 'queued', 0);
            db.prepare?.(
              'INSERT INTO jobs(type, payload_json, status, attempts, created_at, updated_at, next_run_at) VALUES(?, ?, ?, ?, strftime("%s","now"), NULL, strftime("%s","now"))'
            ).run('stt:chunk', JSON.stringify({ chunk_id: id, path: filePath, started_at_ms: startedAtMs, duration_ms: durationMs, codec, type, speaker: audio_role, audio_role }), 'queued', 0);
          } catch (e) {
            console.warn('Failed to enqueue index job for chunk', id, e);
          }
        }
      } catch {}
      return { ok: true, id, path: filePath };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
});

app.on('window-all-closed', () => {
  try { const stop = (app as any)._recallosStopProcessor as undefined | (() => void); if (stop) stop(); } catch {}
  try { const db = (app as any)._recallosDb; if (db && typeof db.close === 'function') db.close(); } catch {}
  try { const t = (app as any)._recallosAppTrackTimer as any; if (t) clearInterval(t); } catch {}
  if (process.platform !== 'darwin') app.quit();
});
