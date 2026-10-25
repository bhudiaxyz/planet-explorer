import * as THREE from "three";
import type { Planet } from "./planet";
import { S, CFG } from "./config";
import { U } from "./fx";
import { gpuTier } from "./gpuTier";
import { rng } from "./noise";

export class RiverSystem {
  mesh: THREE.Mesh;

  constructor(planet: Planet) {
    const paths = this._generatePaths(planet);
    const geo = this._buildGeometry(paths, planet);
    const mat = this._buildMaterial();
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1; // render after opaque terrain, before atmosphere
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }

  private _generatePaths(planet: Planet): THREE.Vector3[][] {
    const R = planet.radius;
    const cfg = CFG.river;
    const rand = rng(S.seed + 9999);
    const cosMin = Math.cos((cfg.minSourceSpacingDeg * Math.PI) / 180);

    // Find main river sources: high elevation, high moisture, well spaced
    const sources: THREE.Vector3[] = [];
    let attempts = 0;
    while (sources.length < cfg.count && attempts < 500) {
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
      const main = this._tracePath(src, planet, R);
      if (main.length < 5) continue;
      paths.push(main);

      // Tributaries: branch off the main path at 30–50% along
      for (let t = 0; t < cfg.tributaries; t++) {
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

    return paths;
  }

  private _tracePath(source: THREE.Vector3, planet: Planet, R: number): THREE.Vector3[] {
    const cfg = CFG.river;
    const stepRad = cfg.stepSize / R; // step in radians on unit sphere
    // 8 compass directions on the sphere tangent plane
    const DIRS = [0, 1, 2, 3, 4, 5, 6, 7].map(i => (i * Math.PI) / 4);

    const path: THREE.Vector3[] = [];
    let cur = source.clone().normalize();

    for (let step = 0; step < cfg.maxSteps; step++) {
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
    const indices: number[] = [];
    let base = 0;

    for (const path of paths) {
      if (path.length < 2) continue;
      const n = path.length;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const width = cfg.widthStart + (cfg.widthEnd - cfg.widthStart) * t;
        const pt = path[i];
        // tangent along path
        const next = path[Math.min(i + 1, n - 1)];
        const prev = path[Math.max(i - 1, 0)];
        const tangent = next.clone().sub(prev).normalize();
        const up = pt.clone().normalize();
        const right = new THREE.Vector3().crossVectors(tangent, up).normalize();
        // two ribbon verts
        positions.push(
          pt.x + right.x * width * 0.5,
          pt.y + right.y * width * 0.5,
          pt.z + right.z * width * 0.5,
          pt.x - right.x * width * 0.5,
          pt.y - right.y * width * 0.5,
          pt.z - right.z * width * 0.5,
        );
        if (i < n - 1) {
          const b = base + i * 2;
          indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
      }
      base += n * 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    return geo;
  }

  private _buildMaterial(): THREE.Material {
    return new THREE.MeshBasicMaterial({
      color: 0x4a8fc2,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }
}

// suppress unused import warnings — these are skeleton imports for future tasks
void U;
void gpuTier;
