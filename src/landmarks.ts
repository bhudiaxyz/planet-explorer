import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Planet } from "./planet";
import type { Obs } from "./collision";
import { rng } from "./noise";
import { S } from "./settings";
import { CurrentPalette } from "./palette";
const UP = new THREE.Vector3(0, 1, 0);
export type Landmark = { name: string; pos: THREE.Vector3 };
// Rare deterministic landmarks: monolith rings, twisted spires, tombstone fields, floating islands.
// Each landmark's parts are baked into ONE vertex-coloured mesh (about 210 draw calls and as many shadow draws become 16).
export function buildLandmarks(pl: Planet, group: THREE.Group) {
  const r = rng(S.seed + 900),
    list: Landmark[] = [],
    obs: Obs[] = [],
    bob: { m: THREE.Object3D; y: number; ph: number }[] = [];
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
  });
  const STONE = new THREE.Color(CurrentPalette.landmarkStone),
    DARK = new THREE.Color(CurrentPalette.landmarkDark),
    TURF = new THREE.Color(CurrentPalette.grass),
    STONE_BARK = new THREE.Color(CurrentPalette.landmarkStoneBark),
    crystalMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const part = (
    parts: THREE.BufferGeometry[],
    geo: THREE.BufferGeometry,
    pos: THREE.Vector3,
    rot: THREE.Euler,
    c: THREE.Color,
    sc?: THREE.Vector3,
  ) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.deleteAttribute("uv");
    g.applyMatrix4(
      new THREE.Matrix4().compose(
        pos,
        new THREE.Quaternion().setFromEuler(rot),
        sc ?? new THREE.Vector3(1, 1, 1),
      ),
    );
    const n = g.attributes.position.count,
      col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.toArray(col, i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    parts.push(g);
  };
  const bake = (parts: THREE.BufferGeometry[]) => {
    const m = new THREE.Mesh(mergeGeometries(parts)!, mat);
    m.castShadow = m.receiveShadow = true;
    return m;
  };
  const kinds = ["ring", "spire", "tombs", "island"];
  let nIsl = 0;
  for (let n = 0; n < 16; n++) {
    const kind = kinds[n % 4],
      d = new THREE.Vector3();
    for (let a = 0; a < 400; a++) {
      d.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
      if (d.lengthSq() > 1 || d.lengthSq() < 0.01) continue;
      d.normalize();
      const e = pl.elev(d);
      if (e > 0.04 && e < 0.3 && pl.temp(d, e) > 0.3) break;
    }
    const g = new THREE.Group(),
      cr = pl.radiusAt(d);
    g.position.copy(d).multiplyScalar(cr);
    g.quaternion.setFromUnitVectors(UP, d);
    g.updateMatrixWorld();
    group.add(g);
    const ground = (x: number, z: number) =>
      pl.radiusAt(g.localToWorld(new THREE.Vector3(x, 0, z)).normalize()) - cr;
    const parts: THREE.BufferGeometry[] = [],
      wd = (x: number, z: number) => g.localToWorld(new THREE.Vector3(x, 0, z)).normalize(),
      wax = (yaw: number) =>
        new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).applyQuaternion(g.quaternion);
    if (kind === "ring") {
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * 6.283,
          h = 8 + r() * 4,
          x = Math.cos(a) * 13,
          z = Math.sin(a) * 13;
        part(
          parts,
          new THREE.BoxGeometry(2.2, h, 1.3),
          new THREE.Vector3(x, ground(x, z) + h / 2 - 0.6, z),
          new THREE.Euler(0, -a, (r() - 0.5) * 0.1),
          STONE,
        );
        obs.push({
          d: wd(x, z),
          ax: wax(-a),
          rx: 1.2,
          rz: 0.75,
          H: Infinity,
          mode: 0,
        });
      }
      g.add(bake(parts));
    } else if (kind === "spire") {
      for (let i = 0; i < 14; i++)
        part(
          parts,
          new THREE.BoxGeometry(5 - i * 0.3, 5.2, 5 - i * 0.3),
          new THREE.Vector3(0, i * 5 + 1, 0),
          new THREE.Euler(0, i * 0.22, 0),
          DARK,
        );
      obs.push({
        d: d.clone(),
        ax: wax(0),
        rx: 3.3,
        rz: 3.3,
        H: Infinity,
        mode: 0,
      });
      g.add(bake(parts));
    } else if (kind === "tombs") {
      for (let i = 0; i < 26; i++) {
        const h = 1.5 + r(),
          a = r() * 6.283,
          rad = r() * 16,
          x = Math.cos(a) * rad,
          z = Math.sin(a) * rad;
        const yaw = r() * 6.283;
        part(
          parts,
          new THREE.BoxGeometry(0.8, h, 0.3),
          new THREE.Vector3(x, ground(x, z) + 0.5, z),
          new THREE.Euler((r() - 0.5) * 0.3, yaw, (r() - 0.5) * 0.3),
          STONE,
        );
        obs.push({
          d: wd(x, z),
          ax: wax(yaw),
          rx: 0.5,
          rz: 0.25,
          H: Infinity,
          mode: 0,
        });
      }
      g.add(bake(parts));
    } else {
      // every island is different: palette (grass / autumn / teal / violet / frost), 2-4 rock tiers, stalactites, trees, optional pond, waterfall,
      // glowing crystals (HDR, picked up by bloom) and orbiting debris (it rotates with the island), plus a small random tilt
      const v = nIsl++,
        sz = 0.7 + r() * 0.9,
        rad = 10 * sz,
        E = (x: number, y: number, z: number) => new THREE.Euler(x, y, z);
      const turfs = [
          TURF,
          ...CurrentPalette.islandTurf.map(c => new THREE.Color(c)),
        ],
        rocks = CurrentPalette.islandRock;
      const turf = turfs[v % 5],
        rock = new THREE.Color(rocks[(v + ((r() * 3) | 0)) % 4]),
        tiers = 2 + ((r() * 3) | 0),
        crystals: THREE.BufferGeometry[] = [];
      part(
        parts,
        new THREE.CylinderGeometry(rad, rad * 0.95, 1.5, 12),
        new THREE.Vector3(0, 0, 0),
        E(0, r() * 3, 0),
        turf,
      );
      for (let k = 0; k < 5; k++) {
        const a2 = r() * 6.283,
          d2 = rad * (0.75 + r() * 0.2);
        part(
          parts,
          new THREE.IcosahedronGeometry(1, 1),
          new THREE.Vector3(Math.cos(a2) * d2, 0.1, Math.sin(a2) * d2),
          E(0, 0, 0),
          turf.clone().offsetHSL(0, 0, (r() - 0.5) * 0.08),
          new THREE.Vector3(1.2 + r(), 0.5, 1.2 + r()),
        );
      }
      let y = -0.4,
        rr = rad * 0.95;
      for (let t = 0; t < tiers; t++) {
        const h = (7 + r() * 5) * sz * (1 - t * 0.15);
        part(
          parts,
          new THREE.ConeGeometry(rr, h, 7 + ((r() * 4) | 0)),
          new THREE.Vector3((r() - 0.5) * rad * 0.15, y - h / 2, (r() - 0.5) * rad * 0.15),
          E(Math.PI, r() * 3, 0),
          rock.clone().offsetHSL(0, 0, -t * 0.05 + (r() - 0.5) * 0.04),
        );
        y -= h * 0.8;
        rr *= 0.62 + r() * 0.2;
      }
      for (let k = 0, n2 = 4 + ((r() * 5) | 0); k < n2; k++) {
        const a2 = r() * 6.283,
          d2 = r() * rad * 0.6,
          h = (2 + r() * 4) * sz;
        part(
          parts,
          new THREE.ConeGeometry(0.5 + r() * 0.7, h, 5),
          new THREE.Vector3(Math.cos(a2) * d2, y - h / 2 + 1 + r() * 2, Math.sin(a2) * d2),
          E(Math.PI, 0, 0),
          rock,
        );
      }
      const foliage = CurrentPalette.islandFoliage[v % 5];
      // scattered surface boulders
      for (let k = 0, n2 = 2 + ((r() * 4) | 0); k < n2; k++) {
        const a2 = r() * 6.283, d2 = r() * rad * 0.75, s2b = 0.3 + r() * 0.7;
        part(parts, new THREE.IcosahedronGeometry(1, 0),
          new THREE.Vector3(Math.cos(a2) * d2, 0.75 + s2b * 0.4, Math.sin(a2) * d2),
          E(r() * 3, r() * 3, r() * 3),
          rock.clone().offsetHSL(0, 0, (r() - 0.5) * 0.1),
          new THREE.Vector3(s2b, s2b * 0.7, s2b));
      }
      // rock spire cluster (45% chance)
      if (r() < 0.45) {
        for (let k = 0, n2 = 2 + ((r() * 3) | 0); k < n2; k++) {
          const a2 = r() * 6.283, d2 = r() * rad * 0.45, sh = (2.5 + r() * 5) * sz, sw = 0.2 + r() * 0.35;
          part(parts, new THREE.OctahedronGeometry(1, 0),
            new THREE.Vector3(Math.cos(a2) * d2, 0.75 + sh * 0.5, Math.sin(a2) * d2),
            E((r() - 0.5) * 0.2, r() * 3, (r() - 0.5) * 0.2),
            rock.clone().offsetHSL(0, 0, (r() - 0.5) * 0.1),
            new THREE.Vector3(sw, sh, sw));
        }
      }
      // ground cover — flat mossy/lichen patches
      for (let k = 0, n2 = 2 + ((r() * 4) | 0); k < n2; k++) {
        const a2 = r() * 6.283, d2 = r() * rad * 0.65, ps = 0.7 + r() * 1.1;
        part(parts, new THREE.IcosahedronGeometry(1, 1),
          new THREE.Vector3(Math.cos(a2) * d2, 0.82, Math.sin(a2) * d2),
          E(0, r() * 3, 0),
          turf.clone().offsetHSL((r() - 0.5) * 0.06, 0, (r() - 0.5) * 0.12),
          new THREE.Vector3(ps, 0.22, ps));
      }
      // hanging root tendrils below the island (55% chance)
      if (r() < 0.55) {
        for (let k = 0, n2 = 4 + ((r() * 6) | 0); k < n2; k++) {
          const a2 = r() * 6.283, d2 = rad * (0.45 + r() * 0.45), rh = (2.5 + r() * 5) * sz;
          part(parts, new THREE.CylinderGeometry(0.07, 0.03, rh, 3),
            new THREE.Vector3(Math.cos(a2) * d2, -rh / 2 + 0.2, Math.sin(a2) * d2),
            E((r() - 0.5) * 0.2, 0, 0),
            turf.clone().offsetHSL(0, -0.15, -0.12));
        }
      }
      // plants — per-island archetype cycles: 0=conifer · 1=dome/mushroom · 2=shrub cluster
      const plantType = v % 3;
      for (let k = 0, n2 = 3 + ((r() * 5) | 0); k < n2; k++) {
        const a2 = r() * 6.283,
          d2 = r() * rad * 0.7,
          x = Math.cos(a2) * d2,
          z = Math.sin(a2) * d2,
          h = 1.6 + r() * 1.4;
        const fc = new THREE.Color(foliage).offsetHSL((r() - 0.5) * 0.04, 0, (r() - 0.5) * 0.08);
        part(parts, new THREE.CylinderGeometry(0.18, 0.26, h, 4),
          new THREE.Vector3(x, 0.75 + h / 2, z), E(0, 0, 0), STONE_BARK);
        if (plantType === 0) {
          part(parts, new THREE.ConeGeometry(0.9 + r() * 0.5, 2.6 + r() * 1.5, 6),
            new THREE.Vector3(x, 0.75 + h + 1.3, z), E(0, 0, 0), fc);
        } else if (plantType === 1) {
          // dome / mushroom cap
          const cr = 1.1 + r() * 0.8;
          part(parts, new THREE.IcosahedronGeometry(1, 1),
            new THREE.Vector3(x, 0.75 + h + 0.5, z), E(0, 0, 0), fc,
            new THREE.Vector3(cr, cr * 0.5, cr));
        } else {
          // shrub — 3 small cones fanning outward
          for (let s = 0; s < 3; s++) {
            const as = (s / 3) * 6.283 + r() * 0.5, ds = 0.35 + r() * 0.25, ch = 1.0 + r() * 0.8;
            part(parts, new THREE.ConeGeometry(0.45 + r() * 0.25, ch, 5),
              new THREE.Vector3(x + Math.cos(as) * ds, 0.75 + ch / 2, z + Math.sin(as) * ds),
              E(0, as, 0), fc);
          }
        }
      }
      // edge overhang rock slabs (30% chance)
      if (r() < 0.3) {
        for (let k = 0, n2 = 1 + ((r() * 3) | 0); k < n2; k++) {
          const a2 = r() * 6.283, sw = (1.5 + r() * 2.5) * sz;
          part(parts, new THREE.BoxGeometry(sw, 0.35 + r() * 0.35, sw * 0.35),
            new THREE.Vector3(Math.cos(a2) * (rad * 0.9 + sw * 0.2), -0.15 + (r() - 0.5) * 0.4, Math.sin(a2) * (rad * 0.9 + sw * 0.2)),
            E(0, -a2, (r() - 0.5) * 0.25),
            rock.clone().offsetHSL(0, 0, 0.06));
        }
      }
      if (r() < 0.45)
        part(
          parts,
          new THREE.CylinderGeometry(rad * 0.25, rad * 0.25, 0.2, 10),
          new THREE.Vector3(rad * 0.6 * (r() - 0.5), 0.82, rad * 0.6 * (r() - 0.5)),
          E(0, 0, 0),
          new THREE.Color(CurrentPalette.islandPond),
        );
      if (r() < 0.5) {
        const a2 = r() * 6.283,
          h = 8 + r() * 8;
        part(
          parts,
          new THREE.BoxGeometry(0.9, h, 0.35),
          new THREE.Vector3(
            Math.cos(a2) * rad * 0.98,
            -h / 2 + 0.5,
            Math.sin(a2) * rad * 0.98,
          ),
          E(0, -a2, 0),
          new THREE.Color(CurrentPalette.islandFoam),
        );
      }
      if (r() < 0.65)
        for (let k = 0, n2 = 3 + ((r() * 4) | 0); k < n2; k++) {
          const a2 = r() * 6.283,
            d2 = rad * (0.4 + r() * 0.5),
            s2 = 0.5 + r() * 0.8,
            hue = new THREE.Color(...CurrentPalette.crystals[v % 3]);
          part(
            crystals,
            new THREE.OctahedronGeometry(1, 0),
            new THREE.Vector3(Math.cos(a2) * d2, 0.75 + s2 * 1.2, Math.sin(a2) * d2),
            E((r() - 0.5) * 0.4, r() * 3, (r() - 0.5) * 0.4),
            hue,
            new THREE.Vector3(0.5 * s2, 1.6 * s2, 0.5 * s2),
          );
        }
      for (let k = 0, n2 = 3 + ((r() * 3) | 0); k < n2; k++) {
        const a2 = r() * 6.283,
          d2 = rad * (1.25 + r() * 0.5),
          s2 = 0.5 + r() * 1.1;
        part(
          parts,
          new THREE.IcosahedronGeometry(1, 0),
          new THREE.Vector3(Math.cos(a2) * d2, (r() - 0.5) * 8 - 2, Math.sin(a2) * d2),
          E(r() * 3, r() * 3, 0),
          rock,
          new THREE.Vector3(s2, s2 * 0.8, s2),
        );
      }
      const isl = bake(parts);
      if (crystals.length) {
        const cm = new THREE.Mesh(mergeGeometries(crystals)!, crystalMat);
        cm.frustumCulled = false;
        isl.add(cm);
      }
      isl.position.y = 55 + r() * 55;
      isl.rotation.x = (r() - 0.5) * 0.14;
      isl.rotation.z = (r() - 0.5) * 0.14;
      g.add(isl);
      bob.push({ m: isl, y: isl.position.y, ph: r() * 6 });
    }
    list.push({
      name:
        kind === "ring"
          ? "monolith ring"
          : kind === "spire"
            ? "twisted spire"
            : kind === "tombs"
              ? "tombstone field"
              : "floating island",
      pos: g.position.clone(),
    });
  }
  return {
    list,
    obs,
    tick: (t: number) =>
      bob.forEach((b) => {
        b.m.position.y = b.y + Math.sin(t * 0.5 + b.ph) * 1.8;
        b.m.rotation.y = t * 0.05 + b.ph;
      }),
  };
}
