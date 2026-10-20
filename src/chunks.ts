import * as THREE from "three";
import { S } from "./settings";
import { CFG } from "./config";
import { terrainMat } from "./fx";
import { makeRT, bakeChunk } from "./bake";
import { frame, type Frame } from "./util";
const V = THREE.Vector3,
  {
    cells: CS,
    cell: CC,
    radius: CR,
    budget: BUDGET,
    firstBudget: FIRST,
    makeAlt,
    clearAlt,
  } = CFG.chunk;

interface Shared {
  idx: THREE.BufferAttribute;
  idxLo: THREE.BufferAttribute;
  pos: THREE.BufferAttribute;
  aL: THREE.BufferAttribute;
  aS: THREE.BufferAttribute;
}

/**
 * Terrain chunk streaming. (2·CR+1)² chunks of CS×CS cells (CC metres each) on the planet's face lattice around the player.
 *  – Heights, normals and biome colour of a chunk are baked once on the GPU into two small textures; the per-frame vertex shader only fetches them.
 *  – Meshes, materials and bake targets are pooled and reused; vertex buffers are shared by every chunk.
 *  – Chunks fade in/out with a dithered discard (never pop), the outer ring uses a half-resolution index buffer and geomorphs between LOD levels.
 */
export class ChunkManager {
  private map = new Map<string, THREE.Mesh>();
  private pool: THREE.Mesh[] = [];
  private dying: THREE.Mesh[] = [];
  private shared?: Shared;
  private fr = frame(new V(0, 1, 0), 1, 1);
  private lf = -1;
  private lci = 0;
  private lcj = 0; // last completed (face, chunk i, chunk j)
  constructor(
    private group: THREE.Group,
    private radius: () => number,
  ) {}

  /** Drops every chunk. instant = false lets them fade out first. */
  clear(instant = true) {
    this.map.forEach((m) => this.retire(m, instant));
    this.map.clear();
    if (instant) {
      this.dying.forEach((m) => {
        this.group.remove(m);
        this.pool.push(m);
      });
      this.dying.length = 0;
    }
    this.lf = -1;
  }
  private retire(m: THREE.Mesh, instant: boolean) {
    if (instant) {
      this.group.remove(m);
      this.pool.push(m);
    } else this.dying.push(m);
  }

  update(d: THREE.Vector3, alt: number) {
    if (alt > clearAlt) {
      if (this.map.size) this.clear(false);
      return;
    }
    if (alt > makeAlt && !this.map.size) return; // hysteresis between make/clear altitudes
    const fr = frame(d, this.radius(), CC, this.fr),
      ci = Math.floor(fr.i / CS),
      cj = Math.floor(fr.j / CS);
    if (fr.f === this.lf && ci === this.lci && cj === this.lcj) return; // still inside the same centre chunk
    const want = new Set<string>(),
      todo: [number, number][] = [];
    for (let a = -CR; a <= CR; a++)
      for (let b = -CR; b <= CR; b++) {
        const k = `${fr.f},${ci + a},${cj + b}`;
        want.add(k);
        if (!this.map.has(k)) todo.push([ci + a, cj + b]);
      }
    todo.sort(
      (x, y) =>
        Math.hypot(x[0] - ci, x[1] - cj) - Math.hypot(y[0] - ci, y[1] - cj),
    ); // nearest first
    let budget = this.map.size ? BUDGET : FIRST;
    for (const [a, b] of todo) {
      if (budget-- <= 0) break;
      this.make(
        fr,
        a,
        b,
        `${fr.f},${a},${b}`,
        Math.max(Math.abs(a - ci), Math.abs(b - cj)) >= 2,
      );
    }
    for (const m of this.map.values())
      m.userData.lo =
        Math.max(Math.abs(m.userData.ci - ci), Math.abs(m.userData.cj - cj)) >=
        2; // target LOD; tick() geomorphs to it
    if (![...want].every((k) => this.map.has(k))) return; // finish loading before retiring anything
    for (const [k, m] of this.map)
      if (!want.has(k)) {
        this.retire(m, false);
        this.map.delete(k);
      }
    this.lf = fr.f;
    this.lci = ci;
    this.lcj = cj;
  }

  /** Per-frame animation: fade-in, geomorph towards the target LOD, fade-out of retired chunks. */
  tick(dt: number) {
    for (const m of this.map.values()) {
      const u = m.userData,
        f = u.fade;
      if (f.value < 1) f.value = Math.min(1, f.value + dt * 1.6);
      const t = u.lo ? 1 : 0,
        mo = u.morph;
      if (mo.value !== t)
        mo.value +=
          Math.sign(t - mo.value) * Math.min(Math.abs(t - mo.value), dt * 1.25);
      const lo = !!u.lo && mo.value >= 1;
      if (u.usingLo !== lo) {
        u.usingLo = lo;
        m.geometry.setIndex(lo ? this.shared!.idxLo : this.shared!.idx);
      } // swap index once the surfaces coincide
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const m = this.dying[i],
        f = m.userData.fade;
      f.value -= dt * 1.6;
      if (f.value <= 0) {
        this.group.remove(m);
        this.pool.push(m);
        this.dying.splice(i, 1);
      }
    }
  }

