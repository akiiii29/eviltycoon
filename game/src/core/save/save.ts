import { WORLD_SCHEMA_VERSION, type World } from '../world';
import { MIGRATIONS } from './migrations';

export const SAVE_FORMAT = 'town-hunter-save';

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  schemaVersion: number;
  configVersion: string;
  savedAt: number;
  world: World;
}

export class SaveError extends Error {
  override name = 'SaveError';
}

export function serialize(world: World, savedAt: number): string {
  const file: SaveFile = {
    format: SAVE_FORMAT,
    schemaVersion: world.schemaVersion,
    configVersion: world.configVersion,
    savedAt,
    world,
  };
  return JSON.stringify(file);
}

export interface LoadResult {
  world: World;
  savedAt: number;
  migratedFrom: number | null;
  /** True when the save was made with a different config version (data may need re-tuning). */
  configChanged: boolean;
}

export function deserialize(text: string, currentConfigVersion: string): LoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SaveError('save is not valid JSON');
  }
  const file = parsed as Partial<SaveFile>;
  if (file?.format !== SAVE_FORMAT) throw new SaveError('not a save file');
  if (typeof file.schemaVersion !== 'number' || typeof file.world !== 'object' || file.world === null) {
    throw new SaveError('save is missing schemaVersion or world');
  }
  if (file.schemaVersion > WORLD_SCHEMA_VERSION) {
    throw new SaveError(`save schema v${file.schemaVersion} is newer than this build (v${WORLD_SCHEMA_VERSION})`);
  }

  let world = file.world as unknown as Record<string, unknown>;
  let v = file.schemaVersion;
  const from = v;
  while (v < WORLD_SCHEMA_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) throw new SaveError(`no migration from schema v${v}`);
    world = m(world);
    v += 1;
    world.schemaVersion = v;
  }

  const w = world as unknown as World;
  return {
    world: w,
    savedAt: typeof file.savedAt === 'number' ? file.savedAt : 0,
    migratedFrom: from === WORLD_SCHEMA_VERSION ? null : from,
    configChanged: w.configVersion !== currentConfigVersion,
  };
}
