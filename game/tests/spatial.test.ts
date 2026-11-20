import { Rng } from '../src/core/rng';
import { SpatialHash } from '../src/core/spatial';

/** Reference: linear scan in index order. */
function brute(pts: ({ x: number; y: number } | null)[], x: number, y: number, r: number): number[] {
  const out: number[] = [];
  pts.forEach((p, i) => { if (p && Math.hypot(p.x - x, p.y - y) <= r) out.push(i); });
  return out;
}

/**
 * candidates() switches between a bucket walk and a bounding-box scan of all items depending on how many
 * items there are; `crowded` adds far-away filler (ids >= 1000) so the bucket walk is the one exercised.
 */
function grid(crowded: boolean): SpatialHash {
  const g = new SpatialHash(4);
  if (crowded) for (let i = 0; i < 400; i++) g.insert(1000 + i, 5000 + i, -5000);
  return g;
}

describe.each([false, true])('SpatialHash (crowded=%s)', (crowded) => {
  it('inserts and answers radius queries in ascending id order', () => {
    const g = grid(crowded);
    // Inserted out of order and spread across cells.
    g.insert(5, 1, 1);
    g.insert(2, 9, 9);
    g.insert(0, 2, 2);
    g.insert(3, -3, 1);
    expect(g.size).toBe(crowded ? 404 : 4);
    expect(g.queryRadius(0, 0, 4)).toEqual([0, 3, 5]);
    expect(g.queryRadius(0, 0, 100)).toEqual([0, 2, 3, 5]);
    expect(g.queryRadius(5000, -5000, 1.5)).toEqual(crowded ? [1000, 1001] : []);
    expect(g.queryRadius(50, 50, 3)).toEqual([]);
  });

  it('candidates are a sorted superset of the exact query', () => {
    const g = grid(crowded);
    g.insert(1, 3.9, 0);
    g.insert(0, 7.9, 0); // in a touched cell, but outside the radius (and the box)
    g.insert(2, 3, 3); // inside the box, outside the radius
    const c = g.candidates(0, 0, 4);
    // Bucket walk returns whole cells; the sparse bounding-box scan trims to the box. Both are supersets.
    expect(c).toEqual(crowded ? [0, 1, 2] : [1, 2]);
    expect(g.queryRadius(0, 0, 4)).toEqual([1]);
  });

  it('handles items exactly on cell edges and the radius boundary (inclusive)', () => {
    const g = grid(crowded);
    g.insert(0, 4, 0); // exactly on the x=4 cell edge
    g.insert(1, 8, 0); // exactly at distance r from (4, 0)... and from (12, 0)
    g.insert(2, 0, 4);
    g.insert(3, -4, -4);
    expect(g.queryRadius(0, 0, 4)).toEqual([0, 2]);
    expect(g.queryRadius(4, 0, 4)).toEqual([0, 1]);
    expect(g.queryRadius(12, 0, 4)).toEqual([1]);
    expect(g.queryRadius(-4, -4, 0)).toEqual([3]);
    // Query box edge lands exactly on a cell boundary.
    expect(g.queryRadius(8, 4, 4)).toEqual([1]);
  });

  it('works with negative and fractional coordinates', () => {
    const g = grid(crowded);
    g.insert(0, -0.0001, -0.0001);
    g.insert(1, -7.99, 3.2);
    g.insert(2, 0.0001, 0.0001);
    expect(g.queryRadius(0, 0, 0.001)).toEqual([0, 2]);
    expect(g.queryRadius(-8, 3, 0.5)).toEqual([1]);
  });

  it('moves items between cells and removes them', () => {
    const g = grid(crowded);
    g.insert(0, 1, 1);
    g.insert(1, 2, 2);
    g.move(0, 30, 30);
    expect(g.queryRadius(0, 0, 5)).toEqual([1]);
    expect(g.queryRadius(30, 30, 1)).toEqual([0]);
    g.move(0, 30.5, 30.5); // same cell: position still updated
    expect(g.queryRadius(31, 31, 0.8)).toEqual([0]);
    expect(g.remove(1)).toBe(true);
    expect(g.remove(1)).toBe(false);
    expect(g.has(1)).toBe(false);
    expect(g.size).toBe(crowded ? 401 : 1);
    expect(g.queryRadius(0, 0, 5)).toEqual([]);
    g.move(7, -1, -1); // move of an absent id inserts it
    expect(g.queryRadius(0, 0, 2)).toEqual([7]);
    g.clear();
    expect(g.size).toBe(0);
    expect(g.queryRadius(0, 0, 1000)).toEqual([]);
  });

  it('rejects duplicate or invalid ids', () => {
    const g = grid(crowded);
    g.insert(0, 0, 0);
    expect(() => g.insert(0, 1, 1)).toThrow();
    expect(() => g.insert(-1, 1, 1)).toThrow();
    expect(() => g.insert(1.5, 1, 1)).toThrow();
    expect(() => new SpatialHash(0)).toThrow();
    expect(() => new SpatialHash(-1)).toThrow();
  });

  it('matches a linear scan (set and order) under random inserts, moves and removes', () => {
    const rng = new Rng(7);
    for (const cell of [1, 4, 7.5]) {
      const g = new SpatialHash(cell);
      const pts: ({ x: number; y: number } | null)[] = [];
      for (let i = 0; i < 200; i++) {
        const p = { x: rng.range(-60, 60), y: rng.range(-60, 60) };
        pts.push(p);
        g.insert(i, p.x, p.y);
      }
      for (let step = 0; step < 400; step++) {
        const i = Math.floor(rng.range(0, 200));
        if (rng.chance(0.2)) {
          if (pts[i]) { g.remove(i); pts[i] = null; }
        } else {
          const p = { x: rng.range(-60, 60), y: rng.range(-60, 60) };
          pts[i] = p;
          g.move(i, p.x, p.y);
        }
        const qx = rng.range(-70, 70), qy = rng.range(-70, 70), r = rng.range(0, 15);
        expect(g.queryRadius(qx, qy, r)).toEqual(brute(pts, qx, qy, r));
      }
    }
  });
});
