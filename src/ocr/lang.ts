import { join } from 'node:path';
import { downloadWithResume, ensureDir, verifyOrWriteChecksum, fileExists } from '../util/file';

const TESSDATA_FAST_BASE = 'https://github.com/tesseract-ocr/tessdata_fast/raw/main';

export interface LangEnsureResult {
  lang: string;
  path: string | null;
  status: 'ok' | 'downloaded' | 'error';
  error?: string;
}

export async function ensureTesseractLang(lang = 'eng', modelsDir = process.env.MODELS_DIR || join(process.cwd(), 'models')): Promise<LangEnsureResult> {
  const tessdataDir = join(modelsDir, 'tessdata');
  ensureDir(tessdataDir);
  const outPath = join(tessdataDir, `${lang}.traineddata`);
  const checksumFile = outPath + '.sha256';
  const url = `${TESSDATA_FAST_BASE}/${lang}.traineddata`;
  try {
    if (!fileExists(outPath)) {
      await downloadWithResume(url, outPath, (r, t) => {
        if (t) process.stdout.write(`\rDownloading ${lang}.traineddata: ${((r / t) * 100).toFixed(1)}%`);
      });
      process.stdout.write('\n');
      await verifyOrWriteChecksum(outPath, checksumFile);
  // Set TESSDATA_PREFIX so Tesseract can find the language pack
  process.env.TESSDATA_PREFIX = tessdataDir;
  return { lang, path: outPath, status: 'downloaded' };
    } else {
  const ok = await verifyOrWriteChecksum(outPath, checksumFile);
  process.env.TESSDATA_PREFIX = tessdataDir;
  return { lang, path: outPath, status: ok ? 'ok' : 'error', error: ok ? undefined : 'Checksum mismatch' };
    }
  } catch (e: any) {
    return { lang, path: null, status: 'error', error: e?.message || String(e) };
  }
}
