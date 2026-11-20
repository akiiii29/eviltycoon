/**
 * Uniform-grid spatial hash for range queries (TECH_SPEC §10). Derived, per-tick data: it is never stored in
 * the World or a save; systems rebuild it from the entity arrays when they need it.
 *
 * Items are identified by a caller-chosen non-negative integer (the entity's index in its world array).
 * Queries return ids in ascending order, so a caller that scans the result reproduces the visiting order (and
 * therefore the tie-breaking) of a plain linear scan over that array.
 */

/** Cell edge in world units (TECH_SPEC §10: 4×4). */
export const SPATIAL_CELL_SIZE = 4;

/**
 * Query boxes are padded by this much so a float rounding difference between `x ± r` and the caller's own
 * distance test can never drop an item the caller would accept. Padding only adds candidates.
 */
const PAD = 1e-6;

/** Cell coordinates are packed into one safe integer: |cx|, |cy| < 2^20 cells. */
const OFFSET = 1 << 20;
const SPAN = 1 << 21;

function cellKey(cx: number, cy: number): number {
  return (cx + OFFSET) * SPAN + (cy + OFFSET);
}

export class SpatialHash {
  readonly cellSize: number;
  private buckets = new Map<number, number[]>();
  /** Per id: cell key (undefined = not inserted) and stored position. */
  private keys: (number | undefined)[] = [];
  private xs: number[] = [];
  private ys: number[] = [];
  private count = 0;

  constructor(cellSize = SPATIAL_CELL_SIZE) {
    if (!(cellSize > 0)) throw new Error(`bad cell size ${cellSize}`);
    this.cellSize = cellSize;
  }

  get size(): number {
    return this.count;
  }

  private cell(v: number): number {
    return Math.floor(v / this.cellSize);
  }

  clear(): void {
    this.buckets.clear();
    this.keys.length = 0;
    this.xs.length = 0;
    this.ys.length = 0;
    this.count = 0;
  }

  has(id: number): boolean {
    return this.keys[id] !== undefined;
  }

  private addToBucket(key: number, id: number): void {
    const b = this.buckets.get(key);
    if (b) b.push(id);
    else this.buckets.set(key, [id]);
  }

  private removeFromBucket(key: number, id: number): void {
    const b = this.buckets.get(key)!;
    b.splice(b.indexOf(id), 1);
    if (b.length === 0) this.buckets.delete(key);
  }

  insert(id: number, x: number, y: number): void {
    if (!Number.isInteger(id) || id < 0) throw new Error(`bad spatial id ${id}`);
    if (this.keys[id] !== undefined) throw new Error(`spatial id ${id} already inserted`);
    const key = cellKey(this.cell(x), this.cell(y));
    this.addToBucket(key, id);
    this.keys[id] = key;
    this.xs[id] = x;
    this.ys[id] = y;
    this.count++;
  }

  remove(id: number): boolean {
    const key = this.keys[id];
    if (key === undefined) return false;
    this.removeFromBucket(key, id);
    this.keys[id] = undefined;
    this.count--;
    return true;
  }

  /** Update an item's position (inserts it if absent). Only touches buckets when the cell changes. */
  move(id: number, x: number, y: number): void {
    const old = this.keys[id];
    if (old === undefined) return this.insert(id, x, y);
    const key = cellKey(this.cell(x), this.cell(y));
    if (key !== old) {
      this.removeFromBucket(old, id);
      this.addToBucket(key, id);
      this.keys[id] = key;
    }
    this.xs[id] = x;
    this.ys[id] = y;
  }

  /**
   * Every id in a cell overlapping the (padded) square of half-side r around (x, y), ascending. A superset of
   * the items within distance r: callers keep their own exact distance test.
   */
  candidates(x: number, y: number, r: number, out: number[] = []): number[] {
    out.length = 0;
    const lx = x - r - PAD, hx = x + r + PAD, ly = y - r - PAD, hy = y + r + PAD;
    const x0 = this.cell(lx), x1 = this.cell(hx);
    const y0 = this.cell(ly), y1 = this.cell(hy);
    // Few items relative to the cells the box covers: a bounding-box scan of the items is cheaper than the
    // bucket lookups, and already ascending. Same contract (superset of the radius, ascending).
    if (this.count <= (x1 - x0 + 1) * (y1 - y0 + 1)) {
      const keys = this.keys, xs = this.xs, ys = this.ys;
      for (let id = 0; id < keys.length; id++) {
        if (keys[id] === undefined) continue;
        const px = xs[id]!, py = ys[id]!;
        if (px >= lx && px <= hx && py >= ly && py <= hy) out.push(id);
      }
      return out;
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const b = this.buckets.get(cellKey(cx, cy));
        if (b) for (let i = 0; i < b.length; i++) out.push(b[i]!);
      }
    }
    if (out.length > 1) out.sort((a, b) => a - b);
    return out;
  }

  /** Ids whose stored position is within distance r (inclusive) of (x, y), ascending. */
  queryRadius(x: number, y: number, r: number, out: number[] = []): number[] {
    this.candidates(x, y, r, out);
    let n = 0;
    for (let i = 0; i < out.length; i++) {
      const id = out[i]!;
      if (Math.hypot(this.xs[id]! - x, this.ys[id]! - y) <= r) out[n++] = id;
    }
    out.length = n;
    return out;
  }
}
