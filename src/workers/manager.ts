import { Worker } from 'node:worker_threads';
import { join } from 'node:path';

export type WorkerKind = 'ocr' | 'stt' | 'indexer';

export class WorkerManager {
  private workers = new Map<WorkerKind, Worker>();

  constructor(private baseDir: string) {}

  start(kind: WorkerKind) {
    if (this.workers.has(kind)) return this.workers.get(kind)!;
    const file = kind === 'ocr' ? 'ocr.js' : kind === 'stt' ? 'stt.js' : 'indexer.js';
    const w = new Worker(join(this.baseDir, file));
    w.on('error', (e) => {
      console.error(`[worker:${kind}] error`, e);
      this.restart(kind);
    });
    w.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[worker:${kind}] exited with ${code}, restarting`);
        this.restart(kind);
      }
    });
    this.workers.set(kind, w);
    return w;
  }

  restart(kind: WorkerKind) {
    this.stop(kind);
    return this.start(kind);
  }

  stop(kind: WorkerKind) {
    const w = this.workers.get(kind);
    if (w) {
      try { w.terminate(); } catch {}
      this.workers.delete(kind);
    }
  }

  stopAll() {
    for (const k of Array.from(this.workers.keys())) this.stop(k);
  }
}
