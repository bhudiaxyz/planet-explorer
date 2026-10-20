import * as THREE from "three";
import type { Planet } from "./planet";
import { sm } from "./util";
import { rng } from "./noise";
import { S } from "./settings";
import { CFG } from "./config";
import { treeGeos, lowGeos, treeMats, LEAF } from "./trees";
import { canBake, bakePoints } from "./bake";
import type { Obs } from "./collision";
const V = THREE.Vector3,
  UP = new V(0, 1, 0),
  [H0, H1, M0, M1] = CFG.treeLod;
/** Species indices (order matches treeGeos / lowGeos / LEAF in trees.ts). */
const SP = {
  pine: 0,
  oak: 1,
  birch: 2,
  palm: 3,
  fir: 4,
  snag: 5,
  acacia: 6,
  cypress: 7,
} as const;
const TRUNK = [0.5, 0.7, 0.28, 0.5, 0.45, 0.45, 0.35, 0.35]; // base trunk radius per species, for collision

type Lists = {
  n: number;
  dir: Float32Array;
  sc: Float32Array;
  sw: Float32Array;
  sh: Float32Array;
  tx: Float32Array;
  tz: Float32Array;
  yaw: Float32Array;
  tint: Float32Array;
  far: Float32Array;
  exM: Float32Array;
  has: Uint8Array;
};
type L = Lists & { m: THREE.InstancedMesh[] }; // m = [detailed, medium, low-poly] instanced meshes of one species
type Tree = {
  k: number;
  sp: number;
  sc: number;
  yaw: number;
  w: number;
  h: number;
  tx: number;
  tz: number;
  c: number[];
};

/** CPU twin of GLSL treeDensity() (gpu.ts): used only when the GPU bake is unavailable. */
function treeDensityCPU(pl: Planet, d: THREE.Vector3, m: number) {
  const f = S.frequency,
    n = pl.n2;
  return (
    sm(-0.05, 0.22, n.get(d.x * f * 5 + 50, d.y * f * 5, d.z * f * 5)) *
    sm(-0.12, 0.2, m) *
    (0.25 +
      0.75 *
        sm(-0.1, 0.3, n.get(d.x * f * 18, d.y * f * 18 + 91, d.z * f * 18)))
  );
}
/** Species by altitude/climate; `stand` (smooth noise) makes neighbouring trees share a species so forests read as stands, not confetti. */
function pickSpecies(e: number, tp: number, m: number, stand: number): number {
  if (e < 0.1 && tp > 0.62 && m > -0.1) return SP.palm; // warm coast
  if (e > 0.44) return SP.snag; // treeline
  if (e > 0.3 || tp < 0.42) return SP.fir; // high / cold
  if (tp > 0.62 && m < -0.05) return SP.acacia; // dry warm lowland
  if (tp < 0.55) return SP.pine;
  if (m > 0.15) return stand > 0.1 ? SP.oak : SP.birch; // wet: oak and birch stands
  return stand < -0.05 ? SP.cypress : SP.birch; // drier: cypress stands among birch
}

/**
 * Three-tier tree LOD with clustered placement.
 *  Placement: candidates are sampled on the GPU (bake modes 1/5); a tree is accepted with probability = treeDensity (forests ~100 m containing stands/glades
 *  ~25 m) plus a faint background, subject to a minimum spacing, so trees gather into forests and groves with open land between.
 *  LOD: the low-poly tier is STATIC (all trees; its vertex shader collapses near / far-side instances). Only the detailed (≤ H1+15 m, shadow-casting) and
 *  medium (H0-15…M1+15 m) sets are rebuilt as you move, from per-tree matrices composed once and cached.
 */
export class Forest {
  group = new THREE.Group();
  L: L[] = [];
  last = new V(1e9, 0, 0);
  private o = new THREE.Object3D();
  private d = new V();
  private col = new THREE.Color();
  constructor(private pl: Planet) {}

