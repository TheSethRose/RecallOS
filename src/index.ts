import { ensureAllBinaries } from './bin/manager';
import { ensureWhisperModel } from './models/manager';
import { ensureTesseractLang } from './ocr/lang';

async function main() {
  const results = await ensureAllBinaries();
  // Minimal smoke log; no UI yet
  console.log('Binary check results:', results);
  const modelRes = await ensureWhisperModel();
  console.log('Model ensure:', modelRes);
  const langRes = await ensureTesseractLang('eng');
  console.log('Tesseract lang ensure:', langRes);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
