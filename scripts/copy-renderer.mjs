import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'src', 'renderer');
const dest = join(root, 'dist', 'renderer');

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`Copied renderer assets to ${dest}`);
