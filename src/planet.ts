import * as THREE from "three";
import { Noise3 } from "./noise";
import { S, CFG } from "./config";
import { U, terrainMat, waterFx } from "./fx";
import { syncTerrain } from "./terrain";
import { canBake, bakePoints, Atlas } from "./bake";
import { ChunkManager } from "./chunks";
import { smoothstep, frame } from "./utilgeo";
import { Forest } from "./forest";
import { gpuTier } from "./gpuTier";
import { CurrentPalette, biomeColors } from "./palette";
import { buildLandmarks } from "./landmarks";
import { CloudShell } from "./skyfx";
import { RiverSystem } from "./river";
export { smoothstep, frame };
const DROP = CFG.chunk.drop;

export class Planet {
  group = new THREE.Group();
  radius = S.radius;
  noise = new Noise3(1);
  noise2 = new Noise3(2);
  atlas?: Atlas;
  clouds = new CloudShell();
  cloudRadius = S.radius + CFG.atmosphere.cloudRadiusOffset;
  forest = new Forest(this);
  riverSystem?: RiverSystem;
  landmarks: ReturnType<typeof buildLandmarks> = { list: [], obs: [], tick: () => {} };
  chunks = new ChunkManager(this.group, () => this.radius);
  private elapsedTime = 0;
  private scratchDir = new THREE.Vector3();
  atmosphere = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      sun: { value: new THREE.Vector3(1, 0, 0) },
      col: { value: new THREE.Color(CurrentPalette.atmosphereLimb) },
      fade: { value: 0 },
    },
    vertexShader: `
varying vec3 vN, vW;
void main() {
  vN = normalize(normalMatrix * normal);
  vW = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}`,
    fragmentShader: `
uniform vec3 sun, col;
uniform float fade;
varying vec3 vN, vW;
void main() {
  float a = pow(clamp(-dot(vN, vec3(0., 0., 1.)), 0., 1.), 1.5) * 3.4;
  float l = clamp(dot(vW, sun) + .35, 0., 1.);
  gl_FragColor = vec4(col, a * l * fade);
}`,
  });
  water = new THREE.MeshStandardMaterial({
    color: biomeColors.water,
    transparent: true,
    opacity: CFG.ocean.opacity,
    roughness: CFG.ocean.roughness,
    metalness: CFG.ocean.metalness,
  });
  private base?: {
    N: number;
    dirs: Float32Array;
    index: THREE.BufferAttribute;
  };
  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    waterFx(this.water);
  }

  // Elevation: domain-warped continents + hills + masked ridged mountains; `fine` adds metre-scale detail the coarse mesh can't resolve.
  elevationAt(x: number, y: number, z: number, fine = true) {
    const f = S.frequency,
      o = S.octaves,
      noise = this.noise,
      noise2 = this.noise2,
      w = 0.25,
      q = f * 0.8;
    const wx = x + w * noise2.get(x * q + 11, y * q, z * q),
      wy = y + w * noise2.get(x * q, y * q + 17, z * q),
      wz = z + w * noise2.get(x * q, y * q, z * q + 23);
    const baseFbm = noise.fbm(
        wx * f,
        wy * f,
        wz * f,
        fine ? o : Math.min(o, 5),
        S.lacunarity,
        S.persistence,
      ),
      hills =
        noise.get(wx * f * 3.1 + 9, wy * f * 3.1, wz * f * 3.1) * 0.06;
    const mountainMask = smoothstep(
      -0.1,
      0.35,
      noise2.get(wx * f * 0.6 + 7, wy * f * 0.6, wz * f * 0.6),
    );
    const ridgedNoise = Math.max(
      0,
      1 -
        Math.abs(
          noise2.fbm(
            wx * f * 1.5,
            wy * f * 1.5,
            wz * f * 1.5,
            Math.min(o, 5),
            S.lacunarity,
            S.persistence,
          ) * 2,
        ),
    );
    let elevation =
      baseFbm * 1.1 +
      hills +
      S.mountains *
        mountainMask *
        (ridgedNoise * ridgedNoise * 0.8 +
          (fine
            ? ridgedNoise *
              0.06 *
              noise.get(x * f * 25, y * f * 25, z * f * 25)
            : 0)) -
      S.seaLevel;
    if (fine)
      elevation +=
        noise.get(x * f * 18, y * f * 18, z * f * 18) *
          0.014 *
          (1 + mountainMask) +
        noise.get(x * f * 60, y * f * 60, z * f * 60) * 0.004;
    if (fine && elevation > 0 && elevation < 0.09)
      elevation +=
        noise.get(x * f * 35 + 5, y * f * 35, z * f * 35) *
        0.008 *
        (1 - smoothstep(0.02, 0.09, elevation)); // beach dunes
    return elevation < 0 ? elevation * 0.5 : elevation;
  }
  elev(d: THREE.Vector3) {
    return this.elevationAt(d.x, d.y, d.z);
  }
  radiusAt(d: THREE.Vector3) {
    return this.radius + this.elev(d) * S.amplitude;
  }
  moistureAt(d: THREE.Vector3) {
    return this.noise2.get(
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
      fr = frame(d, 1, 1),
      dn = d.dot(fr.normal),
      A = ((d.dot(fr.tangentU) / dn + 1) / 2) * N,
      B = ((d.dot(fr.tangentV) / dn + 1) / 2) * N;
    const i = Math.min(N - 1, Math.floor(A)),
      j = Math.min(N - 1, Math.floor(B)),
      fa = A - i,
      fb = B - j,
      sampleDir = this.scratchDir;
    const g = (a: number, b: number) => {
      sampleDir
        .copy(fr.normal)
        .addScaledVector(fr.tangentU, (2 * a) / N - 1)
        .addScaledVector(fr.tangentV, (2 * b) / N - 1)
        .normalize();
      return (
        this.radius +
        this.elevationAt(sampleDir.x, sampleDir.y, sampleDir.z, false) *
          S.amplitude -
        DROP
      );
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
      const n = new THREE.Vector3(f[0], f[1], f[2]),
        u = f[1] ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0),
        v = new THREE.Vector3().crossVectors(n, u),
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

  async build() {
    this.radius = S.radius;
    this.noise = new Noise3(S.seed);
    this.noise2 = new Noise3(S.seed + 101);
    syncTerrain(S, this.noise, this.noise2);
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
    const baseMesh = this.getBase(S.resolution),
      vertexCount = baseMesh.dirs.length / 3,
      dir = new THREE.Vector3(),
      pos = new Float32Array(baseMesh.dirs.length),
      elevations = new Float32Array(vertexCount),
      moistures = new Float32Array(vertexCount);
    if (canBake()) {
      // modes 0 (elevation/moisture) and 3 (normals) are independent — bake in parallel
      const [baked, normalReadback] = await Promise.all([
        bakePoints(baseMesh.dirs, 0),
        bakePoints(baseMesh.dirs, 3),
      ]);
      for (let i = 0; i < vertexCount; i++) {
        elevations[i] = baked[i * 4];
        moistures[i] = baked[i * 4 + 1];
      }
      for (let i = 0; i < vertexCount; i++)
        dir
          .fromArray(baseMesh.dirs, i * 3)
          .multiplyScalar(this.radius + elevations[i] * S.amplitude - DROP)
          .toArray(pos, i * 3);
      const geo = new THREE.BufferGeometry();
      geo.setIndex(baseMesh.index);
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      // analytic normals + biome colours baked on the GPU once; the per-frame vertex shader only reads attributes
      const elevMoistArray = new Float32Array(vertexCount * 2);
      for (let i = 0; i < vertexCount; i++) {
        elevMoistArray[i * 2] = elevations[i];
        elevMoistArray[i * 2 + 1] = moistures[i];
      }
      const normalArray = new Float32Array(vertexCount * 3);
      for (let i = 0; i < vertexCount; i++) {
        normalArray[i * 3]     = normalReadback[i * 4];
        normalArray[i * 3 + 1] = normalReadback[i * 4 + 1];
        normalArray[i * 3 + 2] = normalReadback[i * 4 + 2];
      }
      const colorReadback = await bakePoints(baseMesh.dirs, 4, {
        nrm: normalArray,
        em: elevMoistArray,
      }),
        colorArray = new Float32Array(vertexCount * 3);
      for (let i = 0; i < vertexCount; i++) {
        colorArray[i * 3]     = colorReadback[i * 4];
        colorArray[i * 3 + 1] = colorReadback[i * 4 + 1];
        colorArray[i * 3 + 2] = colorReadback[i * 4 + 2];
      }
      geo.setAttribute("normal", new THREE.BufferAttribute(normalArray, 3));
      geo.setAttribute("aCol",   new THREE.BufferAttribute(colorArray, 3));
      geo.setAttribute("aE",     new THREE.BufferAttribute(elevations, 1));
      geo.setAttribute("aM",     new THREE.BufferAttribute(moistures, 1));
      const terrain = new THREE.Mesh(geo, terrainMat(false, false, {}, true));
      terrain.receiveShadow = false;
      this.group.add(terrain);
    } else {
      for (let i = 0; i < vertexCount; i++) {
        dir.fromArray(baseMesh.dirs, i * 3);
        elevations[i] = this.elevationAt(dir.x, dir.y, dir.z, false);
        moistures[i] = this.moistureAt(dir);
      }
      for (let i = 0; i < vertexCount; i++)
        dir
          .fromArray(baseMesh.dirs, i * 3)
          .multiplyScalar(this.radius + elevations[i] * S.amplitude - DROP)
          .toArray(pos, i * 3);
      const geo = new THREE.BufferGeometry();
      geo.setIndex(baseMesh.index);
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      geo.setAttribute("aE", new THREE.BufferAttribute(elevations, 1));
      geo.setAttribute("aM", new THREE.BufferAttribute(moistures, 1));
      const terrain = new THREE.Mesh(geo, terrainMat(false, false, {}, false));
      terrain.receiveShadow = false;
      this.group.add(terrain);
    }
    this.water.color.set(biomeColors.water);
    this.atmosphere.uniforms.col.value.set(CurrentPalette.atmosphereLimb);
    this.cloudRadius = this.radius + Math.max(110, S.amplitude * 1.3 + 50);
    U.uCloudR.value = this.cloudRadius; // clouds float above the highest peaks
    const waterMesh = new THREE.Mesh(
        new THREE.SphereGeometry(this.radius, gpuTier === 'low' ? 32 : 64, gpuTier === 'low' ? 24 : 48),
        this.water,
      ),
      cloudMesh = this.clouds.make(this.cloudRadius),
      atmosphereMesh = new THREE.Mesh(
        new THREE.SphereGeometry(this.cloudRadius * 1.05, gpuTier === 'low' ? 24 : 48, gpuTier === 'low' ? 16 : 32),
        this.atmosphere,
      );
    cloudMesh.renderOrder = 10;
    atmosphereMesh.renderOrder = 12;
    this.group.add(waterMesh, cloudMesh, atmosphereMesh);
    await this.forest.build();
    this.group.add(this.forest.group);
    const landmarkGroup = new THREE.Group();
    this.landmarks = buildLandmarks(this, landmarkGroup);
    this.group.add(landmarkGroup);
    this.riverSystem?.dispose();
    this.riverSystem = new RiverSystem(this);
    this.group.add(this.riverSystem.mesh);
  }
  /** Per-frame animation: landmarks, planet cube-map bake/fade-in, chunk fades. */
  tick(dt: number) {
    this.elapsedTime += dt;
    this.landmarks.tick(this.elapsedTime);
    if (this.atlas) {
      if (!this.atlas.done) this.atlas.step();
      else if (U.uAtOn.value < 1)
        U.uAtOn.value = Math.min(1, U.uAtOn.value + dt * 1.5);
    }
    this.chunks.tick(dt);
  }
  /** Streams terrain chunks around the player (direction playerDirection, altitude altitude). */
  update(playerDirection: THREE.Vector3, altitude: number) {
    this.chunks.update(playerDirection, altitude);
  }
}
