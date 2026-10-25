import * as THREE from "three";
import type { Planet } from "./planet";
import { S, CFG } from "./config";
import { U } from "./fx";
import { gpuTier } from "./gpuTier";
import { rng } from "./noise";

// Chaikin corner-cutting: replaces each segment with two points at 1/4 and 3/4,
// preserving the first and last point so source/mouth stay in place.
function chaikin(pts: THREE.Vector3[], rounds: number): THREE.Vector3[] {
  let p = pts;
  for (let r = 0; r < rounds; r++) {
    const out: THREE.Vector3[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      out.push(p[i].clone().lerp(p[i + 1], 0.25));
      out.push(p[i].clone().lerp(p[i + 1], 0.75));
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

const RIVER_NAMES = [
  "Ardenvale","Blackwater","Coldrun","Deepflow","Embervein",
  "Frostmere","Greystone","Hollow Brook","Ironstream","Jade Run",
  "Keldmere","Longwater","Mistfall","Nightveil","Orvenmere",
  "Pale Current","Quicksilver","Redmere","Silverrun","Thornwater",
  "Umbraveil","Veldmere","Whitefall","Xandrel","Yewbrook","Zephyrvale",
];
// Pick a river name seeded by path index + world seed so it's stable per planet
function riverName(index: number): string {
  return RIVER_NAMES[(S.seed + index * 7) % RIVER_NAMES.length];
}

export class RiverSystem {
  mesh: THREE.Mesh;
  readonly paths: THREE.Vector3[][];
  readonly names: string[];

  constructor(planet: Planet) {
    const paths = this._generatePaths(planet);
    this.paths = paths;
    this.names = paths.map((_, i) => riverName(i));
    const geo = this._buildGeometry(paths, planet);
    const mat = this._buildMaterial();
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2; // render after water (1), before clouds (10)
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }

  private _generatePaths(planet: Planet): THREE.Vector3[][] {
    const R = planet.radius;
    const cfg = CFG.river;
    // Reduce CPU path work on low-tier mobile (fewer rivers, shorter paths)
    const tierCount = gpuTier === 'low' ? Math.max(2, Math.ceil(cfg.count / 2)) : cfg.count;
    const tierMaxSteps = gpuTier === 'low' ? Math.ceil(cfg.maxSteps * 0.6) : cfg.maxSteps;
    const tierTributaries = gpuTier === 'low' ? 1 : cfg.tributaries;
    const rand = rng(S.seed + 9999);
    const cosMin = Math.cos((cfg.minSourceSpacingDeg * Math.PI) / 180);

    // Find main river sources: high elevation, high moisture, well spaced
    const sources: THREE.Vector3[] = [];
    let attempts = 0;
    while (sources.length < tierCount && attempts < 500) {
      attempts++;
      // Random point on unit sphere
      const u = rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const dir = new THREE.Vector3(r * Math.cos(phi), u, r * Math.sin(phi));
      const elev = planet.elevationAt(dir.x, dir.y, dir.z, false);
      const moist = planet.moistureAt(dir);
      if (elev < cfg.sourceMinElev) continue;
      if (moist < cfg.sourceMinMoisture) continue;
      // Check spacing from existing sources
      if (sources.some(s => s.dot(dir) > cosMin)) continue;
      sources.push(dir.clone());
    }

    const paths: THREE.Vector3[][] = [];

    for (const src of sources) {
      // Main river path
      const main = this._tracePath(src, planet, R, tierMaxSteps);
      if (main.length < 5) continue;
      paths.push(main);

      // Tributaries: branch off the main path at 30–50% along
      for (let t = 0; t < tierTributaries; t++) {
        const junctionIdx = Math.floor(
          (0.3 + rand() * 0.2) * main.length
        );
        const junctionPt = main[junctionIdx];
        // Offset perpendicular on sphere by ~20 degrees
        const perpAngle = (t % 2 === 0 ? 1 : -1) * 20 * (Math.PI / 180);
        const perp = new THREE.Vector3()
          .crossVectors(junctionPt, new THREE.Vector3(0, 1, 0.001).normalize())
          .normalize();
        const tributaryStart = junctionPt.clone()
          .applyAxisAngle(perp, perpAngle)
          .normalize();
        // Find a high point near this direction
        const tElev = planet.elevationAt(tributaryStart.x, tributaryStart.y, tributaryStart.z, false);
        if (tElev > cfg.sourceMinElev * 0.5) {
          const trib = this._tracePathToTarget(tributaryStart, junctionPt, planet, R);
          if (trib.length >= 4) paths.push(trib);
        }
      }
    }

    // Smooth paths to remove 8-direction grid kinks — Chaikin subdivision
    // Low tier: skip (saves memory), medium/high: 2 rounds (180pts → 720)
    const rounds = gpuTier === 'low' ? 0 : 2;
    return paths.map(p => chaikin(p, rounds));
  }

  private _tracePath(source: THREE.Vector3, planet: Planet, R: number, maxSteps: number = CFG.river.maxSteps): THREE.Vector3[] {
    const cfg = CFG.river;
    const stepRad = cfg.stepSize / R; // step in radians on unit sphere
    // 8 compass directions on the sphere tangent plane
    const DIRS = [0, 1, 2, 3, 4, 5, 6, 7].map(i => (i * Math.PI) / 4);

    const path: THREE.Vector3[] = [];
    let cur = source.clone().normalize();

    for (let step = 0; step < maxSteps; step++) {
      const curElev = planet.elevationAt(cur.x, cur.y, cur.z, false);
      path.push(cur.clone().multiplyScalar(R + curElev * S.amplitude + cfg.surfaceOffset));

      if (curElev <= S.seaLevel) break;

      // Build tangent frame
      const up = cur.clone();
      const ref = Math.abs(up.y) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const east = new THREE.Vector3().crossVectors(up, ref).normalize();
      const north = new THREE.Vector3().crossVectors(east, up).normalize();

      // Sample 8 neighbours and pick the steepest descent
      let bestElev = curElev;
      let bestDir: THREE.Vector3 | null = null;
      for (const angle of DIRS) {
        const offset = east.clone().multiplyScalar(Math.cos(angle) * stepRad)
          .addScaledVector(north, Math.sin(angle) * stepRad);
        const neighbour = cur.clone().add(offset).normalize();
        const nElev = planet.elevationAt(neighbour.x, neighbour.y, neighbour.z, false);
        if (nElev < bestElev) {
          bestElev = nElev;
          bestDir = neighbour;
        }
      }

      if (!bestDir) break; // basin/flat — stop
      cur = bestDir;
    }

    return path;
  }

  private _tracePathToTarget(
    source: THREE.Vector3,
    target: THREE.Vector3,
    planet: Planet,
    R: number,
  ): THREE.Vector3[] {
    const cfg = CFG.river;
    const stepRad = cfg.stepSize / R;
    const DIRS = [0, 1, 2, 3, 4, 5, 6, 7].map(i => (i * Math.PI) / 4);

    const path: THREE.Vector3[] = [];
    let cur = source.clone().normalize();

    for (let step = 0; step < cfg.maxSteps; step++) {
      const curElev = planet.elevationAt(cur.x, cur.y, cur.z, false);
      path.push(cur.clone().multiplyScalar(R + curElev * S.amplitude + cfg.surfaceOffset));

      // Stop if we've reached the target junction area
      if (cur.distanceTo(target.clone().normalize()) < stepRad * 3) break;
      if (curElev <= S.seaLevel) break;

      const up = cur.clone();
      const ref = Math.abs(up.y) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const east = new THREE.Vector3().crossVectors(up, ref).normalize();
      const north = new THREE.Vector3().crossVectors(east, up).normalize();

      // Weight: 70% downhill, 30% toward target
      let bestScore = Infinity;
      let bestDir: THREE.Vector3 | null = null;
      for (const angle of DIRS) {
        const offset = east.clone().multiplyScalar(Math.cos(angle) * stepRad)
          .addScaledVector(north, Math.sin(angle) * stepRad);
        const neighbour = cur.clone().add(offset).normalize();
        const nElev = planet.elevationAt(neighbour.x, neighbour.y, neighbour.z, false);
        const distToTarget = neighbour.distanceTo(target.clone().normalize());
        const score = nElev * 0.7 + distToTarget * 0.3;
        if (score < bestScore) {
          bestScore = score;
          bestDir = neighbour;
        }
      }

      if (!bestDir) break;
      cur = bestDir;
    }

    return path;
  }

  private _buildGeometry(paths: THREE.Vector3[][], planet: Planet): THREE.BufferGeometry {
    const cfg = CFG.river;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (const path of paths) {
      if (path.length < 2) continue;
      const N = path.length;
      const baseVertex = positions.length / 3;

      // Compute arc-length for v coordinate
      const arcLen: number[] = [0];
      for (let i = 1; i < N; i++) {
        arcLen.push(arcLen[i - 1] + path[i].distanceTo(path[i - 1]));
      }
      const totalLen = arcLen[N - 1] || 1;

      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        // Widen with quadratic ease-in, then taper the last 20% so the mouth
        // doesn't end in a blunt flat cut where the ribbon meets the ocean
        const taper = t > 0.8 ? 1.0 - ((t - 0.8) / 0.2) * 0.75 : 1.0;
        const width = (cfg.widthStart + (cfg.widthEnd - cfg.widthStart) * (t * t)) * taper;
        const halfW = width * 0.5;

        // Sphere normal = outward unit direction from centre
        const sphereNormal = path[i].clone().normalize();

        // Tangent: direction of flow
        const tangent = i < N - 1
          ? path[i + 1].clone().sub(path[i]).normalize()
          : path[i].clone().sub(path[i - 1]).normalize();

        // Ribbon right = tangent × sphereNormal (cross gives perpendicular on sphere surface)
        const right = new THREE.Vector3().crossVectors(tangent, sphereNormal).normalize();

        // Left and right vertices
        const left = path[i].clone().addScaledVector(right, -halfW);
        const right3 = path[i].clone().addScaledVector(right, halfW);

        const v = arcLen[i] / totalLen;

        // Left vertex
        positions.push(left.x, left.y, left.z);
        normals.push(sphereNormal.x, sphereNormal.y, sphereNormal.z);
        uvs.push(0, v);

        // Right vertex
        positions.push(right3.x, right3.y, right3.z);
        normals.push(sphereNormal.x, sphereNormal.y, sphereNormal.z);
        uvs.push(1, v);
      }

      // Quad indices for this path
      for (let i = 0; i < N - 1; i++) {
        const a = baseVertex + i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("normal",   new THREE.BufferAttribute(new Float32Array(normals), 3));
    geo.setAttribute("uv",       new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(indices);
    return geo;
  }

  private _buildMaterial(): THREE.Material {
    if (gpuTier === 'low') {
      return new THREE.MeshBasicMaterial({
        color: 0x4a7a9b,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }

    const highDetail = gpuTier === 'high' ? 1.0 : 0.0;

    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: U.uTime,
        uHighDetail: { value: highDetail },
        uSun: U.uSun,
      },
      vertexShader: `
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}`,
      fragmentShader: `
uniform float uTime;
uniform float uHighDetail;
uniform vec3 uSun;

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  // Flow speed: fast at source (vUv.y≈0, narrow), slow at mouth (vUv.y≈1, wide)
  float flowSpeed = mix(0.9, 0.2, vUv.y);
  float v = fract(vUv.y - uTime * flowSpeed);

  // Edge mask: centre=1, banks=0 — deep vs shallow colour
  float edgeMask = smoothstep(0.0, 0.25, vUv.x) * (1.0 - smoothstep(0.75, 1.0, vUv.x));
  vec3 deepColor    = vec3(0.05, 0.18, 0.32);
  vec3 shallowColor = vec3(0.18, 0.44, 0.55);
  vec3 baseColor = mix(shallowColor, deepColor, edgeMask);

  vec3 viewDir = normalize(cameraPosition - vWorldPos);

  // Fresnel rim brightening
  float fresnel = pow(1.0 - max(0.0, dot(viewDir, vWorldNormal)), 2.5);
  baseColor += vec3(0.25, 0.45, 0.55) * fresnel * 0.5;

  // Sun specular — glinting highlight on water surface
  vec3 halfVec = normalize(viewDir + normalize(uSun));
  float spec = pow(max(0.0, dot(vWorldNormal, halfVec)), 48.0);
  baseColor += vec3(1.0, 0.97, 0.85) * spec * 0.7;

  // High-detail: ripple normal disturbance + bank foam
  float foam = 0.0;
  if (uHighDetail > 0.5) {
    // Two overlapping ripple frequencies give cross-hatched surface texture
    float r1 = sin(v * 10.0 + uTime * 2.5) * 0.5 + 0.5;
    float r2 = sin(v * 6.0 - uTime * 1.8 + vUv.x * 4.0) * 0.5 + 0.5;
    baseColor += vec3(0.08, 0.14, 0.18) * (r1 * r2) * 0.2;
    // White foam at banks where water meets land
    foam = smoothstep(0.78, 0.92, vUv.x) + smoothstep(0.22, 0.08, vUv.x);
    baseColor = mix(baseColor, vec3(0.88, 0.94, 0.97), foam * 0.55);
  }

  float alpha = mix(0.65, 0.90, edgeMask) + fresnel * 0.08 + foam * 0.1;
  gl_FragColor = vec4(baseColor, clamp(alpha, 0.0, 0.95));
}`,
    });
  }
}