  /** Vertex data shared by all chunks: full-res and half-res index buffers (with skirts), local grid coordinates, skirt flags. */
  private buffers(): Shared {
    if (this.shared) return this.shared;
    const G = CS + 1,
      P = G * G + 4 * CS,
      per: number[] = []; // per = perimeter vertex ids in loop order (skirt vertices are duplicates of these)
    for (let a = 0; a < G; a++) per.push(a);
    for (let b = 1; b < G; b++) per.push(b * G + G - 1);
    for (let a = G - 2; a >= 0; a--) per.push((G - 1) * G + a);
    for (let b = G - 2; b >= 1; b--) per.push(b * G);
    const idx = new Uint32Array(6 * CS * CS + 6 * per.length);
    let t = 0;
    for (let b = 0; b < CS; b++)
      for (let a = 0; a < CS; a++) {
        const i0 = b * G + a;
        idx.set([i0, i0 + 1, i0 + G, i0 + 1, i0 + G + 1, i0 + G], t);
        t += 6;
      }
    per.forEach((a, k) => {
      const n = (k + 1) % per.length,
        b = per[n],
        a2 = G * G + k,
        b2 = G * G + n;
      idx.set([a, b, a2, b, b2, a2], t);
      t += 6;
    });
    const H = CS / 2,
      lo = new Uint32Array(6 * H * H + 3 * per.length);
    t = 0; // half resolution (every second vertex); skirts hide LOD seams
    for (let b = 0; b < H; b++)
      for (let a = 0; a < H; a++) {
        const i0 = 2 * b * G + 2 * a;
        lo.set([i0, i0 + 2, i0 + 2 * G, i0 + 2, i0 + 2 * G + 2, i0 + 2 * G], t);
        t += 6;
      }
    for (let k = 0; k < per.length; k += 2) {
      const n = (k + 2) % per.length,
        a = per[k],
        b = per[n],
        a2 = G * G + k,
        b2 = G * G + n;
      lo.set([a, b, a2, b, b2, a2], t);
      t += 6;
    }
    const aL = new Float32Array(P * 2),
      aS = new Float32Array(P);
    for (let b = 0; b < G; b++)
      for (let a = 0; a < G; a++) aL.set([a, b], (b * G + a) * 2);
    per.forEach((src, k) => {
      aL.copyWithin((G * G + k) * 2, src * 2, src * 2 + 2);
      aS[G * G + k] = 1;
    });
    return (this.shared = {
      idx: new THREE.BufferAttribute(idx, 1),
      idxLo: new THREE.BufferAttribute(lo, 1),
      pos: new THREE.BufferAttribute(new Float32Array(P * 3), 3),
      aL: new THREE.BufferAttribute(aL, 2),
      aS: new THREE.BufferAttribute(aS, 1),
    });
  }

  private make(fr: Frame, ci: number, cj: number, key: string, lo: boolean) {
    const G = CS + 1,
      sh = this.buffers(),
      fcode = fr.f * 2 + (fr.n.getComponent(fr.f) < 0 ? 1 : 0);
    let m = this.pool.pop();
    if (!m) {
      // new pool slot: material + two bake targets are created once and reused for every chunk
      const rt = makeRT(G, G),
        rtC = makeRT(G, G),
        fade = { value: 0 },
        morph = { value: 0 },
        uCh = { value: new V() },
        g = new THREE.BufferGeometry();
      g.setIndex(sh.idx);
      g.setAttribute("position", sh.pos);
      g.setAttribute("aL", sh.aL);
      g.setAttribute("aS", sh.aS);
      g.boundingSphere = new THREE.Sphere();
      m = new THREE.Mesh(
        g,
        terrainMat(false, true, {
          uH: { value: rt.texture },
          uC: { value: rtC.texture },
          uCh,
          uFade: fade,
          uMorph: morph,
        }),
      );
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.renderOrder = -1; // drawn before the coarse planet so its hidden fragments fail early-z
      m.userData = { rt, rtC, fade, uCh, morph };
    }
    const u = m.userData;
    u.fade.value = 0;
    u.uCh.value.set(ci * CS, cj * CS, fcode);
    u.ci = ci;
    u.cj = cj;
    u.lo = lo;
    u.morph.value = lo ? 1 : 0;
    u.usingLo = lo;
    m.geometry.setIndex(lo ? sh.idxLo : sh.idx);
    bakeChunk(u.rt, u.rtC, ci * CS, cj * CS, fcode);
    const R = this.radius(),
      c = new V()
        .copy(fr.n)
        .multiplyScalar(R)
        .addScaledVector(fr.u, (ci * CS + CS / 2) * CC)
        .addScaledVector(fr.v, (cj * CS + CS / 2) * CC)
        .normalize()
        .multiplyScalar(R);
    m.geometry.boundingSphere!.set(c, CS * CC * 0.75 + S.amplitude * 1.5 + 10);
    this.group.add(m);
    this.map.set(key, m);
  }
}
