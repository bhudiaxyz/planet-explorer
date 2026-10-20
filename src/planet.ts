import * as THREE from "three";
import { Noise3 } from "./noise";
import { S } from "./settings";
import { U, terrainMat, waterFx } from "./fx";
import { syncTerrain } from "./gpu";
import { canBake, bakePoints, Atlas } from "./bake";
import { ChunkManager } from "./chunks";
import { CFG } from "./config";
import { sm, frame } from "./util";
import { Forest } from "./forest";
import { buildLandmarks } from "./landmarks";
import { CloudShell } from "./skyfx";
export { sm, frame };
const V = THREE.Vector3,
  DROP = CFG.chunk.drop;

export class Planet {
  group = new THREE.Group();
  R = S.radius;
  n = new Noise3(1);
  n2 = new Noise3(2);
  atlas?: Atlas;
  clouds = new CloudShell();
  cloudR = S.radius + 120;
  forest = new Forest(this);
  lm: ReturnType<typeof buildLandmarks> = { list: [], obs: [], tick: () => {} };
  chunks = new ChunkManager(this.group, () => this.R);
  private t = 0;
  atmo = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      sun: { value: new V(1, 0, 0) },
      col: { value: new THREE.Color(0x5aa0ff) },
      fade: { value: 0 },
    },
    vertexShader:
      "varying vec3 vN,vW;void main(){vN=normalize(normalMatrix*normal);vW=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
    fragmentShader:
      "uniform vec3 sun,col;uniform float fade;varying vec3 vN,vW;void main(){float a=pow(clamp(-dot(vN,vec3(0.,0.,1.)),0.,1.),1.5)*3.4;float l=clamp(dot(vW,sun)+.35,0.,1.);gl_FragColor=vec4(col,a*l*fade);}",
  });
  waterMat = new THREE.MeshStandardMaterial({
    color: S.colors.water,
    transparent: true,
    opacity: 0.74,
    roughness: 0.2,
    metalness: 0.1,
  });
  private base?: {
    N: number;
    dirs: Float32Array;
    index: THREE.BufferAttribute;
  };
  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    waterFx(this.waterMat);
  }

  // Elevation: domain-warped continents + hills + masked ridged mountains; `fine` adds metre-scale detail the coarse mesh can't resolve.
  e3(x: number, y: number, z: number, fine = true) {
    const f = S.frequency,
      o = S.octaves,
      n = this.n,
      n2 = this.n2,
      w = 0.25,
      q = f * 0.8;
    const wx = x + w * n2.get(x * q + 11, y * q, z * q),
      wy = y + w * n2.get(x * q, y * q + 17, z * q),
      wz = z + w * n2.get(x * q, y * q, z * q + 23);
    const b = n.fbm(
        wx * f,
        wy * f,
        wz * f,
        fine ? o : Math.min(o, 5),
        S.lacunarity,
        S.persistence,
      ),
      hills = n.get(wx * f * 3.1 + 9, wy * f * 3.1, wz * f * 3.1) * 0.06;
    const mask = sm(
      -0.1,
      0.35,
      n2.get(wx * f * 0.6 + 7, wy * f * 0.6, wz * f * 0.6),
    );
    const r = Math.max(
      0,
      1 -
        Math.abs(
          n2.fbm(
            wx * f * 1.5,
            wy * f * 1.5,
            wz * f * 1.5,
            Math.min(o, 5),
            S.lacunarity,
            S.persistence,
          ) * 2,
        ),
    );
    let e =
      b * 1.1 +
      hills +
      S.mountains *
        mask *
        (r * r * 0.8 +
          (fine ? r * 0.06 * n.get(x * f * 25, y * f * 25, z * f * 25) : 0)) -
      S.seaLevel;
    if (fine)
      e +=
        n.get(x * f * 18, y * f * 18, z * f * 18) * 0.014 * (1 + mask) +
        n.get(x * f * 60, y * f * 60, z * f * 60) * 0.004;
    if (fine && e > 0 && e < 0.09)
      e +=
        n.get(x * f * 35 + 5, y * f * 35, z * f * 35) *
        0.008 *
        (1 - sm(0.02, 0.09, e)); // beach dunes
    return e < 0 ? e * 0.5 : e;
  }
  elev(d: THREE.Vector3) {
    return this.e3(d.x, d.y, d.z);
  }
  radiusAt(d: THREE.Vector3) {
    return this.R + this.elev(d) * S.amplitude;
  }
  moist(d: THREE.Vector3) {
    return this.n2.get(
      d.x * S.frequency * 2.2 + 30,
      d.y * S.frequency * 2.2,
      d.z * S.frequency * 2.2,
    );
  }
  temp(d: THREE.Vector3, e: number) {
    return 1 - 1.1 * d.y * d.y - 1.2 * Math.max(e, 0);
  }
  // Height of the coarse render mesh itself (triangle-interpolated), used to seat distant low-LOD trees on what is actually drawn.
  coarseR(d: THREE.Vector3) {
    const N = S.resolution,
      f = frame(d, 1, 1),
      dn = d.dot(f.n),
      A = ((d.dot(f.u) / dn + 1) / 2) * N,
      B = ((d.dot(f.v) / dn + 1) / 2) * N;
    const i = Math.min(N - 1, Math.floor(A)),
      j = Math.min(N - 1, Math.floor(B)),
      fa = A - i,
      fb = B - j,
      q = new V();
    const g = (a: number, b: number) => {
      q.copy(f.n)
        .addScaledVector(f.u, (2 * a) / N - 1)
        .addScaledVector(f.v, (2 * b) / N - 1)
        .normalize();
      return this.R + this.e3(q.x, q.y, q.z, false) * S.amplitude - DROP;
    };
    return fa + fb <= 1
      ? g(i, j) + fa * (g(i + 1, j) - g(i, j)) + fb * (g(i, j + 1) - g(i, j))
      : g(i + 1, j + 1) +
          (1 - fa) * (g(i, j + 1) - g(i + 1, j + 1)) +
          (1 - fb) * (g(i + 1, j) - g(i + 1, j + 1));
  }

  private getBase(N: number) {
    if (this.base?.N === N) return this.base;
    const pos: number[] = [],
      idx: number[] = [];
    for (const f of [
      [0, 0, 1],
      [0, 0, -1],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
    ]) {
      const n = new V(f[0], f[1], f[2]),
        u = f[1] ? new V(1, 0, 0) : new V(0, 1, 0),
        v = new V().crossVectors(n, u),
        o = pos.length / 3;
      for (let j = 0; j <= N; j++)
        for (let i = 0; i <= N; i++) {
          const p = n
            .clone()
            .addScaledVector(u, (2 * i) / N - 1)
            .addScaledVector(v, (2 * j) / N - 1)
            .normalize();
          pos.push(p.x, p.y, p.z);
        }
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const a = o + j * (N + 1) + i,
            b = a + 1,
            c = a + N + 1,
            d = c + 1;
          idx.push(a, b, c, b, d, c);
        }
    }
    return (this.base = {
      N,
      dirs: new Float32Array(pos),
      index: new THREE.BufferAttribute(new Uint32Array(idx), 1),
    }); // unmerged: GPU normals are position-based, so no seams and no slow vertex merge
  }

  build() {
    this.R = S.radius;
    this.n = new Noise3(S.seed);
    this.n2 = new Noise3(S.seed + 101);
    syncTerrain(S, this.n, this.n2);
    this.chunks.clear();
    if (canBake()) {
      this.atlas ??= new Atlas();
      U.uCubeN.value = this.atlas.rtN.texture;
      U.uCubeC.value = this.atlas.rtC.texture;
      this.atlas.reset();
      U.uAtOn.value = 0;
    }
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    const b = this.getBase(S.resolution),
      cnt = b.dirs.length / 3,
      d = new V(),
      pos = new Float32Array(b.dirs.length),
      es = new Float32Array(cnt),
      ms = new Float32Array(cnt);
    if (canBake()) {
      const o = bakePoints(b.dirs, 0);
      for (let i = 0; i < cnt; i++) {
        es[i] = o[i * 4];
        ms[i] = o[i * 4 + 1];
      }
    } else
      for (let i = 0; i < cnt; i++) {
        d.fromArray(b.dirs, i * 3);
        es[i] = this.e3(d.x, d.y, d.z, false);
        ms[i] = this.moist(d);
      }
    for (let i = 0; i < cnt; i++)
      d.fromArray(b.dirs, i * 3)
        .multiplyScalar(this.R + es[i] * S.amplitude - DROP)
        .toArray(pos, i * 3);
    const geo = new THREE.BufferGeometry();
    geo.setIndex(b.index);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    let baked = false;
    if (canBake()) {
      // analytic normals + biome colours baked on the GPU once; the per-frame vertex shader only reads attributes
      const nr = bakePoints(b.dirs, 3),
        nn = new Float32Array(cnt * 3),
        em = new Float32Array(cnt * 2),
        cc = new Float32Array(cnt * 3);
      for (let i = 0; i < cnt; i++) {
        nn[i * 3] = nr[i * 4];
        nn[i * 3 + 1] = nr[i * 4 + 1];
        nn[i * 3 + 2] = nr[i * 4 + 2];
        em[i * 2] = es[i];
        em[i * 2 + 1] = ms[i];
      }
      const cr = bakePoints(b.dirs, 4, { nrm: nn, em });
      for (let i = 0; i < cnt; i++) {
        cc[i * 3] = cr[i * 4];
        cc[i * 3 + 1] = cr[i * 4 + 1];
        cc[i * 3 + 2] = cr[i * 4 + 2];
      }
      geo.setAttribute("normal", new THREE.BufferAttribute(nn, 3));
      geo.setAttribute("aCol", new THREE.BufferAttribute(cc, 3));
      baked = true;
    } else geo.computeVertexNormals();
    geo.setAttribute("aE", new THREE.BufferAttribute(es, 1));
    geo.setAttribute("aM", new THREE.BufferAttribute(ms, 1));
    const terrain = new THREE.Mesh(geo, terrainMat(false, false, {}, baked));
    terrain.receiveShadow = false;
    this.group.add(terrain);
    this.waterMat.color.set(S.colors.water);
    this.cloudR = this.R + Math.max(110, S.amplitude * 1.3 + 50);
    U.uCloudR.value = this.cloudR; // clouds float above the highest peaks
    const water = new THREE.Mesh(
        new THREE.SphereGeometry(this.R, 160, 120),
        this.waterMat,
      ),
      cl = this.clouds.make(this.cloudR),
      atm = new THREE.Mesh(
        new THREE.SphereGeometry(this.cloudR * 1.05, 96, 64),
        this.atmo,
      );
    cl.renderOrder = 10;
    atm.renderOrder = 12;
    this.group.add(water, cl, atm);
    this.forest.build();
    this.group.add(this.forest.group);
    const lg = new THREE.Group();
    this.lm = buildLandmarks(this, lg);
    this.group.add(lg);
  }
  /** Per-frame animation: landmarks, planet cube-map bake/fade-in, chunk fades. */
  tick(dt: number) {
    this.t += dt;
    this.lm.tick(this.t);
    if (this.atlas) {
      if (!this.atlas.done) this.atlas.step();
      else if (U.uAtOn.value < 1)
        U.uAtOn.value = Math.min(1, U.uAtOn.value + dt * 1.5);
    }
    this.chunks.tick(dt);
  }
  /** Streams terrain chunks around the player (direction d, altitude alt). */
  update(d: THREE.Vector3, alt: number) {
    this.chunks.update(d, alt);
  }
}
