import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveFFmpeg } from '../bin/manager';
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface FFmpegCaps {
  path: string | null;
  hwaccels: string[];
  encoders: string[];
  hasVideotoolbox: boolean;
  hasNVENC: boolean;
  hasVAAPI: boolean;
}

export async function detectFFmpegCaps(): Promise<FFmpegCaps> {
  const ff = resolveFFmpeg();
  if (!ff) return { path: null, hwaccels: [], encoders: [], hasVideotoolbox: false, hasNVENC: false, hasVAAPI: false };
  let hwaccels: string[] = [];
  let encoders: string[] = [];
  try {
    const { stdout } = await execFileAsync(ff, ['-hide_banner', '-hwaccels'], { timeout: 5000 });
    hwaccels = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(s => !s.toLowerCase().includes('hardware acceleration methods'));
  } catch {}
  try {
    const { stdout } = await execFileAsync(ff, ['-hide_banner', '-encoders'], { timeout: 7000 });
    encoders = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {}
  const hasVideotoolbox = hwaccels.some(h => h.toLowerCase().includes('videotoolbox')) || encoders.some(l => /h264_videotoolbox|hevc_videotoolbox/.test(l));
  const hasNVENC = encoders.some(l => /_nvenc\b/.test(l));
  const hasVAAPI = encoders.some(l => /_vaapi\b/.test(l));
  return { path: ff, hwaccels, encoders, hasVideotoolbox, hasNVENC, hasVAAPI };
}

export function recommendFFmpegVideoEncoder(caps: FFmpegCaps): { videoCodec: string; extraArgs: string[] } {
  if (process.platform === 'darwin' && caps.hasVideotoolbox) {
    return { videoCodec: 'h264_videotoolbox', extraArgs: ['-pix_fmt', 'yuv420p'] };
  }
  if (process.platform === 'win32' && caps.hasNVENC) {
    return { videoCodec: 'h264_nvenc', extraArgs: ['-rc', 'vbr', '-pix_fmt', 'yuv420p'] };
  }
  if (process.platform !== 'win32' && caps.hasVAAPI) {
    return { videoCodec: 'h264_vaapi', extraArgs: [] };
  }
  return { videoCodec: 'libvpx-vp9', extraArgs: ['-b:v', '0', '-crf', '32'] };
}

export async function repairWebmInPlace(inputPath: string): Promise<{ ok: boolean; error?: string }> {
  const ff = resolveFFmpeg();
  if (!ff) return { ok: false, error: 'ffmpeg-missing' };
  const dir = dirname(inputPath);
  const tmpOut = join(dir, `.__repair_${Date.now()}.webm`);
  try {
    await execFileAsync(ff, ['-hide_banner', '-y', '-fflags', '+genpts', '-i', inputPath, '-map', '0', '-c', 'copy', '-f', 'webm', tmpOut], { timeout: 20000 });
    const st = await fsp.stat(tmpOut).catch(() => null);
    if (!st || st.size <= 0) throw new Error('empty-output');
    await fsp.rename(tmpOut, inputPath);
    return { ok: true };
  } catch (e: any) {
    try { await fsp.rm(tmpOut, { force: true }); } catch {}
  return { ok: false, error: e?.message || String(e) };
  }
}

export async function listRecentWebmFiles(root: string, sinceEpochMs: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(p: string) {
    try {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      for (const e of entries) {
        const full = join(p, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.webm')) {
          const st = await fsp.stat(full);
          if (st.mtimeMs >= sinceEpochMs) out.push(full);
        }
      }
    } catch {}
  }
  await walk(root);
  return out;
}

// Extract frames at a given FPS to an output directory (PNG sequence)
export async function extractFrames(inputPath: string, outDir: string, fps: number): Promise<{ ok: boolean; error?: string }> {
  const ff = resolveFFmpeg();
  if (!ff) return { ok: false, error: 'ffmpeg-missing' };
  try {
    await fsp.mkdir(outDir, { recursive: true });
    const fpsExpr = fps > 0 ? String(fps) : '1';
    // Use -vsync vfr to avoid duplicating frames when source fps < target; output numbered PNGs
    await execFileAsync(ff, ['-hide_banner', '-y', '-i', inputPath, '-vf', `fps=${fpsExpr}`, '-vsync', 'vfr', join(outDir, 'frame-%06d.png')], { timeout: 60000 });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Extract mono 16kHz WAV for STT input
export async function extractAudioWav(inputPath: string, outPath: string, sampleRate = 16000): Promise<{ ok: boolean; error?: string }> {
  const ff = resolveFFmpeg();
  if (!ff) return { ok: false, error: 'ffmpeg-missing' };
  try {
    await fsp.mkdir(dirname(outPath), { recursive: true });
    await execFileAsync(ff, ['-hide_banner', '-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', outPath], { timeout: 60000 });
    const st = await fsp.stat(outPath).catch(() => null);
    if (!st || st.size <= 0) throw new Error('empty-wav');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Measure simple RMS energy to detect silence quickly; returns true if likely silent
export async function isAudioLikelySilent(inputPath: string): Promise<boolean> {
  const ff = resolveFFmpeg();
  if (!ff) return false;
  return new Promise<boolean>((resolve) => {
    try {
      const cp = require('node:child_process').spawn(ff, ['-hide_banner', '-nostats', '-i', inputPath, '-af', 'silencedetect=noise=-35dB:d=1', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      cp.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      cp.on('close', () => {
        // Heuristic: if we see a long single silence period covering most of the file, treat as silent
        const events = (stderr.match(/silence_(start|end):\s*[0-9.]+/g) || []).length;
        const hasSilence = /silence_start:\s*[0-9.]+/.test(stderr);
        resolve(hasSilence && events <= 2);
      });
      cp.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
