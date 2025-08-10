import { parentPort } from 'node:worker_threads';
import type { JobMessage, JobResultMessage } from './types';

if (!parentPort) process.exit(1);

parentPort.on('message', async (msg: JobMessage) => {
  const res: JobResultMessage = { id: msg.id, ok: true, result: { skipped: true } };
  parentPort!.postMessage(res);
});
