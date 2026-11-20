import type { RawConfig } from '../core/config/load';

/** Bundles every config/*.json at build time; table name = file name. */
const files = import.meta.glob('../../config/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

export function rawConfigFromBundle(): RawConfig {
  const raw: Record<string, unknown> = {};
  for (const [path, data] of Object.entries(files)) {
    const name = path.split('/').pop()!.replace(/\.json$/, '');
    raw[name] = data;
  }
  return raw as RawConfig;
}
