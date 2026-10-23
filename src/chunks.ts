import * as THREE from "three";
import { S } from "./settings";
import { CFG } from "./config";
import { terrainMat } from "./fx";
import { makeRT, bakeChunk } from "./bake";
import { frame, type Frame } from "./utilgeo";
const {
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
  private scratchFrame = frame(new THREE.Vector3(0, 1, 0), 1, 1);
  private lastFace = -1;
  private lastChunkI = 0;
  private lastChunkJ = 0; // last completed (face, chunk i, chunk j)
  private wantSet = new Set<string>();
  private todoArr: [number, number][] = [];
  constructor(
    private group: THREE.Group,
    private radius: () => number,
  ) { this.buffers(); }

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
    this.lastFace = -1;
  }
  private retire(m: THREE.Mesh, instant: boolean) {
    if (instant) {
      this.group.remove(m);
      this.pool.push(m);
    } else this.dying.push(m);
  }

  update(playerDirection: THREE.Vector3, altitude: number) {
    if (altitude > clearAlt) {
      if (this.map.size) this.clear(false);
      return;
    }
    if (altitude > makeAlt && !this.map.size) return; // hysteresis between make/clear altitudes
    const currentFrame = frame(
        playerDirection,
        this.radius(),
        CC,
        this.scratchFrame,
      ),
      ci = Math.floor(currentFrame.cellI / CS),
      cj = Math.floor(currentFrame.cellJ / CS);
    if (
      currentFrame.face === this.lastFace &&
      ci === this.lastChunkI &&
      cj === this.lastChunkJ
    )
      return; // still inside the same centre chunk
    const want = this.wantSet,
      todo = this.todoArr;
    want.clear();
    todo.length = 0;
    for (let a = -CR; a <= CR; a++)
      for (let b = -CR; b <= CR; b++) {
        const k = `${currentFrame.face},${ci + a},${cj + b}`;
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
        currentFrame,
        a,
        b,
        `${currentFrame.face},${a},${b}`,
        Math.max(Math.abs(a - ci), Math.abs(b - cj)) >= 2,
      );
    }
    for (const m of this.map.values())
      m.userData.lo =
        Math.max(
          Math.abs(m.userData.ci - ci),
          Math.abs(m.userData.cj - cj),
        ) >= 3; // target LOD; tick() geomorphs to it
    for (const k of want) if (!this.map.has(k)) return; // finish loading before retiring anything
    for (const [k, m] of this.map)
      if (!want.has(k)) {
        this.retire(m, false);
        this.map.delete(k);
      }
    this.lastFace = currentFrame.face;
    this.lastChunkI = ci;
    this.lastChunkJ = cj;
  }

  /** Per-frame animation: fade-in, geomorph towards the target LOD, fade-out of retired chunks. */
  tick(dt: number) {
    for (const m of this.map.values()) {
      const userData = m.userData,
        fadeUniform = userData.fade;
      if (fadeUniform.value < 1)
        fadeUniform.value = Math.min(1, fadeUniform.value + dt * 1.6);
      const targetLod = userData.lo ? 1 : 0,
        morphUniform = userData.morph;
      if (morphUniform.value !== targetLod)
        morphUniform.value +=
          Math.sign(targetLod - morphUniform.value) *
          Math.min(Math.abs(targetLod - morphUniform.value), dt * 1.25);
      const isLowLod = !!userData.lo && morphUniform.value >= 1;
      if (userData.usingLo !== isLowLod) {
        userData.usingLo = isLowLod;
        m.geometry.setIndex(
          isLowLod ? this.shared!.idxLo : this.shared!.idx,
        );
      } // swap index once the surfaces coincide
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const m = this.dying[i],
        fadeUniform = m.userData.fade;
      fadeUniform.value -= dt * 1.6;
      if (fadeUniform.value <= 0) {
        this.group.remove(m);
        this.pool.push(m);
        this.dying.splice(i, 1);
      }
    }
  }

  /** Vertex data shared by all chunks: full-res and half-res index buffers (with skirts), local grid coordinates, skirt flags. */
  private buffers(): Shared {
    if (this.shared) return this.shared;
    const gridSize = CS + 1,
      totalVertexCount = gridSize * gridSize + 4 * CS,
      perimeterVertexIds: number[] = []; // perimeter vertex ids in loop order (skirt vertices are duplicates of these)
    for (let a = 0; a < gridSize; a++) perimeterVertexIds.push(a);
    for (let b = 1; b < gridSize; b++)
      perimeterVertexIds.push(b * gridSize + gridSize - 1);
    for (let a = gridSize - 2; a >= 0; a--)
      perimeterVertexIds.push((gridSize - 1) * gridSize + a);
    for (let b = gridSize - 2; b >= 1; b--)
      perimeterVertexIds.push(b * gridSize);
    const idx = new Uint32Array(
      6 * CS * CS + 6 * perimeterVertexIds.length,
    );
    let t = 0;
    for (let b = 0; b < CS; b++)
      for (let a = 0; a < CS; a++) {
        const i0 = b * gridSize + a;
        idx.set([i0, i0 + 1, i0 + gridSize, i0 + 1, i0 + gridSize + 1, i0 + gridSize], t);
        t += 6;
      }
    perimeterVertexIds.forEach((a, k) => {
      const n = (k + 1) % perimeterVertexIds.length,
        b = perimeterVertexIds[n],
        a2 = gridSize * gridSize + k,
        b2 = gridSize * gridSize + n;
      idx.set([a, b, a2, b, b2, a2], t);
      t += 6;
    });
    const halfResCount = CS / 2,
      lo = new Uint32Array(
        6 * halfResCount * halfResCount + 3 * perimeterVertexIds.length,
      );
    t = 0; // half resolution (every second vertex); skirts hide LOD seams
    for (let b = 0; b < halfResCount; b++)
      for (let a = 0; a < halfResCount; a++) {
        const i0 = 2 * b * gridSize + 2 * a;
        lo.set(
          [
            i0,
            i0 + 2,
            i0 + 2 * gridSize,
            i0 + 2,
            i0 + 2 * gridSize + 2,
            i0 + 2 * gridSize,
          ],
          t,
        );
        t += 6;
      }
    for (let k = 0; k < perimeterVertexIds.length; k += 2) {
      const n = (k + 2) % perimeterVertexIds.length,
        a = perimeterVertexIds[k],
        b = perimeterVertexIds[n],
        a2 = gridSize * gridSize + k,
        b2 = gridSize * gridSize + n;
      lo.set([a, b, a2, b, b2, a2], t);
      t += 6;
    }
    const aL = new Float32Array(totalVertexCount * 2),
      aS = new Float32Array(totalVertexCount);
    for (let b = 0; b < gridSize; b++)
      for (let a = 0; a < gridSize; a++)
        aL.set([a, b], (b * gridSize + a) * 2);
    perimeterVertexIds.forEach((src, k) => {
      aL.copyWithin(
        (gridSize * gridSize + k) * 2,
        src * 2,
        src * 2 + 2,
      );
      aS[gridSize * gridSize + k] = 1;
    });
    return (this.shared = {
      idx: new THREE.BufferAttribute(idx, 1),
      idxLo: new THREE.BufferAttribute(lo, 1),
      pos: new THREE.BufferAttribute(new Float32Array(totalVertexCount * 3), 3),
      aL: new THREE.BufferAttribute(aL, 2),
      aS: new THREE.BufferAttribute(aS, 1),
    });
  }

  private make(
    fr: Frame,
    ci: number,
    cj: number,
    key: string,
    isLowLod: boolean,
  ) {
    const gridSize = CS + 1,
      shared = this.buffers(),
      faceCode =
        fr.face * 2 + (fr.normal.getComponent(fr.face) < 0 ? 1 : 0);
    let m = this.pool.pop();
    if (!m) {
      // new pool slot: material + two bake targets are created once and reused for every chunk
      const rt = makeRT(gridSize, gridSize),
        rtC = makeRT(gridSize, gridSize),
        fade = { value: 0 },
        morph = { value: 0 },
        uCh = { value: new THREE.Vector3() },
        g = new THREE.BufferGeometry();
      g.setIndex(shared.idx);
      g.setAttribute("position", shared.pos);
      g.setAttribute("aL", shared.aL);
      g.setAttribute("aS", shared.aS);
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
    const userData = m.userData;
    userData.fade.value = 0;
    userData.uCh.value.set(ci * CS, cj * CS, faceCode);
    userData.ci = ci;
    userData.cj = cj;
    userData.lo = isLowLod;
    userData.morph.value = isLowLod ? 1 : 0;
    userData.usingLo = isLowLod;
    m.geometry.setIndex(isLowLod ? shared.idxLo : shared.idx);
    bakeChunk(userData.rt, userData.rtC, ci * CS, cj * CS, faceCode);
    const R = this.radius(),
      chunkCenter = new THREE.Vector3()
        .copy(fr.normal)
        .multiplyScalar(R)
        .addScaledVector(fr.tangentU, (ci * CS + CS / 2) * CC)
        .addScaledVector(fr.tangentV, (cj * CS + CS / 2) * CC)
        .normalize()
        .multiplyScalar(R);
    m.geometry.boundingSphere!.set(
      chunkCenter,
      CS * CC * 0.75 + S.amplitude * 1.5 + 10,
    );
    this.group.add(m);
    this.map.set(key, m);
  }
}
