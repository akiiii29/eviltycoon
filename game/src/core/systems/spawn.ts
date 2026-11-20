import type { System, SystemContext } from '../system';
import type { ZoneDef } from '../config/types';

function spawnMonster(ctx: SystemContext, z: ZoneDef): void {
  const { world, config, rng, nav } = ctx;
  const entry = rng.weighted(z.monsters, (m) => m.weight);
  const def = config.index.monsters.get(entry.monsterId)!;
  const node = nav.node(rng.pick(config.index.zoneNodes.get(z.id)!));
  const home = { x: node.x + rng.range(-4, 4), y: node.y + rng.range(-4, 4) };
  world.monsters.push({
    id: `m${world.nextId++}`,
    defId: def.id,
    zoneId: z.id,
    hp: def.hp * (config.index.difficulties.get(world.town.difficulty)?.monsterHpMul ?? 1),
    position: { ...home },
    home,
    targetHunterId: null,
    attackCdMs: def.attackSpeed * 1000,
    difficultyId: world.town.difficulty,
  });
}

/** Keeps each zone populated up to its cap; the first visit fills it immediately. */
export const spawnSystem: System = {
  name: 'spawn',
  update(ctx) {
    const { world, config, dtMs } = ctx;
    for (const z of config.zones) {
      const count = world.monsters.reduce((n, m) => n + (m.zoneId === z.id ? 1 : 0), 0);
      let state = world.zones[z.id];
      if (!state) {
        state = world.zones[z.id] = { respawnMs: z.respawnSec * 1000 };
        for (let i = count; i < z.monsterCap; i++) spawnMonster(ctx, z);
        continue;
      }
      if (count >= z.monsterCap) {
        state.respawnMs = z.respawnSec * 1000;
        continue;
      }
      state.respawnMs -= dtMs;
      if (state.respawnMs <= 0) {
        spawnMonster(ctx, z);
        state.respawnMs = z.respawnSec * 1000;
      }
    }
  },
};
