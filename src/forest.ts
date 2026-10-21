import * as THREE from "three";
import type { Planet } from "./planet";
import { smoothstep } from "./util";
import { rng } from "./noise";
import { S } from "./settings";
import { CFG } from "./config";
import { treeGeos, lowGeos, treeMats, LEAF } from "./trees";
import { canBake, bakePoints } from "./bake";
import type { Obs } from "./collision";
const UP = new THREE.Vector3(0, 1, 0),
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
  count: number;
  dir: Float32Array;
  scale: Float32Array;
  scaleWidth: Float32Array;
  scaleHeight: Float32Array;
  tiltX: Float32Array;
  tiltZ: Float32Array;
  yaw: Float32Array;
  tint: Float32Array;
  far: Float32Array;
  exM: Float32Array;
  has: Uint8Array;
};
type SpeciesList = Lists & { m: THREE.InstancedMesh[] }; // m = [detailed, medium, low-poly] instanced meshes of one species
type Tree = {
  candidateIndex: number;
  speciesIndex: number;
  scale: number;
  yaw: number;
  widthScale: number;
  heightScale: number;
  tiltX: number;
  tiltZ: number;
  color: number[];
};

/** CPU twin of GLSL treeDensity() (gpu.ts): used only when the GPU bake is unavailable. */
function treeDensityCPU(planet: Planet, direction: THREE.Vector3, moisture: number) {
  const f = S.frequency,
    noise2 = planet.noise2;
  return (
    smoothstep(
      -0.05,
      0.22,
      noise2.get(direction.x * f * 5 + 50, direction.y * f * 5, direction.z * f * 5),
    ) *
    smoothstep(-0.12, 0.2, moisture) *
    (0.25 +
      0.75 *
        smoothstep(
          -0.1,
          0.3,
          noise2.get(
            direction.x * f * 18,
            direction.y * f * 18 + 91,
            direction.z * f * 18,
          ),
        ))
  );
}
/** Species by altitude/climate; `stand` (smooth noise) makes neighbouring trees share a species so forests read as stands, not confetti. */
function pickSpecies(
  elevation: number,
  temperature: number,
  moisture: number,
  standNoise: number,
): number {
  if (elevation < 0.1 && temperature > 0.62 && moisture > -0.1) return SP.palm; // warm coast
  if (elevation > 0.44) return SP.snag; // treeline
  if (elevation > 0.3 || temperature < 0.42) return SP.fir; // high / cold
  if (temperature > 0.62 && moisture < -0.05) return SP.acacia; // dry warm lowland
  if (temperature < 0.55) return SP.pine;
  if (moisture > 0.15) return standNoise > 0.1 ? SP.oak : SP.birch; // wet: oak and birch stands
  return standNoise < -0.05 ? SP.cypress : SP.birch; // drier: cypress stands among birch
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
  speciesLists: SpeciesList[] = [];
  last = new THREE.Vector3(1e9, 0, 0);
  private scratchObject3D = new THREE.Object3D();
  private scratchDir = new THREE.Vector3();
  private scratchColor = new THREE.Color();
  constructor(private pl: Planet) {}

  /** Per-candidate terrain samples. mode 1: (elev, moisture, tree density, slope) · 2: coarse-mesh radius · 5: stand noise. */
  private sample(dirs: Float32Array, mode: number) {
    if (canBake()) return bakePoints(dirs, mode);
    const n = dirs.length / 3,
      results = new Float32Array(n * 4),
      planet = this.pl,
      d = new THREE.Vector3(),
      t = new THREE.Vector3(),
      f = S.frequency;
    for (let i = 0; i < n; i++) {
      d.fromArray(dirs, i * 3);
      if (mode === 2) results[i * 4] = planet.coarseR(d);
      else if (mode === 5)
        results[i * 4] = planet.noise2.get(
          d.x * f * 11,
          d.y * f * 11,
          d.z * f * 11 + 77,
        );
      else {
        const e = planet.elev(d),
          m = planet.moistureAt(d);
        t.crossVectors(d, UP)
          .normalize()
          .multiplyScalar(0.01)
          .add(d)
          .normalize();
        results.set(
          [
            e,
            m,
            treeDensityCPU(planet, d, m),
            Math.abs(planet.radiusAt(t) - (planet.radius + e * S.amplitude)) /
              (0.01 * planet.radius),
          ],
          i * 4,
        );
      }
    }
    return results;
  }
  private place(
    lists: Lists,
    treeIndex: number,
    groundRadius: number,
    matrixOut: Float32Array,
    matrixOffset: number,
  ) {
    const obj = this.scratchObject3D,
      d = this.scratchDir.set(
        lists.dir[treeIndex * 3],
        lists.dir[treeIndex * 3 + 1],
        lists.dir[treeIndex * 3 + 2],
      );
    obj.position.copy(d).multiplyScalar(groundRadius);
    obj.quaternion.setFromUnitVectors(UP, d);
    obj.rotateY(lists.yaw[treeIndex]);
    obj.rotateX(lists.tiltX[treeIndex]);
    obj.rotateZ(lists.tiltZ[treeIndex]);
    obj.scale.set(
      lists.scale[treeIndex] * lists.scaleWidth[treeIndex],
      lists.scale[treeIndex] * lists.scaleHeight[treeIndex],
      lists.scale[treeIndex] * lists.scaleWidth[treeIndex],
    );
    obj.updateMatrix();
    obj.matrix.toArray(matrixOut, matrixOffset);
  }
  /** Per-tree shape (non-uniform scale, lean) and foliage hue: species base × jitter, then autumn (cool zones), blossom, spring flush, drought olive. */
  private style(
    speciesIndex: number,
    temperature: number,
    moisture: number,
    elevation: number,
    rand: () => number,
  ): Omit<Tree, "candidateIndex" | "speciesIndex"> {
    const c = this.scratchColor.copy(LEAF[speciesIndex]);
    c.offsetHSL(
      (rand() - 0.5) * 0.05,
      (rand() - 0.5) * 0.12,
      (rand() - 0.5) * 0.1,
    );
    const a = rand(),
      decid =
        speciesIndex === SP.oak ||
        speciesIndex === SP.birch ||
        speciesIndex === SP.acacia;
    if (decid && temperature < 0.6 && a < 0.35)
      c.setHSL(0.03 + 0.12 * rand(), 0.75, 0.28 + 0.1 * rand());
    else if (decid && a > 0.94) c.setHSL(0.93 + 0.04 * rand(), 0.5, 0.55);
    else if (a > 0.88) c.offsetHSL(0.04, 0.1, 0.1);
    if (moisture < -0.15) c.offsetHSL(-0.03, -0.15, 0.02);
    const lean = speciesIndex === SP.palm ? 0.3 : 0.14;
    return {
      scale:
        (0.75 + rand() * 0.7) *
        (1 - smoothstep(0.3, 0.55, elevation) * 0.35),
      yaw: rand() * 6.28,
      widthScale:
        (0.85 + 0.35 * rand()) *
        (speciesIndex === SP.cypress
          ? 0.8
          : speciesIndex === SP.acacia
            ? 1.2
            : 1),
      heightScale:
        (0.85 + 0.45 * rand()) * (speciesIndex === SP.cypress ? 1.15 : 1),
      tiltX: (rand() - 0.5) * lean,
      tiltZ: (rand() - 0.5) * lean,
      color: [c.r, c.g, c.b],
    };
  }

  build() {
    this.group.clear();
    this.speciesLists = [];
    this.last.set(1e9, 0, 0);
    const planet = this.pl,
      planetRadius = planet.radius,
      max = Math.floor(
        CFG.forest.count * S.forest * (planetRadius / 700) ** 2,
      ),
      rand = rng(S.seed + 7),
      highDetailGeos = treeGeos(S.seed, 1),
      midDetailGeos = treeGeos(S.seed, 0.5),
      lowDetailGeos = lowGeos(S.seed);
    const tries = Math.min(max * CFG.forest.tries, 200000),
      candidateDirs = new Float32Array(tries * 3),
      d = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < tries; i++) {
      d.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      const l = d.lengthSq();
      if (l > 1 || l < 0.01) continue;
      d.normalize().toArray(candidateDirs, n++ * 3);
    }
    const dirs = candidateDirs.subarray(0, n * 3),
      sampleData = this.sample(dirs, 1),
      stand = this.sample(dirs, 5);
    // minimum spacing via a 3-D hash grid (cell = spacing), so dense stands never stack trunks
    const minSpacing = CFG.forest.minSpacing,
      grid = new Map<number, number[]>(),
      px: number[] = [],
      py: number[] = [],
      pz: number[] = [];
    const cell = (v: number) => Math.floor(v / minSpacing) + 512,
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
                if (dx * dx + dy * dy + dz * dz < minSpacing * minSpacing)
                  return false;
              }
          }
      return true;
    };
    const acceptedTrees: Tree[] = [];
    for (let k = 0; k < n && acceptedTrees.length < max; k++) {
      const e = sampleData[k * 4],
        m = sampleData[k * 4 + 1],
        dens = sampleData[k * 4 + 2],
        dy = dirs[k * 3 + 1],
        tp = 1 - 1.1 * dy * dy - 1.2 * Math.max(e, 0);
      if (
        e < 0.03 ||
        e > 0.55 ||
        tp < S.snowline + 0.02 ||
        sampleData[k * 4 + 3] > 0.6 ||
        rand() > dens + 0.004
      )
        continue;
      const x = dirs[k * 3] * planetRadius,
        y = dy * planetRadius,
        z = dirs[k * 3 + 2] * planetRadius;
      if (!free(x, y, z)) continue;
      const speciesIdx = pickSpecies(e, tp, m, stand[k * 4]),
        id = acceptedTrees.length,
        kk = key(cell(x), cell(y), cell(z));
      px.push(x);
      py.push(y);
      pz.push(z);
      (grid.get(kk) ?? grid.set(kk, []).get(kk)!).push(id);
      acceptedTrees.push({
        candidateIndex: k,
        speciesIndex: speciesIdx,
        ...this.style(speciesIdx, tp, m, e, rand),
      });
    }
    const acceptedDirs = new Float32Array(acceptedTrees.length * 3);
    acceptedTrees.forEach((t, i) =>
      acceptedDirs.set(
        dirs.subarray(t.candidateIndex * 3, t.candidateIndex * 3 + 3),
        i * 3,
      ),
    );
    const coarseRadii = this.sample(acceptedDirs, 2),
      idsBySpecies = highDetailGeos.map(() => [] as number[]);
    acceptedTrees.forEach((t, i) => idsBySpecies[t.speciesIndex].push(i));
    idsBySpecies.forEach((ids, si) => {
      const cnt = ids.length,
        cap = Math.max(1, cnt);
      const lists: Lists = {
        count: cnt,
        dir: new Float32Array(cnt * 3),
        scale: new Float32Array(cnt),
        scaleWidth: new Float32Array(cnt),
        scaleHeight: new Float32Array(cnt),
        tiltX: new Float32Array(cnt),
        tiltZ: new Float32Array(cnt),
        yaw: new Float32Array(cnt),
        tint: new Float32Array(cnt * 3),
        far: new Float32Array(cnt * 16),
        exM: new Float32Array(cnt * 16),
        has: new Uint8Array(cnt),
      };
      ids.forEach((a, j) => {
        const t = acceptedTrees[a];
        lists.dir.set(acceptedDirs.subarray(a * 3, a * 3 + 3), j * 3);
        lists.scale[j] = t.scale;
        lists.scaleWidth[j] = t.widthScale;
        lists.scaleHeight[j] = t.heightScale;
        lists.tiltX[j] = t.tiltX;
        lists.tiltZ[j] = t.tiltZ;
        lists.yaw[j] = t.yaw;
        lists.tint.set(t.color, j * 3);
        this.place(lists, j, coarseRadii[a * 4] - 0.15, lists.far, j * 16);
      });
      const makeInstancedMesh = (
        geo: THREE.BufferGeometry,
        tier: number,
      ) => {
        const mesh = new THREE.InstancedMesh(geo, treeMats[tier], cap);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(cap * 3),
          3,
        );
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        return mesh;
      };
      const speciesMeshes = [
        makeInstancedMesh(highDetailGeos[si], 0),
        makeInstancedMesh(midDetailGeos[si], 1),
        makeInstancedMesh(lowDetailGeos[si], 2),
      ];
      speciesMeshes[0].castShadow = speciesMeshes[0].receiveShadow = true;
      speciesMeshes[0].visible = speciesMeshes[1].visible = false;
      const lowDetailMesh = speciesMeshes[2];
      (lowDetailMesh.instanceMatrix.array as Float32Array).set(lists.far);
      (lowDetailMesh.instanceColor!.array as Float32Array).set(lists.tint); // static low-poly tier uploaded once
      lowDetailMesh.count = cnt;
      lowDetailMesh.visible = cnt > 0;
      lowDetailMesh.instanceMatrix.needsUpdate = true;
      lowDetailMesh.instanceColor!.needsUpdate = true;
      this.speciesLists.push({ ...lists, m: speciesMeshes });
    });
  }

  /** Solid trunks within radiusM of a unit direction (for the collider). */
  collect(dir: THREE.Vector3, radiusM: number, out: Obs[]) {
    const thr = Math.cos(radiusM / this.pl.radius);
    this.speciesLists.forEach((lists, i) => {
      const base = TRUNK[i];
      for (let k = 0; k < lists.count; k++) {
        const dx = lists.dir[k * 3],
          dy = lists.dir[k * 3 + 1],
          dz = lists.dir[k * 3 + 2];
        if (dx * dir.x + dy * dir.y + dz * dir.z < thr) continue;
        const d = new THREE.Vector3(dx, dy, dz),
          r = (base + 0.05) * lists.scale[k] * lists.scaleWidth[k];
        out.push({
          d,
          ax: new THREE.Vector3()
            .crossVectors(d, Math.abs(dy) < 0.99 ? UP : new THREE.Vector3(1, 0, 0))
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
    if (cam.distanceTo(this.last) < 6) return;
    this.last.copy(cam);
    const planetRadius = this.pl.radius,
      camLength = cam.length(),
      camDirX = cam.x / camLength,
      camDirY = cam.y / camLength,
      camDirZ = cam.z / camLength,
      horizonThreshold = planetRadius / camLength - 0.06,
      near = camLength - planetRadius < 400,
      distanceToCosAngle = (m: number) => Math.cos(Math.min(1.5, m / planetRadius));
    const highDetailThreshold = distanceToCosAngle(H1 + 15),
      midNearThreshold = distanceToCosAngle(H0 - 15),
      midFarThreshold = distanceToCosAngle(M1 + 15);
    for (const lists of this.speciesLists) {
      const tierCounts = [0, 0],
        matrixArrays = lists.m.map(
          (mesh) => mesh.instanceMatrix.array as Float32Array,
        ),
        colorArrays = lists.m.map(
          (mesh) => mesh.instanceColor!.array as Float32Array,
        ),
        exactMatrices = lists.exM;
      for (let k = 0; k < lists.count; k++) {
        const dx = lists.dir[k * 3],
          dy = lists.dir[k * 3 + 1],
          dz = lists.dir[k * 3 + 2],
          dot = dx * camDirX + dy * camDirY + dz * camDirZ;
        if (dot < horizonThreshold) continue;
        const inHi = near && dot > highDetailThreshold,
          inMid = near && dot > midFarThreshold && dot <= midNearThreshold;
        if (!inHi && !inMid) continue;
        const s = k * 16;
        if (!lists.has[k]) {
          this.scratchDir.set(dx, dy, dz);
          this.place(
            lists,
            k,
            this.pl.radiusAt(this.scratchDir) - 0.15,
            exactMatrices,
            s,
          );
          lists.has[k] = 1;
        } // exact ground height, composed once
        for (let t = 0; t < 2; t++)
          if (t === 0 ? inHi : inMid) {
            const w = tierCounts[t] * 16,
              q = tierCounts[t] * 3;
            for (let i = 0; i < 16; i++) matrixArrays[t][w + i] = exactMatrices[s + i];
            colorArrays[t][q] = lists.tint[k * 3];
            colorArrays[t][q + 1] = lists.tint[k * 3 + 1];
            colorArrays[t][q + 2] = lists.tint[k * 3 + 2];
            tierCounts[t]++;
          }
      }
      for (let t = 0; t < 2; t++) {
        // upload only the used range; empty meshes are not drawn at all
        const mesh = lists.m[t];
        mesh.visible = tierCounts[t] > 0;
        mesh.count = tierCounts[t];
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, tierCounts[t] * 16);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.clearUpdateRanges();
        mesh.instanceColor!.addUpdateRange(0, tierCounts[t] * 3);
        mesh.instanceColor!.needsUpdate = true;
      }
    }
  }
}
