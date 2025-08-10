import { accessSync, constants } from 'node:fs';
import { delimiter } from 'node:path';

export function which(cmd: string): string | null {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(delimiter)) {
    const candidate = dir.endsWith('/') ? dir + cmd : dir + '/' + cmd;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}
