import type { GameConfig } from '../config/types';
import { WORLD_SCHEMA_VERSION, type World } from '../world';
import { fillMissingBuildings, fillMissingGearSlots, fillMissingSupply, MIGRATIONS } from './migrations';

export const SAVE_FORMAT = 'town-hunter-save';

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  schemaVersion: number;
  configVersion: string;
  /** Wall-clock ms (Date.now()) of the save = last-active time for offline progress. */
  savedAt: number;
  world: World;
  /*
   * Saves from before TECH_SPEC §9's EHT-style offline rewrite may also carry `offline` (rate samples of the removed
   * hunting estimate). It is ignored on load and no longer written.
   */
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

/** Parse a save and migrate it to the current schema. `config` is the current config (used by migrations and the version check). */
export function deserialize(text: string, config: GameConfig): LoadResult {
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
    world = m(world, config);
    v += 1;
    world.schemaVersion = v;
  }

  // A v9 save from a build without Town buildings (Journey landed first and reserved v8): fill them like v7 → v8 did.
  world = fillMissingBuildings(world, config);
  // A v12 save from a build where v10 → v11 was a placeholder has no supply lines: fill them like v10 → v11 does.
  world = fillMissingSupply(world, config);
  // A v13–v15 save from a build where v12 → v13 was a placeholder still has 3-slot keys: remap like v12 → v13 does.
  world = fillMissingGearSlots(world, config);

  const w = world as unknown as World;
  return {
    world: w,
    savedAt: typeof file.savedAt === 'number' ? file.savedAt : 0,
    migratedFrom: from === WORLD_SCHEMA_VERSION ? null : from,
    configChanged: w.configVersion !== config.version,
  };
}
