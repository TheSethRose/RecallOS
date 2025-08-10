import { createHash } from 'node:crypto';
import { mkdirSync, createReadStream, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

export function ensureParentDir(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

export function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const rs = createReadStream(path);
    rs.on('data', (c) => hash.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function verifyOrWriteChecksum(filePath: string, checksumFile: string): Promise<boolean> {
  const sum = await sha256File(filePath);
  const expected = readChecksum(checksumFile);
  if (!expected) {
    await writeChecksum(checksumFile, sum);
    return true; // First run: record checksum for integrity on subsequent runs
  }
  return expected.trim() === sum;
}

export function readChecksum(checksumFile: string): string | null {
  try {
    const { readFileSync } = require('node:fs');
    return readFileSync(checksumFile, 'utf8');
  } catch {
    return null;
  }
}

export async function writeChecksum(checksumFile: string, sum: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  ensureParentDir(checksumFile);
  await writeFile(checksumFile, sum, 'utf8');
}

export async function downloadWithResume(
  url: string,
  dest: string,
  onProgress?: (received: number, total?: number) => void,
  extraHeaders?: Record<string, string>
): Promise<void> {
  const partial = fileExists(dest) ? fileSize(dest) ?? 0 : 0;
  const headers: Record<string, string> = { ...(extraHeaders || {}) };
  if (partial > 0) headers['Range'] = `bytes=${partial}-`;
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') || 0) + partial;
  const stream = res.body as unknown as ReadableStream<Uint8Array>;
  ensureParentDir(dest);
  const fh = await (await import('node:fs/promises')).open(dest, 'a');
  const writer = fh.createWriteStream();
  let received = partial;
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        writer.write(Buffer.from(value));
        received += value.byteLength;
        if (onProgress) onProgress(received, total || undefined);
      }
    }
  } finally {
    writer.end();
    await fh.close();
  }
}
