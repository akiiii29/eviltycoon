import { ConfigError, loadConfig, validateConfig } from '../src/core/config/load';
import { shopMarkdownSteps, shopScrapAgeSec } from '../src/core/systems/crafting';
import { readRawConfig } from './helpers';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('config', () => {
  it('shipped config is valid and indexed', () => {
    const c = loadConfig(readRawConfig());
    expect(c.classes.length).toBe(5);
    expect(c.index.classes.get('class.vanguard')).toBeDefined();
    expect(c.formula.tickMs).toBeUndefined(); // tick rate is code, not data
  });

  it('reports duplicate ids, bad refs, wrong types and unknown fields with paths', () => {
    const raw = clone(readRawConfig()) as Record<string, any>;
    raw.class[1].id = raw.class[0].id;
    raw.class[2].nameKey = 'missing.key';
    raw.class[3].attackSpeed = 'fast';
    raw.class[4].extra = 1;
    const paths = validateConfig(raw as any).map((i) => `${i.path}: ${i.message}`);
    expect(paths).toContain('class[1].id: duplicate id "class.vanguard"');
    expect(paths).toContain('class[2].nameKey: unknown loc id "missing.key"');
    expect(paths).toContain('class[3].attackSpeed: expected number');
    expect(paths).toContain('class[4].extra: unknown field');
  });

  it('checks fixed array lengths and min<=max ranges', () => {
    const raw = clone(readRawConfig()) as Record<string, any>;
    raw.class[0].statRanges.hp = [[1, 2], [3, 4]];
    raw.class[1].statRanges.atk[0] = [10, 5];
    const msgs = validateConfig(raw as any).map((i) => `${i.path}: ${i.message}`);
    expect(msgs).toContain('class[0].statRanges.hp: expected length 3, got 2');
    expect(msgs).toContain('class[1].statRanges.atk[0]: min > max');
  });

  it('requires formula keys and stat grade chances summing to 1', () => {
    const raw = clone(readRawConfig()) as Record<string, any>;
    delete raw.formula_params.hunterSlots;
    raw.formula_params.typo = 'x';
    raw.stat_grade[0].rollChance = 0.5;
    const msgs = validateConfig(raw as any).map((i) => i.path);
    expect(msgs).toContain('formula_params.hunterSlots');
    expect(msgs).toContain('formula_params.typo');
    expect(msgs).toContain('stat_grade');
  });

  it('shop markdown schedule: floor must be reachable before scrapping; old shopScrapSec is rejected', () => {
    const shipped = loadConfig(readRawConfig()).formula;
    expect(shopScrapAgeSec(shipped)).toBe(shopMarkdownSteps(shipped) * shipped.shopStaleSec + shipped.shopFloorHoldSec);
    expect(shopMarkdownSteps(shipped)).toBeGreaterThan(0);
    const raw = clone(readRawConfig()) as Record<string, any>;
    raw.formula_params.shopMarkdownPct = 0; // never marked down: the floor is unreachable
    raw.formula_params.shopStaleSec = 0;
    raw.formula_params.shopMarkdownFloor = 0;
    raw.formula_params.shopScrapSec = 1800;
    const msgs = validateConfig(raw as any).map((i) => `${i.path}: ${i.message}`);
    expect(msgs).toContain('formula_params.shopMarkdownPct: expected 0.000001..100');
    expect(msgs).toContain('formula_params.shopStaleSec: expected 1..1000000');
    expect(msgs).toContain('formula_params.shopMarkdownFloor: expected 0.01..1');
    expect(msgs.some((m) => m.startsWith('formula_params.shopScrapSec: removed'))).toBe(true);
  });

  it('loadConfig throws ConfigError listing issues', () => {
    const raw = clone(readRawConfig()) as Record<string, any>;
    delete raw.meta;
    expect(() => loadConfig(raw as any)).toThrow(ConfigError);
  });
});
