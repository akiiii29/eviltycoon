/** CLI: validate config/*.json (schema, ids, refs). Exit code 1 on any issue. Usage: npm run config:check */
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { validateConfig, type RawConfig } from '../src/core/config/load';

export function readConfigDir(dir: string): RawConfig {
  const raw: Record<string, unknown> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    raw[basename(f, '.json')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  }
  return raw as RawConfig;
}

const dir = join(process.cwd(), 'config');
const issues = validateConfig(readConfigDir(dir));
if (issues.length) {
  console.error(`config: ${issues.length} issue(s)`);
  for (const i of issues) console.error(`  ${i.path}: ${i.message}`);
  process.exit(1);
}
console.log('config: OK');
