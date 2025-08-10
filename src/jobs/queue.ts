import type { JobType } from '../workers/types';

type DB = any;

export interface EnqueueOptions {
  delaySec?: number;
}

export class JobQueue {
  constructor(private db: DB) {}

  enqueue(type: JobType, payload: any, opts: EnqueueOptions = {}): number | null {
    try {
      const delay = Math.max(0, Math.floor(opts.delaySec || 0));
      const nextRun = Math.floor(Date.now() / 1000) + delay;
      const sql = this.hasNextRun()
        ? 'INSERT INTO jobs(type, payload_json, status, attempts, created_at, updated_at, next_run_at) VALUES(?, ?, ?, ?, strftime("%s","now"), NULL, ?)'
        : 'INSERT INTO jobs(type, payload_json, status, attempts, created_at, updated_at) VALUES(?, ?, ?, ?, strftime("%s","now"), NULL)';
      const args = this.hasNextRun()
        ? [type, JSON.stringify(payload), delay > 0 ? 'delayed' : 'queued', 0, nextRun]
        : [type, JSON.stringify(payload), delay > 0 ? 'delayed' : 'queued', 0];
      this.db.prepare?.(sql).run(...args as any);
      const id = this.db.prepare?.('SELECT last_insert_rowid() AS id').get()?.id ?? null;
      return id;
    } catch {
      return null;
    }
  }

  claimNext(maxAttempts = 5): { id: number; type: JobType; payload: any } | null {
    try {
      // Simple claim: pick oldest queued job whose next_run_at is due (or NULL)
      const row = this.db.prepare?.(
        this.hasNextRun()
          ? `SELECT id, type, payload_json FROM jobs WHERE status IN ('queued','delayed') AND (next_run_at IS NULL OR next_run_at <= strftime('%s','now')) AND attempts < ? ORDER BY created_at ASC LIMIT 1`
          : `SELECT id, type, payload_json FROM jobs WHERE status IN ('queued') AND attempts < ? ORDER BY created_at ASC LIMIT 1`
      ).get(maxAttempts);
      if (!row) return null;
      this.db.prepare?.('UPDATE jobs SET status = ?, updated_at = strftime("%s","now") WHERE id = ?').run('running', row.id);
      return { id: row.id, type: row.type, payload: JSON.parse(row.payload_json) };
    } catch {
      return null;
    }
  }

  complete(id: number) {
    try { this.db.prepare?.('DELETE FROM jobs WHERE id = ?').run(id); } catch {}
  }

  fail(id: number, requeue = true) {
    try {
      const r = this.db.prepare?.('SELECT attempts FROM jobs WHERE id = ?').get(id);
      const attempts = (r?.attempts ?? 0) + 1;
      if (!requeue || attempts >= 5) {
        this.db.prepare?.('UPDATE jobs SET status = ?, attempts = ?, updated_at = strftime("%s","now") WHERE id = ?').run('failed', attempts, id);
      } else {
        const delaySec = Math.min(60, 2 ** attempts); // backoff up to 60s
        if (this.hasNextRun()) {
          const nextRun = Math.floor(Date.now() / 1000) + delaySec;
          this.db.prepare?.('UPDATE jobs SET status = ?, attempts = ?, next_run_at = ?, updated_at = strftime("%s","now") WHERE id = ?').run('queued', attempts, nextRun, id);
        } else {
          this.db.prepare?.('UPDATE jobs SET status = ?, attempts = ?, updated_at = strftime("%s","now") WHERE id = ?').run('queued', attempts, id);
        }
      }
    } catch {}
  }

  private hasNextRun(): boolean {
    try {
      const row = this.db.prepare?.("PRAGMA table_info('jobs')").all() as Array<{ name: string }> | undefined;
      return !!row?.some(c => c.name === 'next_run_at');
    } catch { return false; }
  }
}

export async function startProcessor(db: DB, limitConcurrent = 1, tickMs = 1000, handler?: (job: { id: number; type: JobType; payload: any }) => Promise<boolean>): Promise<() => void> {
  const q = new JobQueue(db);
  const active = new Set<number>();
  let stopped = false;

  async function loop() {
    if (stopped) return;
    try {
      // basic backpressure: don't exceed concurrency
      while (active.size < limitConcurrent) {
        const job = q.claimNext();
        if (!job) break;
        active.add(job.id);
        (async () => {
          try {
            const ok = handler ? await handler(job) : true;
            if (ok) q.complete(job.id); else q.fail(job.id, true);
          } catch {
            q.fail(job.id, true);
          } finally {
            active.delete(job.id);
          }
        })();
      }
    } catch {}
    setTimeout(loop, tickMs);
  }

  loop();
  return () => { stopped = true; };
}
