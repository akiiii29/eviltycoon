import * as THREE from 'three';
import type { BuildingDef, BuildingKind, GameConfig, NeedKey } from '../core/config/types';
import type { World } from '../core/world';

/** Screen pixels per low-res pixel; larger = chunkier pixels. */
const PIXEL_SCALE = 3;

const CLASS_COLORS: Record<string, number> = {
  'class.vanguard': 0xd9534f,
  'class.warden': 0xf0ad4e,
  'class.strider': 0x5cb85c,
  'class.arcanist': 0x5bc0de,
  'class.reaver': 0x9b59b6,
};
const MONSTER_COLORS: Record<string, number> = {
  'mon.slime': 0x7ee081, 'mon.boar': 0xa0522d, 'mon.golem': 0x8a8a8a,
  'mon.bogling': 0x9acd32, 'mon.fenstalker': 0x2e8b57, 'mon.cinderimp': 0xff7f3f, 'mon.ashdrake': 0xb22222,
  'mon.rimewolf': 0xe8f4ff, 'mon.icewarden': 0x4fa3e0, 'mon.drownedknight': 0x8fbcd4, 'mon.tidecaller': 0x20b2aa,
  'mon.voidcrawler': 0xd070ff, 'mon.hollowlord': 0xf0e0ff,
};
const SERVICE_COLORS: Record<NeedKey, number> = { hp: 0xe8e8e8, satiety: 0xe0a458, mood: 0xb46bd6, stamina: 0x5b8fd6 };
const KIND_COLORS: Record<Exclude<BuildingKind, 'service'>, number> = {
  tradingPost: 0xd4c34a,
  craft: 0x9c6b4a,
  shop: 0x4ab3a8,
  forge: 0xc8553d,
  academy: 0x6a7fd0,
  townHall: 0xe8d9a8,
  storehouse: 0x8a6d4a,
};

/**
 * Ground tint per zone (placeholder art), roughly by theme and distinct from the Town ground (0x4f6b45), the
 * background (0x2b3a2e) and the roads. Unknown zones get a colour from ZONE_FALLBACK by config order.
 */
const ZONE_COLORS: Record<string, number> = {
  'zone.meadow': 0x5f8f4e, // grass
  'zone.ruins': 0x8a7f6a, // weathered stone
  'zone.marsh': 0x3f6f62, // murky teal
  'zone.crags': 0x7a5a48, // ash-brown rock
  'zone.glacier': 0x9fc4d6, // ice
  'zone.citadel': 0x4f5f86, // sunken slate blue
  'zone.abyss': 0x4a3358, // dark violet
};
const ZONE_FALLBACK = [0xb08a4a, 0x6f8a3a, 0x8a4a5a, 0x4a7a8a, 0x9a6a9a];

export function zoneColor(config: GameConfig, zoneId: string): number {
  const c = ZONE_COLORS[zoneId];
  if (c !== undefined) return c;
  const i = Math.max(0, config.zones.findIndex((z) => z.id === zoneId));
  return ZONE_FALLBACK[i % ZONE_FALLBACK.length]!;
}

/** Monsters spawned under higher difficulties are drawn darker (order 0 = untinted). */
function monsterColor(config: GameConfig, defId: string, difficultyId: string): THREE.Color {
  const c = new THREE.Color(MONSTER_COLORS[defId] ?? 0xc0c0c0);
  const order = config.index.difficulties.get(difficultyId)?.order ?? 0;
  return c.multiplyScalar(Math.max(0.4, 1 - order * 0.15));
}

function buildingColor(b: BuildingDef): number {
  if (b.kind === 'service') return b.need ? SERVICE_COLORS[b.need] : 0xffffff;
  return KIND_COLORS[b.kind] ?? 0xffffff;
}

/**
 * Placeholder render (M1): pixel pipeline (low-res target + nearest upscale), map graph, buildings,
 * zones, hunters and monsters as quads. PX2D sprites / Three.js pixel scenes replace these later.
 * Render never mutates the world.
 */