  /** Per-candidate terrain samples. mode 1: (elev, moisture, tree density, slope) · 2: coarse-mesh radius · 5: stand noise. */
  private sample(dirs: Float32Array, mode: number) {
    if (canBake()) return bakePoints(dirs, mode);
    const n = dirs.length / 3,
      out = new Float32Array(n * 4),
      pl = this.pl,
      d = new V(),
      t = new V(),
      f = S.frequency;
    for (let i = 0; i < n; i++) {
      d.fromArray(dirs, i * 3);
      if (mode === 2) out[i * 4] = pl.coarseR(d);
      else if (mode === 5)
        out[i * 4] = pl.n2.get(d.x * f * 11, d.y * f * 11, d.z * f * 11 + 77);
      else {
        const e = pl.elev(d),
          m = pl.moist(d);
        t.crossVectors(d, UP)
          .normalize()
          .multiplyScalar(0.01)
          .add(d)
          .normalize();
        out.set(
          [
            e,
            m,
            treeDensityCPU(pl, d, m),
            Math.abs(pl.radiusAt(t) - (pl.R + e * S.amplitude)) / (0.01 * pl.R),
          ],
          i * 4,
        );
      }
    }
    return out;
  }
  private place(
    l: Lists,
    k: number,
    rad: number,
    out: Float32Array,
    off: number,
  ) {
    const o = this.o,
      d = this.d.set(l.dir[k * 3], l.dir[k * 3 + 1], l.dir[k * 3 + 2]);
    o.position.copy(d).multiplyScalar(rad);
    o.quaternion.setFromUnitVectors(UP, d);
    o.rotateY(l.yaw[k]);
    o.rotateX(l.tx[k]);
    o.rotateZ(l.tz[k]);
    o.scale.set(l.sc[k] * l.sw[k], l.sc[k] * l.sh[k], l.sc[k] * l.sw[k]);
    o.updateMatrix();
    o.matrix.toArray(out, off);
  }
  /** Per-tree shape (non-uniform scale, lean) and foliage hue: species base × jitter, then autumn (cool zones), blossom, spring flush, drought olive. */
  private style(
    sp: number,
    tp: number,
    m: number,
    e: number,
    r: () => number,
  ): Omit<Tree, "k" | "sp"> {
    const c = this.col.copy(LEAF[sp]);
    c.offsetHSL((r() - 0.5) * 0.05, (r() - 0.5) * 0.12, (r() - 0.5) * 0.1);
    const a = r(),
      decid = sp === SP.oak || sp === SP.birch || sp === SP.acacia;
    if (decid && tp < 0.6 && a < 0.35)
      c.setHSL(0.03 + 0.12 * r(), 0.75, 0.28 + 0.1 * r());
    else if (decid && a > 0.94) c.setHSL(0.93 + 0.04 * r(), 0.5, 0.55);
    else if (a > 0.88) c.offsetHSL(0.04, 0.1, 0.1);
    if (m < -0.15) c.offsetHSL(-0.03, -0.15, 0.02);
    const lean = sp === SP.palm ? 0.3 : 0.14;
    return {
      sc: (0.75 + r() * 0.7) * (1 - sm(0.3, 0.55, e) * 0.35),
      yaw: r() * 6.28,
      w:
        (0.85 + 0.35 * r()) *
        (sp === SP.cypress ? 0.8 : sp === SP.acacia ? 1.2 : 1),
      h: (0.85 + 0.45 * r()) * (sp === SP.cypress ? 1.15 : 1),
      tx: (r() - 0.5) * lean,
      tz: (r() - 0.5) * lean,
      c: [c.r, c.g, c.b],
    };
  }

