import type { GameConfig, MapNode } from './config/types';
import type { Vec2 } from './world';

interface Edge {
  to: string;
  length: number;
  road: boolean;
}

/**
 * Waypoint graph + A* (TECH_SPEC §6). Cost = length / speed multiplier, so roads are preferred.
 * Built once per config; paths are cached per (from, to) pair.
 */
export class NavGraph {
  private adj = new Map<string, Edge[]>();
  private nodes: Map<string, MapNode>;
  private cache = new Map<string, string[] | null>();
  private roadMul: number;
  /** Candidates of `nearest` without `among`: every node except the portal (a destination only, TECH_SPEC §5.13). */
  private snapIds: string[];

  constructor(config: GameConfig) {
    this.nodes = config.index.nodes;
    this.snapIds = config.nodes.filter((n) => n.kind !== 'portal').map((n) => n.id);
    this.roadMul = config.formula.roadSpeedMul;
    for (const n of config.nodes) this.adj.set(n.id, []);
    for (const e of config.edges) {
      const a = this.nodes.get(e.a)!, b = this.nodes.get(e.b)!;
      const length = Math.hypot(a.x - b.x, a.y - b.y);
      this.adj.get(e.a)!.push({ to: e.b, length, road: e.road });
      this.adj.get(e.b)!.push({ to: e.a, length, road: e.road });
    }
  }

  node(id: string): MapNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  edge(a: string, b: string): Edge | undefined {
    return this.adj.get(a)?.find((e) => e.to === b);
  }

  /** Speed multiplier for travelling a→b (road bonus). */
  speedMul(a: string, b: string): number {
    return this.edge(a, b)?.road ? this.roadMul : 1;
  }

  /**
   * Nearest node to a position, optionally restricted to a set of ids. Ties break by id order for determinism.
   * Without `among` the portal node is never returned (paths start at the square for a hunter leaving the portal),
   * so adding the portal leaf to the map does not change any other path.
   */
  nearest(p: Vec2, among?: readonly string[]): string {
    let best = '', bestD = Infinity;
    const ids = among ?? this.snapIds;
    for (const id of ids) {
      const n = this.nodes.get(id)!;
      const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  /** Node ids from `from` to `to`, both inclusive. Null if unreachable. */
  path(from: string, to: string): string[] | null {
    if (from === to) return [from];
    const key = `${from}|${to}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit ? [...hit] : null;

    const goal = this.node(to);
    const h = (id: string) => {
      const n = this.nodes.get(id)!;
      return Math.hypot(n.x - goal.x, n.y - goal.y) / this.roadMul; // admissible: never overestimates
    };
    const g = new Map<string, number>([[from, 0]]);
    const came = new Map<string, string>();
    const open: { id: string; f: number }[] = [{ id: from, f: h(from) }];
    const closed = new Set<string>();
    let result: string[] | null = null;

    while (open.length) {
      // Small graphs: linear scan beats a heap. Tie-break by id for determinism.
      let bi = 0;
      for (let i = 1; i < open.length; i++) {
        const o = open[i]!, b = open[bi]!;
        if (o.f < b.f || (o.f === b.f && o.id < b.id)) bi = i;
      }
      const cur = open.splice(bi, 1)[0]!;
      if (cur.id === to) {
        result = [to];
        let c = to;
        while (came.has(c)) { c = came.get(c)!; result.push(c); }
        result.reverse();
        break;
      }
      if (closed.has(cur.id)) continue;
      closed.add(cur.id);
      for (const e of this.adj.get(cur.id)!) {
        if (closed.has(e.to)) continue;
        const ng = g.get(cur.id)! + e.length / (e.road ? this.roadMul : 1);
        if (ng < (g.get(e.to) ?? Infinity)) {
          g.set(e.to, ng);
          came.set(e.to, cur.id);
          open.push({ id: e.to, f: ng + h(e.to) });
        }
      }
    }
    this.cache.set(key, result);
    return result ? [...result] : null;
  }
}
