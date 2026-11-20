/**
 * Deterministic, serializable PRNG (sfc32). Core code must use this instead of Math.random.
 */
export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

export class Rng {
  private s: RngState;

  constructor(seedOrState: number | RngState) {
    if (typeof seedOrState === 'number') {
      const seed = seedOrState >>> 0;
      this.s = { a: 0x9e3779b9, b: 0x243f6a88, c: 0xb7e15162, d: seed };
      for (let i = 0; i < 15; i++) this.nextU32(); // warm up
    } else {
      this.s = { ...seedOrState };
    }
  }

  get state(): RngState {
    return { ...this.s };
  }

  nextU32(): number {
    const s = this.s;
    const t = (((s.a + s.b) | 0) + s.d) | 0;
    s.d = (s.d + 1) | 0;
    s.a = s.b ^ (s.b >>> 9);
    s.b = (s.c + (s.c << 3)) | 0;
    s.c = (s.c << 21) | (s.c >>> 11);
    s.c = (s.c + t) | 0;
    return t >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick on empty array');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Pick by weight; weights must be >= 0 with a positive sum. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T {
    let total = 0;
    for (const it of items) total += weight(it);
    if (!(total > 0)) throw new Error('Rng.weighted needs a positive total weight');
    let r = this.next() * total;
    for (const it of items) {
      r -= weight(it);
      if (r < 0) return it;
    }
    return items[items.length - 1] as T;
  }
}
