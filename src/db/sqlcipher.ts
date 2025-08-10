import Database from 'better-sqlite3';
import { ensureParentDir } from '../util/file';

export interface OpenDbOptions {
  journalMode?: 'WAL' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'OFF';
  kdfIterations?: number; // sqlcipher_default_kdf_iter
  kdfAlgorithm?: 'PBKDF2_HMAC_SHA1' | 'PBKDF2_HMAC_SHA256' | 'PBKDF2_HMAC_SHA512';
  pageSize?: 1024 | 2048 | 4096 | 8192;
  cipher?: 'aes-256-cbc' | 'aes-256-gcm' | 'chacha20';
}

export interface SqlcipherInfo {
  cipherVersion: string;
}

export class SqlcipherNotLinkedError extends Error {
  constructor(message = 'better-sqlite3 is not linked against SQLCipher') {
    super(message);
    this.name = 'SqlcipherNotLinkedError';
  }
}

/**
 * Contract:
 * - Input: dbPath (string), passphrase (string)
 * - Output: { db, info }
 * - Errors: SqlcipherNotLinkedError if cipher not available; generic Error for other open issues
 */
export function openEncryptedDatabase(dbPath: string, passphrase: string, opts: OpenDbOptions = {}) {
  ensureParentDir(dbPath);
  const db = new Database(dbPath);
  try {
  const envIter = process.env.RECALLOS_SQLCIPHER_KDF_ITER ? parseInt(process.env.RECALLOS_SQLCIPHER_KDF_ITER, 10) : undefined;
  const envAlg = process.env.RECALLOS_SQLCIPHER_KDF_ALG as OpenDbOptions['kdfAlgorithm'] | undefined;
  const envCipher = process.env.RECALLOS_SQLCIPHER_CIPHER as OpenDbOptions['cipher'] | undefined;
  const envPage = process.env.RECALLOS_SQLCIPHER_PAGE ? parseInt(process.env.RECALLOS_SQLCIPHER_PAGE, 10) : undefined;

  const kdfIter = opts.kdfIterations ?? envIter;
  const kdfAlg = opts.kdfAlgorithm ?? envAlg;
  const cipher = opts.cipher ?? envCipher;
  const pageSize = opts.pageSize ?? envPage as any;

  if (pageSize) db.pragma(`page_size = ${pageSize}`);
  if (kdfIter) db.pragma(`kdf_iter = ${kdfIter}`);
  if (kdfAlg) db.pragma(`kdf_alg = ${kdfAlg}`);
  if (cipher) db.pragma(`cipher = '${cipher}'`);
    // Set key. If SQLCipher is not linked, this will not error immediately.
    db.pragma(`key = '${passphrase.replace(/'/g, "''")}'`);
    // Probe cipher version — this will throw if not a SQLCipher build.
    const rows = db.prepare('PRAGMA cipher_version').raw().all();
    const cipherVersion = (rows?.[0]?.[0] as string) || '';
    if (!cipherVersion) {
      db.close();
      throw new SqlcipherNotLinkedError();
    }
    if (opts.journalMode) {
      db.pragma(`journal_mode = ${opts.journalMode}`);
    }
    const info: SqlcipherInfo = { cipherVersion };
    return { db, info } as const;
  } catch (e: any) {
    if ((db as any).open) (db as any).close();
    if (String(e?.message || e).includes('no such pragma: cipher_version')) {
      throw new SqlcipherNotLinkedError();
    }
    throw e;
  }
}
