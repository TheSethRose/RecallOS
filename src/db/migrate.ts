import { detectSqlFeatures } from './sqlite';

type DB = any;

function exec(db: DB, sql: string): void {
  try {
    const stmt = db.prepare ? db.prepare(sql) : null;
    if (stmt && stmt.run) {
      stmt.run();
      return;
    }
  } catch {}
  if (db.exec) {
    try { db.exec(sql); } catch {}
  }
}

export function runMigrations(db: DB): { applied: string[] } {
  exec(db, `CREATE TABLE IF NOT EXISTS __migrations(
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const appliedSet = new Set<string>();
  try {
    const rows = db.prepare('SELECT name FROM __migrations').all() as Array<{ name: string }>;
    rows.forEach(r => appliedSet.add(r.name));
  } catch {}

  const features = detectSqlFeatures();

  const migrations: Array<{ name: string; sql: string | string[] } > = [];

  // 0001 - core tables
  migrations.push({ name: '0001_core_tables', sql: [
    `CREATE TABLE IF NOT EXISTS media_chunks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      type TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      codec TEXT,
      width INTEGER,
      height INTEGER,
      sample_rate INTEGER,
      channel_layout TEXT,
      sha256 TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS ocr_blocks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER NOT NULL,
      ts_ms INTEGER NOT NULL,
      text TEXT NOT NULL,
      bbox_x INTEGER,
      bbox_y INTEGER,
      bbox_w INTEGER,
      bbox_h INTEGER,
      confidence REAL,
      FOREIGN KEY(chunk_id) REFERENCES media_chunks(id)
    )`,
    `CREATE TABLE IF NOT EXISTS transcripts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER NOT NULL,
      ts_ms INTEGER NOT NULL,
      speaker TEXT,
      text TEXT NOT NULL,
      confidence REAL,
      FOREIGN KEY(chunk_id) REFERENCES media_chunks(id)
    )`,
    `CREATE TABLE IF NOT EXISTS apps(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bundle_or_exe TEXT NOT NULL,
      display_name TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS activity_segments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER,
      window_title TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      FOREIGN KEY(app_id) REFERENCES apps(id)
    )`,
    `CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      location TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      source TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
    // indices
    `CREATE INDEX IF NOT EXISTS idx_media_chunks_started_at ON media_chunks(started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_ocr_blocks_chunk_ts ON ocr_blocks(chunk_id, ts_ms)`,
    `CREATE INDEX IF NOT EXISTS idx_transcripts_chunk_ts ON transcripts(chunk_id, ts_ms)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_segments_app ON activity_segments(app_id, started_at)`
  ]});

  // 0002 - FTS5 virtual table and triggers (gated by feature)
  if (features.fts5) {
    migrations.push({ name: '0002_fts5', sql: [
      `CREATE VIRTUAL TABLE IF NOT EXISTS fts_content USING fts5(content, type, chunk_id, ts_ms)`,
      `CREATE TRIGGER IF NOT EXISTS ocr_to_fts AFTER INSERT ON ocr_blocks BEGIN
        INSERT INTO fts_content(rowid, content, type, chunk_id, ts_ms)
        VALUES (new.id, new.text, 'ocr', new.chunk_id, new.ts_ms);
      END`,
      `CREATE TRIGGER IF NOT EXISTS transcript_to_fts AFTER INSERT ON transcripts BEGIN
        INSERT INTO fts_content(rowid, content, type, chunk_id, ts_ms)
        VALUES (new.id, new.text, 'transcript', new.chunk_id, new.ts_ms);
      END`
    ]});
  }

  // 0003 - jobs table for background processing
  migrations.push({ name: '0003_jobs', sql: `
    CREATE TABLE IF NOT EXISTS jobs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER
    )
  `});

  // 0004 - jobs scheduling: next_run_at for delays/backoff + index
  migrations.push({ name: '0004_jobs_next_run', sql: [
    `ALTER TABLE jobs ADD COLUMN next_run_at INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_status_next_run ON jobs(status, next_run_at, created_at)`
  ]});

  const applied: string[] = [];
  for (const m of migrations) {
    if (appliedSet.has(m.name)) continue;
    const statements = Array.isArray(m.sql) ? m.sql : [m.sql];
    for (const s of statements) exec(db, s);
    try {
      db.prepare('INSERT INTO __migrations(name, applied_at) VALUES(?, strftime("%Y-%m-%dT%H:%M:%fZ", "now"))').run(m.name);
    } catch {}
    applied.push(m.name);
  }

  return { applied };
}
