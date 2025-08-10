import { join } from 'node:path';
import Database from 'better-sqlite3';
// Note: Avoid strict typing of better-sqlite3 instance to keep TS simple across environments
import { ensureParentDir } from '../util/file';
import { openEncryptedDatabase as openCipherDb, SqlcipherNotLinkedError } from './sqlcipher';
import { detectSqlFeatures } from './sqlite';

export interface AppDb {
  db: any;
  encrypted: boolean;
  cipherVersion?: string;
  path: string;
}

/**
 * Open the application database. If SQLCipher is linked, use encrypted mode with passphrase.
 * Otherwise, open a plain SQLite DB.
 * Passphrase source: RECALLOS_PASSPHRASE env var (temporary until first-run wizard).
 */
export function openAppDatabase(baseDir: string): AppDb {
  const dbPath = join(baseDir, 'recallos.sqlite3');
  ensureParentDir(dbPath);

  const features = detectSqlFeatures();
  const pass = process.env.RECALLOS_PASSPHRASE;

  if (features.sqlcipher && pass && pass.length > 0) {
    try {
      const { db, info } = openCipherDb(dbPath, pass, { journalMode: 'WAL' });
      return { db, encrypted: true, cipherVersion: info.cipherVersion, path: dbPath };
    } catch (e) {
      if (!(e instanceof SqlcipherNotLinkedError)) throw e;
      // fall through to plain open
    }
  }

  try {
    const db = new (Database as any)(dbPath);
    try { db.pragma('journal_mode = WAL'); } catch {}
    return { db, encrypted: false, path: dbPath };
  } catch (e: any) {
    // Provide a no-op DB stub so the app can continue without persistence
    const stub = {
      pragma: () => undefined,
      prepare: () => ({ run: () => undefined, get: () => undefined, all: () => [] as any[] }),
      close: () => undefined,
    };
    return { db: stub, encrypted: false, path: dbPath };
  }
}
