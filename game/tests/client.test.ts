import { SKILL_LOG_WINDOW_TICKS, SkillCastLog } from '../src/client/debugOverlay';
import { zoneColor } from '../src/client/render';
import { testConfig } from './helpers';

const config = testConfig();

describe('debug overlay: skillCast log is aggregated (TODO §5)', () => {
  it('one line per window, counting casts, targets and the top hunters', () => {
    const log = new SkillCastLog();
    const out: string[] = [];
    for (let t = 0; t < SKILL_LOG_WINDOW_TICKS; t++) out.push(...log.add(100 + t, t % 3 === 0 ? 'h1' : 'h2', t === 0 ? 3 : 1));
    expect(out).toEqual([]); // still inside the first window
    out.push(...log.advance(100 + SKILL_LOG_WINDOW_TICKS - 1));
    expect(out).toEqual([]);
    out.push(...log.advance(100 + SKILL_LOG_WINDOW_TICKS));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(`#100 kỹ năng ×50 (52 mục tiêu, 5s): h2 ×33, h1 ×17`);
    expect(log.advance(10_000)).toEqual([]); // nothing open
  });

  it('a tick going backwards (Load / Reset) closes the open window; many hunters are summarised', () => {
    const log = new SkillCastLog();
    for (const id of ['a', 'b', 'c', 'd', 'e']) log.add(500, id, 1);
    const lines = log.add(3, 'a', 1);
    expect(lines).toEqual(['#500 kỹ năng ×5 (5 mục tiêu, 5s): a ×1, b ×1, c ×1 +2 hunter']);
  });
});

describe('renderer: every zone has its own ground colour (TODO §5)', () => {
  it('distinct per zone and not the Town ground / background', () => {
    const colors = config.zones.map((z) => zoneColor(config, z.id));
    expect(new Set(colors).size).toBe(config.zones.length);
    for (const c of colors) expect([0x4f6b45, 0x2b3a2e]).not.toContain(c);
    expect(typeof zoneColor(config, 'zone.unknown')).toBe('number');
  });
});
