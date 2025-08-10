import Database from 'better-sqlite3';

export interface SqlFeatures {
  fts5: boolean;
  sqlcipher: boolean;
  cipherVersion?: string | null;
}

export function detectSqlFeatures(): SqlFeatures {
  let tmp: any = null;
  try {
    tmp = new (Database as any)(':memory:');
  } catch (e: any) {
    // Native binding missing or failed to load; return safe defaults
    return { fts5: false, sqlcipher: false, cipherVersion: null };
  }
  let fts5 = false;
  let sqlcipher = false;
  let cipherVersion: string | null = null;
  try {
    const rows = tmp.prepare('PRAGMA compile_options;').all() as Array<{ compile_options: string } | Record<string, string>>;
    const opts = rows.map((r: any) => Object.values(r)[0] as string);
    fts5 = opts.some((o) => /FTS5/i.test(o));
  } catch {}
  try {
    const r = tmp.prepare('PRAGMA cipher_version;').get() as any;
    const v = r ? (r.cipher_version ?? Object.values(r)[0]) : null;
    if (v && typeof v === 'string' && v.length > 0) {
      sqlcipher = true;
      cipherVersion = v;
    }
  } catch {}
  try { (tmp as any).close(); } catch {}
  return { fts5, sqlcipher, cipherVersion };
}

export interface OpenEncryptedOptions {
  filePath: string;
  passphrase: string;
}

export function openEncryptedDatabase(opts: OpenEncryptedOptions) {
  const db = new Database(opts.filePath);
  try {
    db.pragma(`key='${opts.passphrase.replace(/'/g, "''")}'`);
  } catch {}
  return db;
}