  build() {
    this.group.clear();
    this.L = [];
    this.last.set(1e9, 0, 0);
    const pl = this.pl,
      R = pl.R,
      max = Math.floor(CFG.forest.count * S.forest * (R / 700) ** 2),
      r = rng(S.seed + 7),
      hg = treeGeos(S.seed, 1),
      mg = treeGeos(S.seed, 0.5),
      lg = lowGeos(S.seed);
    const tries = Math.min(max * CFG.forest.tries, 200000),
      cd = new Float32Array(tries * 3),
      d = new V();
    let n = 0;
    for (let i = 0; i < tries; i++) {
      d.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
      const l = d.lengthSq();
      if (l > 1 || l < 0.01) continue;
      d.normalize().toArray(cd, n++ * 3);
    }
    const dirs = cd.subarray(0, n * 3),
      smp = this.sample(dirs, 1),
      stand = this.sample(dirs, 5);
    // minimum spacing via a 3-D hash grid (cell = spacing), so dense stands never stack trunks
    const cs = CFG.forest.minSpacing,
      grid = new Map<number, number[]>(),
      px: number[] = [],
      py: number[] = [],
      pz: number[] = [];
    const cell = (v: number) => Math.floor(v / cs) + 512,
      key = (x: number, y: number, z: number) => (x * 1024 + y) * 1024 + z;
    const free = (x: number, y: number, z: number) => {
      const ix = cell(x),
        iy = cell(y),
        iz = cell(z);
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++)
          for (let c = -1; c <= 1; c++) {
            const list = grid.get(key(ix + a, iy + b, iz + c));
            if (list)
              for (const j of list) {
                const dx = px[j] - x,
                  dy = py[j] - y,
                  dz = pz[j] - z;
                if (dx * dx + dy * dy + dz * dz < cs * cs) return false;
              }
          }
      return true;
    };
    const acc: Tree[] = [];
    for (let k = 0; k < n && acc.length < max; k++) {
      const e = smp[k * 4],
        m = smp[k * 4 + 1],
        dens = smp[k * 4 + 2],
        dy = dirs[k * 3 + 1],
        tp = 1 - 1.1 * dy * dy - 1.2 * Math.max(e, 0);
      if (
        e < 0.03 ||
        e > 0.55 ||
        tp < S.snowline + 0.02 ||
        smp[k * 4 + 3] > 0.6 ||
        r() > dens + 0.004
      )
        continue;
      const x = dirs[k * 3] * R,
        y = dy * R,
        z = dirs[k * 3 + 2] * R;
      if (!free(x, y, z)) continue;
      const sp = pickSpecies(e, tp, m, stand[k * 4]),
        id = acc.length,
        kk = key(cell(x), cell(y), cell(z));
      px.push(x);
      py.push(y);
      pz.push(z);
      (grid.get(kk) ?? grid.set(kk, []).get(kk)!).push(id);
      acc.push({ k, sp, ...this.style(sp, tp, m, e, r) });
    }
    const ad = new Float32Array(acc.length * 3);
    acc.forEach((t, i) => ad.set(dirs.subarray(t.k * 3, t.k * 3 + 3), i * 3));
    const cr = this.sample(ad, 2),
      per = hg.map(() => [] as number[]);
    acc.forEach((t, i) => per[t.sp].push(i));
    per.forEach((ids, si) => {
      const cnt = ids.length,
        cap = Math.max(1, cnt),
        F = (k: number) => new Float32Array(k);
      const l: Lists = {
        n: cnt,
        dir: F(cnt * 3),
        sc: F(cnt),
        sw: F(cnt),
        sh: F(cnt),
        tx: F(cnt),
        tz: F(cnt),
        yaw: F(cnt),
        tint: F(cnt * 3),
        far: F(cnt * 16),
        exM: F(cnt * 16),
        has: new Uint8Array(cnt),
      };
      ids.forEach((a, j) => {
        const t = acc[a];
        l.dir.set(ad.subarray(a * 3, a * 3 + 3), j * 3);
        l.sc[j] = t.sc;
        l.sw[j] = t.w;
        l.sh[j] = t.h;
        l.tx[j] = t.tx;
        l.tz[j] = t.tz;
        l.yaw[j] = t.yaw;
        l.tint.set(t.c, j * 3);
        this.place(l, j, cr[a * 4] - 0.15, l.far, j * 16);
      });
      const mk = (g: THREE.BufferGeometry, tier: number) => {
        const m = new THREE.InstancedMesh(g, treeMats[tier], cap);
        m.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(cap * 3),
          3,
        );
        m.count = 0;
        m.frustumCulled = false;
        m.matrixAutoUpdate = false;
        this.group.add(m);
        return m;
      };
      const ms = [mk(hg[si], 0), mk(mg[si], 1), mk(lg[si], 2)];
      ms[0].castShadow = ms[0].receiveShadow = true;
      ms[0].visible = ms[1].visible = false;
      const lo = ms[2];
      (lo.instanceMatrix.array as Float32Array).set(l.far);
      (lo.instanceColor!.array as Float32Array).set(l.tint); // static low-poly tier uploaded once
      lo.count = cnt;
      lo.visible = cnt > 0;
      lo.instanceMatrix.needsUpdate = true;
      lo.instanceColor!.needsUpdate = true;
      this.L.push({ ...l, m: ms });
    });
  }

  /** Solid trunks within radiusM of a unit direction (for the collider). */
  collect(dir: THREE.Vector3, radiusM: number, out: Obs[]) {
    const thr = Math.cos(radiusM / this.pl.R);
    this.L.forEach((l, i) => {
      const base = TRUNK[i];
      for (let k = 0; k < l.n; k++) {
        const dx = l.dir[k * 3],
          dy = l.dir[k * 3 + 1],
          dz = l.dir[k * 3 + 2];
        if (dx * dir.x + dy * dir.y + dz * dir.z < thr) continue;
        const d = new V(dx, dy, dz),
          r = (base + 0.05) * l.sc[k] * l.sw[k];
        out.push({
          d,
          ax: new V()
            .crossVectors(d, Math.abs(dy) < 0.99 ? UP : new V(1, 0, 0))
            .normalize(),
          rx: r,
          rz: r,
          H: Infinity,
          mode: 0,
        });
      }
    });
  }

  /** Rebuilds the detailed and medium instance sets after the camera moved ≥ 12 m. */
  update(cam: THREE.Vector3) {
    if (cam.distanceTo(this.last) < 12) return;
    this.last.copy(cam);
    const R = this.pl.R,
      cl = cam.length(),
      cx = cam.x / cl,
      cy = cam.y / cl,
      cz = cam.z / cl,
      thr = R / cl - 0.06,
      near = cl - R < 400,
      c = (m: number) => Math.cos(Math.min(1.5, m / R));
    const hiT = c(H1 + 15),
      midNear = c(H0 - 15),
      midFar = c(M1 + 15);
    for (const l of this.L) {
      const cnt = [0, 0],
        mats = l.m.map((m) => m.instanceMatrix.array as Float32Array),
        cols = l.m.map((m) => m.instanceColor!.array as Float32Array),
        exM = l.exM;
      for (let k = 0; k < l.n; k++) {
        const dx = l.dir[k * 3],
          dy = l.dir[k * 3 + 1],
          dz = l.dir[k * 3 + 2],
          dot = dx * cx + dy * cy + dz * cz;
        if (dot < thr) continue;
        const inHi = near && dot > hiT,
          inMid = near && dot > midFar && dot <= midNear;
        if (!inHi && !inMid) continue;
        const s = k * 16;
        if (!l.has[k]) {
          this.d.set(dx, dy, dz);
          this.place(l, k, this.pl.radiusAt(this.d) - 0.15, exM, s);
          l.has[k] = 1;
        } // exact ground height, composed once
        for (let t = 0; t < 2; t++)
          if (t === 0 ? inHi : inMid) {
            const w = cnt[t] * 16,
              q = cnt[t] * 3;
            for (let i = 0; i < 16; i++) mats[t][w + i] = exM[s + i];
            cols[t][q] = l.tint[k * 3];
            cols[t][q + 1] = l.tint[k * 3 + 1];
            cols[t][q + 2] = l.tint[k * 3 + 2];
            cnt[t]++;
          }
      }
      for (let t = 0; t < 2; t++) {
        // upload only the used range; empty meshes are not drawn at all
        const m = l.m[t];
        m.visible = cnt[t] > 0;
        m.count = cnt[t];
        m.instanceMatrix.clearUpdateRanges();
        m.instanceMatrix.addUpdateRange(0, cnt[t] * 16);
        m.instanceMatrix.needsUpdate = true;
        m.instanceColor!.clearUpdateRanges();
        m.instanceColor!.addUpdateRange(0, cnt[t] * 3);
        m.instanceColor!.needsUpdate = true;
      }
    }
  }
}
