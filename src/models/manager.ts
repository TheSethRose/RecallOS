import { join } from 'node:path';
import { downloadWithResume, ensureDir, fileExists, verifyOrWriteChecksum } from '../util/file';

export interface ModelEnsureResult {
  name: string;
  path: string | null;
  status: 'ok' | 'downloaded' | 'missing' | 'error';
  error?: string;
}

export interface WhisperModelSpec {
  name: string; // e.g., ggml-base.en.bin
  url: string; // direct download URL
  checksum?: string; // optional pre-known checksum
}

const DEFAULT_WHISPER_MODEL: WhisperModelSpec = {
  name: 'ggml-base.en.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true',
};

const MODEL_URLS: Record<string, string> = {
  'ggml-tiny.en.bin': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin?download=true',
  'ggml-base.en.bin': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true',
  'ggml-small.en.bin': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin?download=true',
  'ggml-medium.en.bin': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin?download=true',
};

export async function ensureWhisperModelByName(name: string, modelsDir = process.env.MODELS_DIR || join(process.cwd(), 'models')): Promise<ModelEnsureResult> {
  const url = MODEL_URLS[name];
  if (!url) {
    return { name, path: null, status: 'error', error: 'unknown-model' };
  }
  ensureDir(modelsDir);
  const outPath = join(modelsDir, name);
  const checksumFile = outPath + '.sha256';
  try {
    if (!fileExists(outPath)) {
      await downloadWithResume(url, outPath, (r, t) => {
        if (t) {
          const pct = ((r / t) * 100).toFixed(1);
          process.stdout.write(`\rDownloading ${name}: ${pct}%`);
        } else {
          process.stdout.write(`\rDownloading ${name}: ${r} bytes`);
        }
      });
      process.stdout.write('\n');
      await verifyOrWriteChecksum(outPath, checksumFile);
      return { name, path: outPath, status: 'downloaded' };
    } else {
      const ok = await verifyOrWriteChecksum(outPath, checksumFile);
      return { name, path: outPath, status: ok ? 'ok' : 'error', error: ok ? undefined : 'Checksum mismatch' };
    }
  } catch (e: any) {
    return { name, path: null, status: 'error', error: e?.message || String(e) };
  }
}

export async function ensureWhisperModel(modelsDir = process.env.MODELS_DIR || join(process.cwd(), 'models')): Promise<ModelEnsureResult> {
  ensureDir(modelsDir);
  const outPath = join(modelsDir, DEFAULT_WHISPER_MODEL.name);
  const checksumFile = outPath + '.sha256';
  try {
    if (!fileExists(outPath)) {
      await downloadWithResume(DEFAULT_WHISPER_MODEL.url, outPath, (r, t) => {
        if (t) {
          const pct = ((r / t) * 100).toFixed(1);
          process.stdout.write(`\rDownloading ${DEFAULT_WHISPER_MODEL.name}: ${pct}%`);
        } else {
          process.stdout.write(`\rDownloading ${DEFAULT_WHISPER_MODEL.name}: ${r} bytes`);
        }
      });
      process.stdout.write('\n');
      // Verify checksum lazily on first run; will write observed checksum
      await verifyOrWriteChecksum(outPath, checksumFile);
      return { name: DEFAULT_WHISPER_MODEL.name, path: outPath, status: 'downloaded' };
    } else {
      const ok = await verifyOrWriteChecksum(outPath, checksumFile);
      return { name: DEFAULT_WHISPER_MODEL.name, path: outPath, status: ok ? 'ok' : 'error', error: ok ? undefined : 'Checksum mismatch' };
    }
  } catch (e: any) {
    return { name: DEFAULT_WHISPER_MODEL.name, path: null, status: 'error', error: e?.message || String(e) };
  }
}
