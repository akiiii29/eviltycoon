import { Rng } from '../src/core/rng';

describe('Rng', () => {
  it('is deterministic for a seed', () => {
    const a = new Rng(42), b = new Rng(42);
    const xs = Array.from({ length: 100 }, () => a.nextU32());
    const ys = Array.from({ length: 100 }, () => b.nextU32());
    expect(xs).toEqual(ys);
    expect(new Rng(43).nextU32()).not.toBe(xs[0]);
  });

  it('resumes exactly from serialized state', () => {
    const a = new Rng(7);
    for (let i = 0; i < 50; i++) a.next();
    const b = new Rng(JSON.parse(JSON.stringify(a.state)));
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(Array.from({ length: 20 }, () => a.next()));
  });

  it('keeps int() inside bounds and hits both ends', () => {
    const r = new Rng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(3, 6);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it('weighted() follows weights roughly', () => {
    const r = new Rng(9);
    const items = [{ k: 'a', w: 1 }, { k: 'b', w: 3 }, { k: 'z', w: 0 }];
    const n = { a: 0, b: 0, z: 0 } as Record<string, number>;
    for (let i = 0; i < 8000; i++) n[r.weighted(items, (x) => x.w).k]! += 1;
    expect(n.z).toBe(0);
    expect(n.b! / n.a!).toBeGreaterThan(2.6);
    expect(n.b! / n.a!).toBeLessThan(3.4);
  });
});