export class Renderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private target: THREE.WebGLRenderTarget;
  private blitScene = new THREE.Scene();
  private blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private hunters = new Map<string, THREE.Mesh>();
  private monsters = new Map<string, THREE.Mesh>();
  private hunterQuad = new THREE.PlaneGeometry(1.6, 2.4);
  private monsterQuad = new THREE.PlaneGeometry(1.4, 1.4);
  private deadMat = new THREE.MeshBasicMaterial({ color: 0x444444 });
  /** Building meshes per plot, keyed so a new building / finished construction rebuilds them. */
  private buildings = new Map<string, THREE.Mesh>();
  private viewHeight: number;
  private mapW: number;
  private center: THREE.Vector2;
  private lastSync = performance.now();

  constructor(private canvas: HTMLCanvasElement, private config: GameConfig) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(1);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.camera.position.set(0, 0, 10);

    this.target = new THREE.WebGLRenderTarget(1, 1, { magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
    this.blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: this.target.texture })));
    this.scene.background = new THREE.Color(0x2b3a2e);

    // Fit camera to the map bounds.
    const xs = config.nodes.map((n) => n.x), ys = config.nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 10, maxX = Math.max(...xs) + 10, minY = Math.min(...ys) - 10, maxY = Math.max(...ys) + 10;
    this.center = new THREE.Vector2((minX + maxX) / 2, (minY + maxY) / 2);
    this.mapW = maxX - minX;
    this.viewHeight = maxY - minY;
    this.camera.position.set(this.center.x, this.center.y, 10);

    this.buildStatic(config);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private buildStatic(config: GameConfig): void {
    const nodes = config.index.nodes;
    // Zones: tinted disc around each field node.
    for (const n of config.nodes) {
      if (!n.zoneId) continue;
      const color = zoneColor(config, n.zoneId);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(9, 24), new THREE.MeshBasicMaterial({ color }));
      disc.position.set(n.x, n.y, -0.9);
      this.scene.add(disc);
    }
    // Town ground.
    const town = new THREE.Mesh(new THREE.PlaneGeometry(36, 44), new THREE.MeshBasicMaterial({ color: 0x4f6b45 }));
    town.position.set(0, 0, -0.95);
    this.scene.add(town);
    // Edges: roads thick and sandy, paths thin.
    for (const e of config.edges) {
      const a = nodes.get(e.a)!, b = nodes.get(e.b)!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const w = e.road ? 2.2 : 0.6;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(len, w), new THREE.MeshBasicMaterial({ color: e.road ? 0xc9b27c : 0x8a7a5a }));
      mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, -0.8);
      mesh.rotation.z = Math.atan2(b.y - a.y, b.x - a.x);
      this.scene.add(mesh);
    }
    // Reincarnation Portal (TECH_SPEC §5.13): a violet ring at its node next to the square.
    const portal = config.nodes.find((n) => n.kind === 'portal');
    if (portal) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.8, 20), new THREE.MeshBasicMaterial({ color: 0x9a6cff }));
      ring.position.set(portal.x, portal.y, -0.55);
      this.scene.add(ring);
    }
    // Building plots (TECH_SPEC §5.12): an empty lot each; buildings on them are drawn in sync() from the world.
    for (const p of config.plots) {
      const lot = new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.h), new THREE.MeshBasicMaterial({ color: 0x3f5638 }));
      lot.position.set(p.x, p.y, -0.6);
      this.scene.add(lot);
    }
  }

  /** One mesh (walls + roof) for a building on a plot; under construction = faded, no roof. */
  private buildingMesh(plotId: string, buildingId: string, built: boolean): THREE.Mesh {
    const p = this.config.index.plots.get(plotId)!;
    const b = this.config.index.buildings.get(buildingId);
    const color = new THREE.Color(b ? buildingColor(b) : 0xffffff);
    if (!built) color.multiplyScalar(0.5);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.h), new THREE.MeshBasicMaterial({ color }));
    mesh.position.set(p.x, p.y, -0.5);
    if (built) {
      const roof = new THREE.Mesh(new THREE.PlaneGeometry(p.w, 1.2), new THREE.MeshBasicMaterial({ color: 0x5a3a2a }));
      roof.position.set(0, p.h / 2 - 0.6, 0.1);
      mesh.add(roof);
    }
    return mesh;
  }

  /** Screen pixels covered by the debug panel on the left; the map is framed in the remaining area. */
  leftInsetPx = 0;

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    const inset = w - this.leftInsetPx > 300 ? this.leftInsetPx : 0;
    const visibleW = w - inset;
    const aspect = visibleW / h;
    // Fit the whole map into the visible area (by height or by width, whichever is tighter).
    const vh = Math.max(this.viewHeight, this.mapW / aspect);
    const worldPerPx = vh / h;
    // Shift the view so the map is centered in the uncovered part of the screen.
    const shift = (inset / 2) * worldPerPx;
    this.camera.position.x = this.center.x - shift;
    this.camera.left = (-vh * (w / h)) / 2;
    this.camera.right = (vh * (w / h)) / 2;
    this.camera.top = vh / 2;
    this.camera.bottom = -vh / 2;
    this.camera.updateProjectionMatrix();
    this.target.setSize(Math.max(1, Math.floor(w / PIXEL_SCALE)), Math.max(1, Math.floor(h / PIXEL_SCALE)));
  }

  /** Smoothly approach the sim position (sim runs at 10 Hz, render at display rate). */
  private follow(mesh: THREE.Mesh, x: number, y: number, k: number, fresh: boolean): void {
    if (fresh) mesh.position.set(x, y, 0);
    else {
      mesh.position.x += (x - mesh.position.x) * k;
      mesh.position.y += (y - mesh.position.y) * k;
    }
  }

  private syncSet<T extends { id: string }>(
    items: readonly T[], map: Map<string, THREE.Mesh>, make: (it: T) => THREE.Mesh, update: (it: T, m: THREE.Mesh, fresh: boolean) => void,
  ): void {
    const alive = new Set<string>();
    for (const it of items) {
      alive.add(it.id);
      let mesh = map.get(it.id);
      const fresh = !mesh;
      if (!mesh) {
        mesh = make(it);
        this.scene.add(mesh);
        map.set(it.id, mesh);
      }
      update(it, mesh, fresh);
    }
    for (const [id, mesh] of map) {
      if (alive.has(id)) continue;
      this.scene.remove(mesh);
      map.delete(id);
    }
  }

  sync(world: World): void {
    const now = performance.now();
    const k = Math.min(1, ((now - this.lastSync) / 1000) * 12);
    this.lastSync = now;

    const placed = (world.town.buildings ?? []).map((s) => ({ id: `${s.id}|${s.buildingId}|${s.level > 0 ? 1 : 0}`, s }));
    this.syncSet(placed, this.buildings, (it) => this.buildingMesh(it.s.id, it.s.buildingId, it.s.level > 0), () => {});
    this.syncSet(world.hunters, this.hunters,
      (h) => new THREE.Mesh(this.hunterQuad, new THREE.MeshBasicMaterial({ color: CLASS_COLORS[h.classId] ?? 0xffffff })),
      (h, mesh, fresh) => {
        mesh.visible = !h.insideBuildingId;
        if (h.deadMs > 0) mesh.material = this.deadMat;
        else if (mesh.material === this.deadMat) mesh.material = new THREE.MeshBasicMaterial({ color: CLASS_COLORS[h.classId] ?? 0xffffff });
        this.follow(mesh, h.position.x, h.position.y, k, fresh);
        mesh.position.z = 0.2;
      });
    this.syncSet(world.monsters, this.monsters,
      (m) => new THREE.Mesh(this.monsterQuad, new THREE.MeshBasicMaterial({ color: monsterColor(this.config, m.defId, m.difficultyId) })),
      (m, mesh, fresh) => {
        this.follow(mesh, m.position.x, m.position.y, k, fresh);
        mesh.position.z = 0.1;
      });
  }

  draw(): void {
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.blitScene, this.blitCamera);
  }
}
