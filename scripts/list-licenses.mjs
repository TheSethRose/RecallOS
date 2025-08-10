#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

function print(name) {
  try {
    const pkg = require(`${name}/package.json`);
    console.log(`${name}: ${pkg.license || pkg.licenses || 'UNKNOWN'}`);
  } catch (e) {
    console.log(`${name}: UNKNOWN`);
  }
}

console.log('Bundled binaries/licenses:');
['ffmpeg-static', 'electron', 'better-sqlite3'].forEach(print);
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

try {
  const result = execSync('pnpm ls --depth 1 --json', { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const list = JSON.parse(result);
  const lines = ['# Third-party Licenses', '', 'This is a quick inventory of direct dependencies.'];
  const deps = list[0]?.dependencies || {};
  for (const [name, info] of Object.entries(deps)) {
    const version = info?.version || '';
    const license = info?.license || '';
    lines.push(`- ${name}@${version} — ${license}`);
  }
  const out = lines.join('\n') + '\n';
  writeFileSync(join(process.cwd(), 'third_party_licenses.md'), out, 'utf8');
  console.log('Wrote third_party_licenses.md');
} catch (e) {
  console.error('Failed to list licenses', e);
  process.exit(1);
}
