import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig, type RawConfig } from '../src/core/config/load';
import type { GameConfig } from '../src/core/config/types';

export function readRawConfig(): RawConfig {
  const dir = join(__dirname, '..', 'config');
  const raw: Record<string, unknown> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    raw[basename(f, '.json')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  }
  return raw as RawConfig;
}

export function testConfig(): GameConfig {
  return loadConfig(readRawConfig());
}
