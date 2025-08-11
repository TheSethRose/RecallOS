import { app, BrowserWindow, ipcMain, systemPreferences, shell, session, desktopCapturer, dialog } from 'electron';
import { join, basename } from 'node:path';
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
import { initLogger, logError, logWarn, logInfo } from '../util/log';
import { detectGpuBackend, whisperGpuArgs } from '../util/gpu';
import { getActiveAppWindow as getActiveWin } from '../native';
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

const supportsDiarization = (): boolean => process.env.RECALLOS_STT_DIARIZATION_SUPPORTED === '1';

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

  // Honor background-minimize preference on window close
  try {
    win.on('close', (evt) => {
      try {
        // Only intercept for the main window; skip on explicit app quit
        if ((app as any)._recallosQuitting) return;
        const db = (app as any)._recallosDb;
        let pref: string | null = null;
        try {
          // Use in-memory cache when available to avoid sync DB hit
          if ((app as any)._recallosBgMinPref != null) {
            pref = (app as any)._recallosBgMinPref;
          } else {
            const row = db?.prepare?.('SELECT value FROM settings WHERE key = ?').get('background_minimize');
            pref = row?.value || null;
            (app as any)._recallosBgMinPref = pref;
          }
        } catch {}
        const enabled = String(pref || 'off') === 'on';
        if (enabled) {
          evt.preventDefault();
          try { win.minimize(); } catch {}
          try { win.hide(); } catch {}
          return;
        }
      } catch {}
    });
  } catch {}
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

  // Detect GPU capabilities for whisper.cpp (best-effort)
  try {
    const caps = detectGpuBackend();
    console.log('GPU:', caps.backend, caps.reason || '');
    (app as any)._recallosGpuCaps = caps;
  } catch {}

  // IPC: list capture sources (screens/windows)
  try {
    ipcMain.handle('recallos:capture:listSources', async (_evt, payload) => {
      try {
        const types = (payload?.types && Array.isArray(payload.types) && payload.types.length) ? payload.types : ['screen', 'window'];
        const sources = await desktopCapturer.getSources({ types: types as any, thumbnailSize: { width: 320, height: 200 } });
        return sources.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.id?.startsWith('screen:') ? 'screen' : (s.id?.startsWith('window:') ? 'window' : 'unknown'),
          displayId: (s as any).display_id || (s as any).displayId || null,
          thumbnail: s.thumbnail?.toDataURL?.() || null,
        }));
      } catch (e) {
        console.warn('listSources failed:', e);
        return [];
      }
    });
  } catch {}
 
  // Open application database (encrypted if SQLCipher is linked and passphrase provided)
  try {
    const baseDir = app.getPath('userData');
  const { db, encrypted, cipherVersion, path } = openAppDatabase(baseDir);
    console.log(`DB opened at ${path}. Encrypted=${encrypted}${cipherVersion ? ` (cipher ${cipherVersion})` : ''}`);
  const { applied } = runMigrations(db);
  if (applied.length) console.log('DB migrations applied:', applied);
    // Keep DB reference on app for longevity; close on exit
  (app as any)._recallosDb = db;
    try { (app as any)._recallosDbPath = path; } catch {}
  try { (app as any)._recallosDbEncrypted = !!encrypted; (app as any)._recallosCipherVersion = cipherVersion || null; } catch {}
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
    // Load OCR cadence (fps) setting with default 0.2
    try {
      const row = db.prepare?.('SELECT value FROM settings WHERE key = ?').get('ocr_fps');
      const fps = Math.max(0.05, Math.min(5, Number(row?.value || 0.2))) || 0.2;
      (app as any)._recallosOcrFps = fps;
    } catch {
      (app as any)._recallosOcrFps = 0.2;
    }
    // Retention cleanup helper (shared by scheduler and IPC)
    const doRetentionCleanup = async (): Promise<number> => {
      try {
        const row = db.prepare?.('SELECT value FROM settings WHERE key = ?').get('retention_days');
        const days = Math.max(0, Math.min(3650, Number(row?.value || 0)));
        if (!days) return 0;
        const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);
        const oldChunks = db.prepare?.('SELECT id, path FROM media_chunks WHERE started_at < ?').all(cutoff) || [];
        let deleted = 0;
        for (const c of oldChunks) {
          try { if (c.path) await fsp.unlink(String(c.path)).catch(() => {}); } catch {}
          try { db.prepare?.('DELETE FROM ocr_blocks WHERE chunk_id = ?').run(c.id); } catch {}
          try { db.prepare?.('DELETE FROM transcripts WHERE chunk_id = ?').run(c.id); } catch {}
          try { db.prepare?.('DELETE FROM media_chunks WHERE id = ?').run(c.id); deleted++; } catch {}
        }
        return deleted;
      } catch { return 0; }
    };

    // Start background job processor (simple inline handler for now)
    const q = new JobQueue(db);
    const stopProcessor = await startProcessor(db, 1, 1000, async (job) => {
      try {
        if (job.type === 'index:chunk') {
          const chunkId = Number(job.payload?.chunk_id);
          const path = String(job.payload?.path || '');
          if (!chunkId || !path) return true;
          // Extract frames at configured low frequency (default 0.2 fps) to process OCR
          const outDir = join(tmpdir(), `recallos-frames-${chunkId}-${Date.now()}`);
          const fps = (app as any)._recallosOcrFps || 0.2;
          const ex = await extractFrames(path, outDir, fps);
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

          // Diarization setting and capability (no-op if unsupported)
          try {
            const dbLocal = (app as any)._recallosDb;
            const row = dbLocal?.prepare?.('SELECT value FROM settings WHERE key = ?').get('stt_diarization');
            const enabled = String(row?.value || 'off') === 'on';
            if (enabled) {
              if (supportsDiarization()) {
                try { (app as any)._recallosSttDiarization = true; } catch {}
              } else {
                if (!(app as any)._recallosWarnedDiarUnsupported) {
                  try { logWarn('Diarization requested but not supported. Set RECALLOS_STT_DIARIZATION_SUPPORTED=1 to enable gating; proceeding without diarization.'); } catch {}
                  try { (app as any)._recallosWarnedDiarUnsupported = true; } catch {}
                }
              }
            }
          } catch {}

          // Run whisper.cpp to SRT with timestamps; prefer base.en model ensured earlier
          const modelRow = (app as any)._recallosModelPath || null;
          const modelPath = modelRow?.path || join(process.cwd(), 'models', 'ggml-base.en.bin');
          const baseOut = join(tmpdir(), `recallos-stt-${chunkId}-${Date.now()}`);
          const srtPath = `${baseOut}.srt`;
          try {
            // Optional performance tuning (threads)
            let threads: number | null = null;
            try {
              const dbLocal = (app as any)._recallosDb;
              const r = dbLocal?.prepare?.('SELECT value FROM settings WHERE key = ?').get('stt_threads');
              threads = r?.value ? Number(r.value) : null;
            } catch {}
            const args = ['-m', modelPath, '-f', wavPath, '-osrt', '-of', baseOut, '-pp'] as string[];
            if (threads && threads > 0 && Number.isFinite(threads)) { args.push('-t', String(Math.max(1, Math.min(16, Math.floor(threads))))); }
            // GPU offload (uses detection with optional DB/env override)
            try {
              const caps = (app as any)._recallosGpuCaps || detectGpuBackend();
              let ngl: number | null = null;
              try {
                const dbLocal2 = (app as any)._recallosDb;
                const r2 = dbLocal2?.prepare?.('SELECT value FROM settings WHERE key = ?').get('stt_ngl');
                ngl = r2?.value ? Number(r2.value) : null;
              } catch {}
              const gpu = whisperGpuArgs(caps, ngl);
              if (gpu.length) args.push(...gpu);
            } catch {}
            await execFileAsync(whisper, args, { maxBuffer: 10 * 1024 * 1024 });
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

    // Schedule periodic retention cleanup (every 6h)
    try {
      const runAndReschedule = async () => { try { await doRetentionCleanup(); } catch {} };
      setTimeout(runAndReschedule, 5_000);
      const t = setInterval(runAndReschedule, 6 * 3600 * 1000);
      (app as any)._recallosRetentionTimer = t;
    } catch {}
  } catch (e) {
    console.error('Failed to open app database:', e);
  }

  // Attempt auto-repair for recent .webm chunks (in case of prior crash)
  try {
    const chunksRoot = join(app.getPath('userData'), 'chunks');
    const since = Date.now() - 60 * 60 * 1000; // last hour
    const files = await listRecentWebmFiles(chunksRoot, since);
    const now = Date.now();
    let scanned = 0, repaired = 0, quarantined = 0, skippedRecent = 0, failed = 0;
    for (const f of files) {
      // Skip already quarantined or temp repair artifacts
      if (f.includes('/_corrupt/') || f.includes('/.__repair_')) continue;
      scanned++;
      try {
        const st = await fsp.stat(f).catch(() => null);
        if (st && now - st.mtimeMs < 120_000) { skippedRecent++; continue; } // skip files modified within last 2 minutes
      } catch {}
      const res = await repairWebmInPlace(f);
      if (res.ok) { repaired++; continue; }
      if (!res.ok && res.error && res.error !== 'ffmpeg-missing') {
        // Ignore benign skip signals
        if (res.error === 'quarantined-skip' || res.error === 'temp-skip' || res.error === 'too-small') continue;
        failed++;
        try {
          // Quarantine the file to avoid repeated repair attempts
          const qDir = join(chunksRoot, '_corrupt');
          await fsp.mkdir(qDir, { recursive: true });
          const target = join(qDir, `${Date.now()}-${Math.random().toString(36).slice(2,8)}-${f.split('/').pop()}`);
          await fsp.rename(f, target);
          quarantined++;
        } catch (e) {
          console.warn('Failed to quarantine corrupt chunk:', f, e);
        }
      }
    }
    if (scanned > 0) {
      console.warn(`Chunk repair summary: scanned=${scanned}, repaired=${repaired}, quarantined=${quarantined}, skippedRecent=${skippedRecent}, failed=${failed}`);
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
  // STT capability: diarization support (env-gated)
  ipcMain.handle('recallos:stt:caps', async () => {
    try {
      return { ok: true, diarization: supportsDiarization() };
    } catch (e: any) {
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

  // Calendar: import .ics files (parse and upsert events, also stage copies)
  ipcMain.handle('recallos:calendar:importIcs', async () => {
    try {
      const res = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Calendar', extensions: ['ics'] }],
      });
      if (res.canceled || !res.filePaths?.length) return { cancelled: true };

      const db = (app as any)._recallosDb;

      // Resolve base data directory (settings.data_dir overrides userData)
      let baseDir = app.getPath('userData');
      try {
        const row = db?.prepare?.('SELECT value FROM settings WHERE key = ?').get('data_dir');
        if (row?.value && typeof row.value === 'string' && row.value.length > 0) baseDir = row.value;
      } catch {}

  const calDir = join(baseDir, 'calendar');
  const importsDir = join(calDir, 'imports');
  try { await fsp.mkdir(importsDir, { recursive: true }); } catch {}
  try { await fsp.mkdir(calDir, { recursive: true }); } catch {}

  // Prepare events upsert (dedupe via unique source key)
  try { db?.prepare?.('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source ON events(source)').run(); } catch {}
  const insertEv = db?.prepare?.('INSERT OR REPLACE INTO events(title, location, started_at, ended_at, source) VALUES(?,?,?,?,?)');
  const { parseICS } = require('../util/ics');

      const MAX = 10 * 1024 * 1024; // 10 MB
  let imported = 0;

      for (const src of res.filePaths) {
        try {
          const orig = basename(src);

          // Validate extension
          if (!/\.ics$/i.test(orig)) {
            try { logWarn(`ICS import skipped (bad extension): ${orig}`); } catch {}
            continue;
          }

          // Validate size
          try {
            const st = await fsp.stat(src);
            if (!st || st.size > MAX) {
              try { logWarn(`ICS import skipped (too large): ${orig} (${st?.size || 0} bytes)`); } catch {}
              continue;
            }
          } catch {
            try { logWarn(`ICS import stat failed: ${orig}`); } catch {}
            continue;
          }

          // Parse ICS and upsert events
          let content = '';
          try { content = await fsp.readFile(src, 'utf8'); } catch {}
          if (content) {
            try {
              const evs = parseICS(content) || [];
              const fileKey = orig.replace(/[^a-z0-9._-]/gi,'_').toLowerCase();
              for (const ev of evs) {
                try {
                  const title = ev?.title || null;
                  const location = ev?.location || null;
                  const started_at = Math.max(0, Number(ev?.dtStart||0)) || 0;
                  const ended_at = Math.max(started_at, Number(ev?.dtEnd||started_at)) || started_at;
                  const uid = (ev?.uid || '').toString().trim();
                  const srcKey = uid ? `ics:${fileKey}#${uid}` : `ics:${fileKey}#${started_at}:${ended_at}:${(title||'').slice(0,64)}`;
                  insertEv?.run(title, location, started_at, ended_at, srcKey);
                } catch {}
              }
            } catch (e: any) {
              try { logWarn(`ICS parse failed: ${orig}: ${e?.message || String(e)}`); } catch {}
            }
          }

          // Copy to staged imports with unique name (keep provenance)
          const fname = `${Date.now()}-${Math.random().toString(36).slice(2,8)}-${orig}`;
          const dest = join(importsDir, fname);
          await fsp.copyFile(src, dest);
          imported++;
          try { logInfo(`ICS imported: ${dest}`); } catch {}
        } catch (e: any) {
          try { logError(`ICS import failed: ${e?.message || String(e)}`); } catch {}
        }
      }

      return { cancelled: false, imported };
    } catch (e: any) {
      try { logError(`ICS import IPC failed: ${e?.message || String(e)}`); } catch {}
      return { cancelled: true };
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
      // Apply select settings immediately in-memory
      try {
        if (payload.key === 'ocr_fps') {
          const v = Math.max(0.05, Math.min(5, Number(payload.value)));
          (app as any)._recallosOcrFps = Number.isFinite(v) ? v : (app as any)._recallosOcrFps;
        } else if (payload.key === 'privacy_indicator') {
          // If disabling, clear indicators
          const enabled = String(payload.value || 'on') !== 'off';
          if (!enabled) {
            try { if (process.platform === 'darwin' && app.dock && app.dock.setBadge) app.dock.setBadge(''); } catch {}
            try {
              const win = BrowserWindow.getAllWindows()[0];
              if (win && !win.isDestroyed()) win.setTitle('RecallOS');
            } catch {}
          }
        }
        // Cache background minimize preference for fast access on close
        else if (payload.key === 'background_minimize') {
          try { (app as any)._recallosBgMinPref = String(payload.value || 'off'); } catch {}
        }
      } catch {}
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Backup/export: copy DB and settings (and optional media manifest) to destination folder
  ipcMain.handle('recallos:backup:run', async (_evt, payload: any) => {
    try {
      const destDir = String(payload?.destDir || '').trim();
      const includeManifest = !!payload?.includeManifest;
      if (!destDir) throw new Error('no-dest');
      const db = (app as any)._recallosDb;
      const dbPath: string = (app as any)._recallosDbPath || join(app.getPath('userData'), 'recallos.sqlite3');
      // Create timestamped backup directory
      const d = new Date();
      const ts = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`;
      const outDir = join(destDir, `recallos-backup-${ts}`);
      try { await fsp.mkdir(outDir, { recursive: true }); } catch {}
      // Snapshot DB using VACUUM INTO for consistency; fallback to raw copy
      const dbOut = join(outDir, 'recallos.sqlite3');
      try {
        const escaped = dbOut.replace(/'/g, "''");
        db.prepare?.(`VACUUM INTO '${escaped}'`).run();
      } catch {
        await fsp.copyFile(dbPath, dbOut);
      }
      // Export settings
      let settingsObj: Record<string, string> = {};
      try {
        const rows = db.prepare?.('SELECT key, value FROM settings').all() || [];
        for (const r of rows) settingsObj[r.key] = r.value;
      } catch {}
      await fsp.writeFile(join(outDir, 'settings.json'), JSON.stringify(settingsObj, null, 2), 'utf8');
      // Write metadata.json (encryption info)
      try {
        const meta = {
          exported_at: new Date().toISOString(),
          type: 'backup',
          db_encrypted: !!(app as any)._recallosDbEncrypted,
          cipher_version: (app as any)._recallosCipherVersion || null
        };
        await fsp.writeFile(join(outDir, 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8');
      } catch {}
      // Optional: media chunks manifest
      let files = 2;
      if (includeManifest) {
        try {
          const rows = db.prepare?.('SELECT id, path, started_at, duration_ms, type FROM media_chunks ORDER BY started_at').all() || [];
          const manifest: any[] = [];
          for (const r of rows) {
            let exists = false, size: number | null = null;
            try { const st = await fsp.stat(String(r.path)); exists = st.isFile(); size = st.size; } catch {}
            manifest.push({ id: r.id, path: r.path, started_at: r.started_at, duration_ms: r.duration_ms, type: r.type, exists, size });
          }
          await fsp.writeFile(join(outDir, 'chunks-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
          files++;
        } catch {}
      }
      return { ok: true, path: outDir, files };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Export current search results (renderer supplies rows), format json|csv, write to file
  ipcMain.handle('recallos:export:results', async (_evt, payload: any) => {
    try {
      const inputRows = Array.isArray(payload?.rows) ? payload.rows : [];
      const format = (payload?.format === 'csv') ? 'csv' : 'json';
      const outPath = String(payload?.outPath || '').trim();
      const columns = ['rowid','content','type','chunk_id','ts_ms','app_bundle','app_name','window_title'];
      const meta = {
        exported_at: new Date().toISOString(),
        count: inputRows.length,
        columns
      };
      if (!outPath) throw new Error('no-outpath');
      ensureParentDir(outPath);
      const rows = inputRows.map((r: any) => ({
        rowid: r.rowid ?? '',
        content: r.content ?? r.snippet ?? '',
        type: r.type ?? '',
        chunk_id: r.chunk_id ?? '',
        ts_ms: r.ts_ms ?? '',
        app_bundle: r.app_bundle ?? '',
        app_name: r.app_name ?? '',
        window_title: r.window_title ?? ''
      }));
      if (format === 'json') {
        const data = { meta, rows };
        await fsp.writeFile(outPath, JSON.stringify(data, null, 2), 'utf8');
      } else {
        const header = columns.join(',') + '\n';
        const esc = (v: any) => {
          if (v == null) return '';
          const s = String(v);
          if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
          return s;
        };
        const lines = [header];
        for (const r of rows) {
          lines.push([
            esc(r.rowid), esc(r.content), esc(r.type), esc(r.chunk_id), esc(r.ts_ms), esc(r.app_bundle), esc(r.app_name), esc(r.window_title)
          ].join(',') + '\n');
        }
        await fsp.writeFile(outPath, lines.join(''), 'utf8');
      }
      return { ok: true, path: outPath, count: rows.length };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Export selected time range with related data; optionally copy media files
  ipcMain.handle('recallos:export:range', async (_evt, payload: any) => {
    try {
      const destDir = String(payload?.destDir || '').trim();
      const from = Number(payload?.from || 0) || 0; // epoch seconds
      const to = Number(payload?.to || 0) || 0; // epoch seconds
      const includeMedia = !!payload?.includeMedia;
      if (!destDir) throw new Error('no-dest');
      if (!from || !to || to < from) throw new Error('invalid-range');
      const db = (app as any)._recallosDb;
      // Create output dir
      const outDir = join(destDir, `recallos-range-${from}-${to}`);
      try { await fsp.mkdir(outDir, { recursive: true }); } catch {}
      // Query media chunks in range
      const chunks = db.prepare?.('SELECT id, path, type, started_at, duration_ms, codec, width, height, sample_rate, channel_layout FROM media_chunks WHERE started_at BETWEEN ? AND ? ORDER BY started_at').all(from, to) || [];
      const chunkIds = chunks.map((c: any) => c.id);
      // Related OCR and transcripts
      const ocr = chunkIds.length ? (db.prepare?.(`SELECT id, chunk_id, ts_ms, text FROM ocr_blocks WHERE chunk_id IN (${chunkIds.map(()=>'?').join(',')}) ORDER BY chunk_id, ts_ms`).all(...chunkIds) || []) : [];
      const trs = chunkIds.length ? (db.prepare?.(`SELECT id, chunk_id, ts_ms, text, speaker FROM transcripts WHERE chunk_id IN (${chunkIds.map(()=>'?').join(',')}) ORDER BY chunk_id, ts_ms`).all(...chunkIds) || []) : [];
      // Activity segments overlapping range and related apps
      const segs = db.prepare?.('SELECT * FROM activity_segments WHERE (started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)) OR (started_at BETWEEN ? AND ?) ORDER BY started_at').all(to, from, from, to) || [];
      const appIds = Array.from(new Set(segs.map((s: any) => s.app_id).filter(Boolean)));
      const apps = appIds.length ? (db.prepare?.(`SELECT * FROM apps WHERE id IN (${appIds.map(()=>'?').join(',')})`).all(...appIds) || []) : [];
      // Write JSON files
      await fsp.writeFile(join(outDir, 'media_chunks.json'), JSON.stringify(chunks, null, 2), 'utf8');
      await fsp.writeFile(join(outDir, 'ocr_blocks.json'), JSON.stringify(ocr, null, 2), 'utf8');
      await fsp.writeFile(join(outDir, 'transcripts.json'), JSON.stringify(trs, null, 2), 'utf8');
      await fsp.writeFile(join(outDir, 'activity_segments.json'), JSON.stringify(segs, null, 2), 'utf8');
      await fsp.writeFile(join(outDir, 'apps.json'), JSON.stringify(apps, null, 2), 'utf8');
      // Settings snapshot
      try {
        const rows = db.prepare?.('SELECT key, value FROM settings').all() || [];
        const settingsObj: Record<string, string> = {};
        for (const r of rows) settingsObj[r.key] = r.value;
        await fsp.writeFile(join(outDir, 'settings.json'), JSON.stringify(settingsObj, null, 2), 'utf8');
      } catch {}
      // Metadata
      const meta = {
        exported_at: new Date().toISOString(),
        type: 'range',
        from, to,
        counts: { chunks: chunks.length, ocr: ocr.length, transcripts: trs.length, segments: segs.length, apps: apps.length },
        db_encrypted: !!(app as any)._recallosDbEncrypted,
        cipher_version: (app as any)._recallosCipherVersion || null
      };
      await fsp.writeFile(join(outDir, 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8');
      // Optionally copy media
      if (includeMedia && chunks.length) {
        const mediaDir = join(outDir, 'media');
        try { await fsp.mkdir(mediaDir, { recursive: true }); } catch {}
        for (const c of chunks) {
          try {
            const base = String(c.path || '').split('/').pop() || `chunk-${c.id}`;
            const out = join(mediaDir, `${c.id}-${base}`);
            await fsp.copyFile(String(c.path), out);
          } catch {}
        }
      }
      return { ok: true, path: outDir };
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
    // Helpers: token extraction and highlighter
    const extractTokens = (input: string): Array<{ t: string; prefix: boolean } | { phrase: string }> => {
      const tokens: Array<{ t: string; prefix: boolean } | { phrase: string }> = [];
      try {
        // Pull phrases in quotes first
        const phraseRe = /"([^"]+)"/g;
        let pm: RegExpExecArray | null;
        const seen = new Set<string>();
        while ((pm = phraseRe.exec(input)) !== null) {
          const phrase = (pm[1] || '').trim();
          if (phrase && !seen.has(`p:${phrase.toLowerCase()}`)) { tokens.push({ phrase }); seen.add(`p:${phrase.toLowerCase()}`); }
        }
        // Remove phrases to avoid splitting inside them
        const scrubbed = input.replace(/"[^"]+"/g, ' ').trim();
        for (const raw of scrubbed.split(/\s+/)) {
          if (!raw) continue;
          const up = raw.toUpperCase();
          if (up === 'AND' || up === 'OR') continue;
          const isPrefix = raw.endsWith('*');
          const base = (isPrefix ? raw.slice(0, -1) : raw).trim();
          if (!base) continue;
          const key = `t:${isPrefix ? base.toLowerCase() + '*' : base.toLowerCase()}`;
          if (seen.has(key)) continue;
          tokens.push({ t: base, prefix: isPrefix });
          seen.add(key);
        }
      } catch {}
      // Limit to a reasonable number to avoid pathological regex time
      return tokens.slice(0, 16);
    };
    const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mergeRanges = (ranges: Array<[number, number]>): Array<[number, number]> => {
      if (!ranges.length) return ranges;
      ranges.sort((a, b) => a[0] - b[0]);
      const out: Array<[number, number]> = [ranges[0]];
      for (let i = 1; i < ranges.length; i++) {
        const [s, e] = ranges[i];
        const last = out[out.length - 1];
        if (s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
      }
      return out;
    };
    const highlightAll = (text: string, tokens: ReturnType<typeof extractTokens>): string => {
      try {
        if (!tokens.length || !text) return text;
        const ranges: Array<[number, number]> = [];
        for (const tk of tokens) {
          if ('phrase' in tk) {
            const re = new RegExp(escapeReg(tk.phrase), 'gi');
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
              ranges.push([m.index, m.index + m[0].length]);
              if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-length loops
            }
          } else {
            const s = tk.t;
            if (!s) continue;
            const re = tk.prefix ? new RegExp(escapeReg(s) + '\\S*', 'gi') : new RegExp(escapeReg(s), 'gi');
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
              ranges.push([m.index, m.index + m[0].length]);
              if (m.index === re.lastIndex) re.lastIndex++;
            }
          }
        }
        if (!ranges.length) return text;
        const merged = mergeRanges(ranges);
        let out = '';
        let pos = 0;
        for (const [s, e] of merged) {
          if (s > pos) out += text.slice(pos, s);
          out += '[' + text.slice(s, e) + ']';
          pos = e;
        }
        if (pos < text.length) out += text.slice(pos);
        return out;
      } catch { return text; }
    };
    const tokens = extractTokens(q);
    // Helper to build a time-window snippet around a hit using nearby rows in same chunk and highlight tokens
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
        const combinedRaw = rowsCtx.map((r: any) => String(r.text || '')).join(glue);
        const highlighted = highlightAll(combinedRaw, tokens);
        // Trim overly long snippets to ~2*windowChars while preserving highlights
        if (highlighted.length <= windowChars * 2) return highlighted;
        // Find first highlight marker to center around
        const first = highlighted.indexOf('[');
        if (first < 0) return highlighted.slice(0, windowChars * 2) + ' …';
        const startCut = Math.max(0, first - windowChars);
        const endCut = Math.min(highlighted.length, first + windowChars);
        const prefix = startCut > 0 ? '… ' : '';
        const suffix = endCut < highlighted.length ? ' …' : '';
        return prefix + highlighted.slice(startCut, endCut) + suffix;
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
          // When not using time-window, still ensure multiple tokens are highlighted if FTS snippet is unavailable
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
            const highlighted = highlightAll(content, tokens);
            if (highlighted.length <= windowChars * 2) return highlighted;
            const first = highlighted.indexOf('[');
            if (first < 0) return highlighted.slice(0, windowChars * 2) + ' …';
            const start = Math.max(0, first - windowChars);
            const end = Math.min(highlighted.length, first + windowChars);
            const ellipsisPre = start > 0 ? '… ' : '';
            const ellipsisPost = end < highlighted.length ? ' …' : '';
            return `${ellipsisPre}${highlighted.slice(start, end)}${ellipsisPost}`;
          })(),
          type: r.type, chunk_id: r.chunk_id, ts_ms: r.ts_ms,
          app_bundle: r.app_bundle, app_name: r.app_name, window_title: r.window_title,
        }));
      }
      return rows.map((r: any) => {
        const content = String(r.content || '');
        const highlighted = highlightAll(content, tokens);
        if (highlighted.length <= windowChars * 2) return { snippet: highlighted, type: r.type, chunk_id: r.chunk_id, ts_ms: r.ts_ms };
        const first = highlighted.indexOf('[');
        if (first < 0) return { snippet: highlighted.slice(0, windowChars * 2) + ' …', type: r.type, chunk_id: r.chunk_id, ts_ms: r.ts_ms };
        const start = Math.max(0, first - windowChars);
        const end = Math.min(highlighted.length, first + windowChars);
        const ellipsisPre = start > 0 ? '… ' : '';
        const ellipsisPost = end < highlighted.length ? ' …' : '';
        return { snippet: `${ellipsisPre}${highlighted.slice(start, end)}${ellipsisPost}`, type: r.type, chunk_id: r.chunk_id, ts_ms: r.ts_ms };
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
      // Respect privacy indicator setting
      try {
        const db = (app as any)._recallosDb;
        const row = db?.prepare?.('SELECT value FROM settings WHERE key = ?').get('privacy_indicator');
        const enabled = String(row?.value || 'on') !== 'off';
        if (enabled) {
          if (process.platform === 'darwin' && app.dock && app.dock.setBadge) {
            app.dock.setBadge(active ? 'REC' : '');
          } else {
            const win = BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              const base = 'RecallOS';
              win.setTitle(active ? `${base} • REC` : base);
            }
          }
        } else {
          // Clear any active indicator if disabled
          if (process.platform === 'darwin' && app.dock && app.dock.setBadge) app.dock.setBadge('');
          const win = BrowserWindow.getAllWindows()[0];
          if (win && !win.isDestroyed()) win.setTitle('RecallOS');
        }
      } catch {}
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Start-on-login settings
  ipcMain.handle('recallos:login:get', async () => {
    try {
      const info = (app as any).getLoginItemSettings ? (app as any).getLoginItemSettings() : { openAtLogin: false };
      return { ok: true, openAtLogin: !!info.openAtLogin };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle('recallos:login:set', async (_evt, payload: any) => {
    try {
      const enable = !!payload?.openAtLogin;
      if ((app as any).setLoginItemSettings) (app as any).setLoginItemSettings({ openAtLogin: enable, openAsHidden: true });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Retention cleanup
  ipcMain.handle('recallos:retention:run', async () => {
    try {
      const deleted = await (async () => {
        try {
          const db = (app as any)._recallosDb;
          // Inline reuse of helper via closure
          const row = db.prepare?.('SELECT value FROM settings WHERE key = ?').get('retention_days');
          const days = Math.max(0, Math.min(3650, Number(row?.value || 0)));
          if (!days) return 0;
          const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);
          const oldChunks = db.prepare?.('SELECT id, path FROM media_chunks WHERE started_at < ?').all(cutoff) || [];
          let deleted = 0;
          for (const c of oldChunks) {
            try { if (c.path) await fsp.unlink(String(c.path)).catch(() => {}); } catch {}
            try { db.prepare?.('DELETE FROM ocr_blocks WHERE chunk_id = ?').run(c.id); } catch {}
            try { db.prepare?.('DELETE FROM transcripts WHERE chunk_id = ?').run(c.id); } catch {}
            try { db.prepare?.('DELETE FROM media_chunks WHERE id = ?').run(c.id); deleted++; } catch {}
          }
          return deleted;
        } catch { return 0; }
      })();
      return { ok: true, deleted };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // SQLCipher rekey (change passphrase)
  ipcMain.handle('recallos:sql:rekey', async (_evt, payload: any) => {
    try {
      const newPass = String(payload?.pass || '').trim();
      if (!newPass) throw new Error('invalid-pass');
      const feats = detectSqlFeatures();
      if (!feats.sqlcipher) throw new Error('sqlcipher-not-linked');
      const db = (app as any)._recallosDb;
      // Apply rekey. Note: app must be restarted with new RECALLOS_PASSPHRASE to reopen.
      db.pragma?.(`rekey = '${newPass.replace(/'/g, "''")}'`);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Windows: foreground app/window tracking sampler (Phase 8)
  try {
    if (process.platform === 'win32') {
      const db = (app as any)._recallosDb;
      const sample = async () => {
        try {
          const info = await getActiveWin();
          const appKey = (info.appId || (info.exe ? basename(info.exe) : '') || 'unknown').slice(0, 256);
          const windowTitle = String(info.title || '').slice(0, 512);
          if (!appKey) return;
          let appId: number | null = null;
          try {
            const row = db.prepare?.('SELECT id FROM apps WHERE bundle_or_exe = ?').get(appKey);
            if (row?.id) {
              appId = row.id;
            } else {
              const display = (info.exe ? basename(info.exe) : appKey) || appKey;
              db.prepare?.('INSERT INTO apps(bundle_or_exe, display_name) VALUES(?, ?)').run(appKey, display);
              const idRow = db.prepare?.('SELECT last_insert_rowid() AS id').get();
              appId = idRow?.id ?? null;
            }
          } catch {}
          if (appId == null) return;
          const now = Math.floor(Date.now() / 1000);
          try {
            const last = db.prepare?.('SELECT id, app_id, window_title, started_at, ended_at FROM activity_segments ORDER BY id DESC LIMIT 1').get();
            if (last && last.app_id === appId && String(last.window_title || '') === String(windowTitle || '')) {
              if (last.ended_at != null) {
                db.prepare?.('UPDATE activity_segments SET ended_at = NULL WHERE id = ?').run(last.id);
              }
            } else {
              if (last && last.ended_at == null) {
                db.prepare?.('UPDATE activity_segments SET ended_at = ? WHERE id = ?').run(now, last.id);
              }
              db.prepare?.('INSERT INTO activity_segments(app_id, window_title, started_at, ended_at) VALUES(?, ?, ?, NULL)').run(appId, windowTitle, now);
            }
          } catch {}
        } catch {}
      };
      setTimeout(sample, 1000);
      const timer = setInterval(sample, 1500);
      (app as any)._recallosAppTrackTimer = timer;
      app.on('before-quit', () => {
        try {
          const db = (app as any)._recallosDb;
          const now = Math.floor(Date.now() / 1000);
          db.prepare?.('UPDATE activity_segments SET ended_at = ? WHERE ended_at IS NULL').run(now);
        } catch {}
      });
    }
  } catch {}

  // Linux: foreground app/window tracking sampler (Phase 8)
  try {
    if (process.platform === 'linux') {
      const db = (app as any)._recallosDb;
      const sample = async () => {
        try {
          const info = await getActiveWin();
          const appKey = (info.appId || (info.exe ? basename(info.exe) : '') || 'unknown').slice(0, 256);
          const windowTitle = String(info.title || '').slice(0, 512);
          if (!appKey) return;
          let appId: number | null = null;
          try {
            const row = db.prepare?.('SELECT id FROM apps WHERE bundle_or_exe = ?').get(appKey);
            if (row?.id) {
              appId = row.id;
            } else {
              const display = (info.exe ? basename(info.exe) : appKey) || appKey;
              db.prepare?.('INSERT INTO apps(bundle_or_exe, display_name) VALUES(?, ?)').run(appKey, display);
              const idRow = db.prepare?.('SELECT last_insert_rowid() AS id').get();
              appId = idRow?.id ?? null;
            }
          } catch {}
          if (appId == null) return;
          const now = Math.floor(Date.now() / 1000);
          try {
            const last = db.prepare?.('SELECT id, app_id, window_title, started_at, ended_at FROM activity_segments ORDER BY id DESC LIMIT 1').get();
            if (last && last.app_id === appId && String(last.window_title || '') === String(windowTitle || '')) {
              if (last.ended_at != null) {
                db.prepare?.('UPDATE activity_segments SET ended_at = NULL WHERE id = ?').run(last.id);
              }
            } else {
              if (last && last.ended_at == null) {
                db.prepare?.('UPDATE activity_segments SET ended_at = ? WHERE id = ?').run(now, last.id);
              }
              db.prepare?.('INSERT INTO activity_segments(app_id, window_title, started_at, ended_at) VALUES(?, ?, ?, NULL)').run(appId, windowTitle, now);
            }
          } catch {}
        } catch {}
      };
      setTimeout(sample, 1000);
      const timer = setInterval(sample, 1500);
      (app as any)._recallosAppTrackTimer = timer;
      app.on('before-quit', () => {
        try {
          const db = (app as any)._recallosDb;
          const now = Math.floor(Date.now() / 1000);
          db.prepare?.('UPDATE activity_segments SET ended_at = ? WHERE ended_at IS NULL').run(now);
        } catch {}
      });
    }
  } catch {}

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
  const display_id = typeof payload.display_id === 'string' ? payload.display_id : (payload.display_id == null ? null : String(payload.display_id));
  const display_name = typeof payload.display_name === 'string' ? payload.display_name : (payload.display_name == null ? null : String(payload.display_name));

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
  const stmt = db.prepare?.(`INSERT INTO media_chunks(path, type, started_at, duration_ms, codec, width, height, sample_rate, channel_layout, display_id, display_name)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const res = stmt?.run(filePath, type, Math.floor(startedAtMs/1000), durationMs, codec, width, height, sample_rate, channel_layout, display_id, display_name);
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

  // Logger IPC
  ipcMain.handle('recallos:log', async (_evt, payload: any) => {
    try {
      const lvl = String(payload?.level || 'info').toLowerCase();
      const msg = String(payload?.message || '');
      const meta = payload?.meta ? ` ${JSON.stringify(payload.meta)}` : '';
      const line = `[renderer] ${msg}${meta}`;
      if (lvl === 'warn') { console.warn(line); try { logWarn(line); } catch {} }
      else if (lvl === 'error') { console.error(line); try { logError(line); } catch {} }
      else { console.log(line); try { logInfo(line); } catch {} }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Settings window management
  ipcMain.handle('recallos:ui:openSettings', async () => {
    try {
      const key = '_recallosSettingsWin';
      let win: BrowserWindow | undefined = (app as any)[key];
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
        return { ok: true };
      }
      win = new BrowserWindow({
        width: 900,
        height: 700,
        resizable: true,
        title: 'Settings — RecallOS',
        webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true },
      });
      (app as any)[key] = win;
      win.on('closed', () => { try { (app as any)[key] = undefined; } catch {} });
      win.loadFile(join(__dirname, '../renderer/settings.html'));
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
});

app.on('window-all-closed', () => {
  try { const stop = (app as any)._recallosStopProcessor as undefined | (() => void); if (stop) stop(); } catch {}
  try { const db = (app as any)._recallosDb; if (db && typeof db.close === 'function') db.close(); } catch {}
  try { const t = (app as any)._recallosRetentionTimer as any; if (t) clearInterval(t); } catch {}
  try { const t = (app as any)._recallosAppTrackTimer as any; if (t) clearInterval(t); } catch {}
  if (process.platform !== 'darwin') app.quit();
});

// Track explicit quit so close handler can allow shutdown
try {
  app.on('before-quit', () => { try { (app as any)._recallosQuitting = true; } catch {} });
} catch {}
