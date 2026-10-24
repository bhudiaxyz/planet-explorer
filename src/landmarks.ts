import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Planet } from "./planet";
import type { Obs } from "./collision";
import { rng } from "./noise";
import { S } from "./config";
import { CurrentPalette } from "./palette";
const UP = new THREE.Vector3(0, 1, 0);
export type Landmark = { name: string; label: string; pos: THREE.Vector3 };

export const LANDMARK_ICON: Record<string, string> = {
  "Monolith Ring":   "🗿",
  "Twisted Spire":   "⛰️",
  "Tombstone Field": "🪦",
  "Floating Island": "⛅",
  "Stone Arch":      "🌉",
  "Crashed Ship":    "🚀",
  "Pillar Field":    "🪨",
  "Impact Crater":   "☄️",
};

export const LANDMARK_NAMES = [
  // sci-fi
  "Arrakeen","Giedi Prime","Caladan","Arrakis","Salusa Secundus",
  "Trantor","Helicon","Terminus","Askonia","Kalgan",
  "Komarr","Barrayar","Athos","Sigma Draconis","Aral",
  "Solaris","Rheya","Kelvin Station","Snow","Harey",
  "LV-426","Fiorina 161","Fury 161","Weyland Station","Hadley's Hope",
  "Magrathea","Betelgeuse VII","Krikkit","Rupert","Vogsphere",
  "Caprica","Picon","Scorpia","Gemenon","Kobol",
  "Pandora","Hell's Gate","Iknimaya","Kelutral","Toruk Makto",
  "Ego","Contraxia","Knowhere","Sovereign","Sakaar",
  "Tatooine","Hoth","Bespin","Endor","Coruscant",
  "Reach","Threshold","Installation 04","Harvest","Meridian",
  "Rannoch","Palaven","Tuchanka","Thessia","Eden Prime",
  "Gilevane","Khar'shan","Irune","Sur'Kesh","Dekuuna",
  "Hyperion","Pacem","Hebron","Tau Ceti Center","Lusus",
  "Ringworld","Map of Known Space","Fist of God","Arch","Spill Mountain",
  // galaxies
  "Andromeda","Triangulum","Whirlpool","Sombrero","Cartwheel",
  "Pinwheel","Sunflower","Sculptor","Centaurus A","Bode's Galaxy",
  "Large Magellanic","Small Magellanic","Black Eye","Tadpole","Antennae",
  // nebulae
  "Orion Nebula","Crab Nebula","Eagle Nebula","Helix Nebula","Ring Nebula",
  "Horsehead","Pillars of Creation","Lagoon Nebula","Veil Nebula","Carina Nebula",
  "Rosette","Tarantula","Butterfly Nebula","Cat's Eye","Owl Nebula",
  "Flame Nebula","Pelican Nebula","Witch Head","Running Man","Soul Nebula",
  // Culture ships
  "Sleeper Service","Mistake Not","Quietly Confident","Just Read the Instructions",
  "Experiencing A Significant Gravitas Shortfall","Lightly Seared on the Reality Grill",
  // Revelation Space
  "Chasm City","Resurgam","Ararat","Hela","Absolution Gap",
  // Le Guin
  "Anarres","Urras","Gethen","Rocannon's World","Athshe",
  // The Expanse
  "Ilus","Laconia","Medina","Ring Station","Ilus Prime",
  // Babylon 5
  "Minbar","Narn","Centauri Prime","Z'ha'dum","Rigel VII",
  // US National Parks
  "Yellowstone","Yosemite","Grand Canyon","Zion","Bryce Canyon",
  "Arches","Canyonlands","Capitol Reef","Badlands","Grand Teton",
  "Olympic","Rainier","Crater Lake","Denali","Kenai Fjords",
  "Sequoia","Joshua Tree","Death Valley","Saguaro","Petrified Forest",
  "Acadia","Everglades","Biscayne","Dry Tortugas","Shenandoah",
  "Great Smoky","Mammoth Cave","Isle Royale","Sleeping Bear","Voyageurs",
  "Glacier","Waterton","Rocky Mountain","Mesa Verde","Black Canyon",
  // World National Parks & Natural Sites
  "Banff","Jasper","Algonquin","Nahanni","Kluane",
  "Torres del Paine","Iguazú","Pantanal","Galápagos","Patagonia",
  "Fiordland","Abel Tasman","Tongariro","Purnululu","Kakadu",
  "Cradle Mountain","Blue Mountains","Daintree","Nambung","Karijini",
  "Serengeti","Ngorongoro","Virunga","Okavango","Etosha",
  "Kruger","Bwindi","Simien","Tsavo","Amboseli",
  "Sagarmatha","Kaziranga","Sundarbans","Ranthambore","Nagarhole",
  "Jiuzhaigou","Zhangjiajie","Huangshan","Wulingyuan","Changbai",
  "Plitvice","Durmitor","Triglav","Białowieża","Ordesa",
  "Doñana","Skellig Michael","Cairngorms","Snowdonia","Dartmoor",
  // terrain-flavoured
  "Obsidian Flats","Ashfall Plain","Midnight Basin","Ironspire","Cinder Reach",
  "The Shallows","High Ridge","Storm Coast","Dust Bowl","Caldera",
  "The Rift","Sunken Vale","Mountain Peak","Coastal Cliffs","Ancient Shelf",
  "Canyon","Open Plains","Lagoon","Desert","Forest",
];
// Rare deterministic landmarks: monolith rings, twisted spires, tombstone fields, floating islands, crashed ships, basalt pillar fields, impact craters.
// Each landmark's parts are baked into ONE vertex-coloured mesh (about 210 draw calls and as many shadow draws become 16).
export function buildLandmarks(pl: Planet, group: THREE.Group) {
  const r = rng(S.seed + 900),
    list: Landmark[] = [],
    obs: Obs[] = [],
    labelOffset = Math.floor(r() * LANDMARK_NAMES.length),
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
  const kinds = ["ring", "spire", "tombs", "island", "arch", "ship", "pillars", "crater"];
  let nIsl = 0;
  for (let n = 0; n < 24; n++) {
    const kind = kinds[n % 8],
      d = new THREE.Vector3();
    for (let a = 0; a < 400; a++) {
      d.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
      if (d.lengthSq() > 1 || d.lengthSq() < 0.01) continue;
      d.normalize();
      const e = pl.elev(d);
      const eMax = kind === "spire" ? 0.45 : kind === "crater" || kind === "ring" || kind === "arch" ? 0.18 : 0.3;
      if (e > 0.04 && e < eMax && pl.temp(d, e) > 0.3) break;
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
      const sz = 0.4 + r() * 1.4, twist = 0.12 + r() * 0.22;
      for (let i = 0; i < 14; i++)
        part(
          parts,
          new THREE.BoxGeometry((5 - i * 0.3) * sz, 5.2 * sz, (5 - i * 0.3) * sz),
          new THREE.Vector3(0, (i * 5 + 1) * sz, 0),
          new THREE.Euler(0, i * twist, 0),
          DARK,
        );
      // crystal clusters at 3-4 heights spiralling up the column
      const spireCrystals: THREE.BufferGeometry[] = [];
      const spireHue = new THREE.Color(...CurrentPalette.crystals[n % 3]);
      const clusterCount = 3 + ((r() * 2) | 0);
      for (let c = 0; c < clusterCount; c++) {
        const ht = (3 + c * 4.5) * sz, baseW = (4.5 - c * 0.25) * sz * 0.55;
        const ca = c * 2.1 + r() * 0.8;
        const count = 2 + ((r() * 3) | 0);
        for (let k = 0; k < count; k++) {
          const a2 = ca + (k / count) * 2.2, cs = (0.3 + r() * 0.5) * sz;
          part(spireCrystals, new THREE.OctahedronGeometry(1, 0),
            new THREE.Vector3(Math.cos(a2) * baseW, ht + cs, Math.sin(a2) * baseW),
            new THREE.Euler((r() - 0.5) * 0.5, a2, 0.35 + (r() - 0.5) * 0.2),
            spireHue.clone().offsetHSL(0, 0, (r() - 0.5) * 0.12),
            new THREE.Vector3(0.35 * cs, 1.8 * cs, 0.35 * cs));
        }
      }
      // crystal crown at the apex
      const apexY = 14 * 5.2 * sz;
      for (let k = 0; k < 5; k++) {
        const a2 = (k / 5) * 6.283, cs = (0.25 + r() * 0.35) * sz;
        part(spireCrystals, new THREE.OctahedronGeometry(1, 0),
          new THREE.Vector3(Math.cos(a2) * sz * 0.8, apexY + cs, Math.sin(a2) * sz * 0.8),
          new THREE.Euler(0, a2, 0.2),
          spireHue.clone().offsetHSL(0, 0, 0.1),
          new THREE.Vector3(0.3 * cs, 2.2 * cs, 0.3 * cs));
      }
      obs.push({
        d: d.clone(),
        ax: wax(0),
        rx: 3.3 * sz,
        rz: 3.3 * sz,
        H: Infinity,
        mode: 0,
      });
      const spireGroup = new THREE.Group();
      spireGroup.add(bake(parts));
      if (spireCrystals.length) {
        const cm = new THREE.Mesh(mergeGeometries(spireCrystals)!, crystalMat);
        cm.castShadow = true;

        spireGroup.add(cm);
      }
      g.add(spireGroup);
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
      // scattered glowing crystals among the tombstones
      const tombCrystals: THREE.BufferGeometry[] = [];
      const tombHue = new THREE.Color(...CurrentPalette.crystals[n % 3]);
      for (let k = 0, n2 = 6 + ((r() * 8) | 0); k < n2; k++) {
        const a2 = r() * 6.283, cr = r() * 14,
          x2 = Math.cos(a2) * cr, z2 = Math.sin(a2) * cr,
          cs = 0.15 + r() * 0.35;
        part(tombCrystals, new THREE.OctahedronGeometry(1, 0),
          new THREE.Vector3(x2, ground(x2, z2) + cs * 1.2, z2),
          new THREE.Euler((r() - 0.5) * 0.3, r() * 6.283, (r() - 0.5) * 0.3),
          tombHue.clone().offsetHSL(0, 0, (r() - 0.5) * 0.15),
          new THREE.Vector3(0.35 * cs, 1.8 * cs, 0.35 * cs));
      }
      if (tombCrystals.length) {
        const cm = new THREE.Mesh(mergeGeometries(tombCrystals)!, crystalMat);
        cm.castShadow = true;

        g.add(cm);
      }
    } else if (kind === "ship") {
      // crashed spacecraft: elongated hull with swept wings and engine nacelles, nose buried
      const sz = 0.85 + r() * 0.65;
      const pitch = 0.18 + r() * 0.2;
      const shipYaw = r() * Math.PI * 2;
      const hl = 20 * sz, hw = 3.0 * sz, hh = 2.2 * sz;
      const shipCol = STONE.clone().offsetHSL(0.6, -0.14, 0.02);
      // hull body
      part(parts, new THREE.BoxGeometry(hw, hh, hl),
        new THREE.Vector3(0, hh * 0.45, 0),
        new THREE.Euler(pitch, 0, 0), shipCol);
      // swept wings
      for (const side of [-1, 1] as const) {
        part(parts, new THREE.BoxGeometry(8 * sz, 0.45 * sz, 5 * sz),
          new THREE.Vector3(side * (hw * 0.5 + 4 * sz), hh * 0.42, 2 * sz),
          new THREE.Euler(pitch, 0, side * 0.08), shipCol);
      }
      // engine nacelles
      for (const side of [-1, 1] as const) {
        part(parts, new THREE.CylinderGeometry(0.9 * sz, 0.65 * sz, 4.5 * sz, 7),
          new THREE.Vector3(side * hw * 0.38, hh * 0.38 + 0.9 * sz, hl * 0.37),
          new THREE.Euler(pitch, 0, 0), DARK);
      }
      // debris scatter
      for (let k = 0, n2 = 5 + (r() * 7 | 0); k < n2; k++) {
        const da = r() * 6.283, dd = 8 + r() * 18, ds = 0.4 + r() * 1.8;
        const dx = Math.cos(da) * dd, dz = Math.sin(da) * dd;
        part(parts, new THREE.BoxGeometry(ds, ds * 0.35, ds * 0.9),
          new THREE.Vector3(dx, ground(dx, dz) + ds * 0.18, dz),
          new THREE.Euler((r() - 0.5) * 0.6, r() * 6.283, (r() - 0.5) * 0.4), shipCol);
      }
      obs.push({ d: d.clone(), ax: wax(Math.PI / 2 + shipYaw), rx: hl * 0.45, rz: hw * 0.55, H: hh, mode: 0 });
      const sg = new THREE.Group();
      sg.rotation.y = shipYaw;
      sg.add(bake(parts));
      g.add(sg);
    } else if (kind === "pillars") {
      // basalt hexagonal column field with glowing lava cracks
      const sz = 0.75 + r() * 0.9;
      const pillarCrystals: THREE.BufferGeometry[] = [];
      const count = 12 + (r() * 10 | 0);
      for (let k = 0; k < count; k++) {
        const pa = r() * 6.283, pd = r() * r() * 20 * sz;
        const px = Math.cos(pa) * pd, pz = Math.sin(pa) * pd;
        const ph = (4 + r() * 12) * sz, pr = (0.6 + r() * 0.65) * sz;
        part(parts, new THREE.CylinderGeometry(pr * 0.88, pr, ph, 6),
          new THREE.Vector3(px, ground(px, pz) + ph * 0.5 - 0.4, pz),
          new THREE.Euler((r() - 0.5) * 0.07, r() * 1.05, (r() - 0.5) * 0.07),
          DARK.clone().offsetHSL(0, -0.25, (r() - 0.5) * 0.06));
        if (k < 5) obs.push({ d: wd(px, pz), ax: wax(pa), rx: pr * 1.1, rz: pr * 1.1, H: Infinity, mode: 0 });
      }
      // glowing lava cracks between pillars
      for (let k = 0, n2 = 6 + (r() * 8 | 0); k < n2; k++) {
        const la = r() * 6.283, ld = r() * 12 * sz;
        const lx = Math.cos(la) * ld, lz = Math.sin(la) * ld;
        const cs = 0.2 + r() * 0.45;
        part(pillarCrystals, new THREE.BoxGeometry(cs * 0.28, cs * 2.8, cs * 0.28),
          new THREE.Vector3(lx, ground(lx, lz) + cs * 1.4, lz),
          new THREE.Euler((r() - 0.5) * 0.25, r() * 6.283, (r() - 0.5) * 0.25),
          new THREE.Color(1.0, 0.28 + r() * 0.2, 0.04));
      }
      g.add(bake(parts));
      if (pillarCrystals.length) {
        const cm = new THREE.Mesh(mergeGeometries(pillarCrystals)!, crystalMat);
        cm.castShadow = true;

        g.add(cm);
      }
    } else if (kind === "crater") {
      // impact crater: raised boulder rim, scattered ejecta, scorched dark centre
      const sz = 1.0 + r() * 1.2;
      const rimR = 16 * sz;
      const rimCount = 14 + (r() * 10 | 0);
      for (let k = 0; k < rimCount; k++) {
        const ra = (k / rimCount) * 6.283 + (r() - 0.5) * 0.45;
        const rd = rimR * (0.82 + r() * 0.35);
        const rx2 = Math.cos(ra) * rd, rz2 = Math.sin(ra) * rd;
        const rs = (1.4 + r() * 2.8) * sz;
        part(parts, new THREE.IcosahedronGeometry(1, 1),
          new THREE.Vector3(rx2, ground(rx2, rz2) + rs * 0.45, rz2),
          new THREE.Euler(r() * 3, r() * 3, r() * 3),
          STONE.clone().offsetHSL(0, 0, (r() - 0.5) * 0.1),
          new THREE.Vector3(rs, rs * 0.72, rs));
        if (k % 4 === 0) obs.push({ d: wd(rx2, rz2), ax: wax(ra), rx: rs * 0.85, rz: rs * 0.85, H: rs * 0.7, mode: 2 });
      }
      // scattered ejecta beyond the rim
      for (let k = 0, n2 = 8 + (r() * 10 | 0); k < n2; k++) {
        const ea = r() * 6.283, ed = rimR * (1.1 + r() * 0.9), es = (0.4 + r() * 1.2) * sz;
        const ex = Math.cos(ea) * ed, ez = Math.sin(ea) * ed;
        part(parts, new THREE.IcosahedronGeometry(1, 0),
          new THREE.Vector3(ex, ground(ex, ez) + es * 0.3, ez),
          new THREE.Euler(r() * 3, r() * 3, r() * 3),
          STONE.clone().offsetHSL(0, 0, (r() - 0.5) * 0.1),
          new THREE.Vector3(es, es * 0.5, es));
      }
      // scorched centre disc
      part(parts, new THREE.CylinderGeometry(rimR * 0.62, rimR * 0.68, 0.2, 12),
        new THREE.Vector3(0, 0.1, 0), new THREE.Euler(0, 0, 0),
        DARK.clone().offsetHSL(0, -0.4, -0.08));
      g.add(bake(parts));
    } else if (kind === "arch") {
      // natural stone arch: two pillars bridged by a crown, adapted to terrain slope
      const sz = 0.85 + r() * 0.75;
      const half = (8 + r() * 6) * sz;
      const pw = (1.6 + r() * 0.9) * sz;
      const archYaw = r() * Math.PI * 2;
      const ax1 = Math.cos(archYaw) * half, az1 = Math.sin(archYaw) * half;
      const gy1 = ground(ax1, az1), gy2 = ground(-ax1, -az1);
      const ph = (7 + r() * 5) * sz;
      const topY = Math.max(gy1, gy2) + ph;
      for (const [px, pz, gy] of [[ax1, az1, gy1], [-ax1, -az1, gy2]] as [number, number, number][]) {
        const pillarH = topY - gy;
        part(parts, new THREE.BoxGeometry(pw, pillarH, pw * 1.15),
          new THREE.Vector3(px, gy + pillarH / 2, pz),
          new THREE.Euler(0, archYaw, 0), STONE);
        obs.push({ d: wd(px, pz), ax: wax(archYaw), rx: pw * 0.65, rz: pw * 0.65, H: Infinity, mode: 0 });
      }
      // crown span
      part(parts, new THREE.BoxGeometry(half * 2.2, pw * 0.8, pw * 1.05),
        new THREE.Vector3(0, topY + pw * 0.35, 0),
        new THREE.Euler(0, archYaw, (r() - 0.5) * 0.03),
        DARK.clone().offsetHSL(0, 0, 0.08));
      // keystone
      part(parts, new THREE.BoxGeometry(pw * 0.9, pw * 0.75, pw * 0.9),
        new THREE.Vector3(0, topY, 0),
        new THREE.Euler(0, archYaw, 0), STONE);
      // base rubble
      for (let k = 0, n2 = 4 + (r() * 6 | 0); k < n2; k++) {
        const da = r() * 6.283, dd = half * (0.15 + r() * 0.85), ds = (0.35 + r() * 1.2) * sz;
        const dx = Math.cos(da) * dd, dz2 = Math.sin(da) * dd;
        part(parts, new THREE.IcosahedronGeometry(1, 0),
          new THREE.Vector3(dx, ground(dx, dz2) + ds * 0.3, dz2),
          new THREE.Euler(r() * 3, r() * 3, r() * 3),
          STONE.clone().offsetHSL(0, 0, (r() - 0.5) * 0.1),
          new THREE.Vector3(ds, ds * 0.6, ds));
      }
      g.add(bake(parts));
    } else {
      // every island is different: palette (grass / autumn / teal / violet / frost), 2-4 rock tiers, stalactites, trees, optional pond, waterfall,
      // glowing crystals (HDR, picked up by bloom) and orbiting debris (it rotates with the island), plus a small random tilt
      // shape archetypes (v%4): 0=classic cylinder+cones, 1=pancake stack, 2=jagged mesa, 3=spire island
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
      const shape = v % 4;
      let bottomY = -0.4; // approximate bottom of the cone stack, used by stalactites below
      if (shape === 1) {
        // pancake stack: 2-3 staggered flat discs
        const discs = 2 + ((r() * 2) | 0);
        for (let d3 = 0; d3 < discs; d3++) {
          const dr = rad * (1 - d3 * 0.22), ox = (r() - 0.5) * rad * 0.3, oz = (r() - 0.5) * rad * 0.3;
          part(parts, new THREE.CylinderGeometry(dr, dr * 0.92, 1.8 - d3 * 0.3, 10),
            new THREE.Vector3(ox, d3 * 2.2, oz), E(0, r() * 3, 0),
            turf.clone().offsetHSL(0, 0, -d3 * 0.04));
          for (let k = 0; k < 4; k++) {
            const a2 = r() * 6.283, d2 = dr * (0.7 + r() * 0.2);
            part(parts, new THREE.IcosahedronGeometry(1, 1),
              new THREE.Vector3(ox + Math.cos(a2) * d2, d3 * 2.2 + 0.1, oz + Math.sin(a2) * d2),
              E(0, 0, 0), turf.clone().offsetHSL(0, 0, (r() - 0.5) * 0.08),
              new THREE.Vector3(1.1 + r() * 0.6, 0.45, 1.1 + r() * 0.6));
          }
        }
        // single tapered cone below
        const bh = (8 + r() * 6) * sz;
        part(parts, new THREE.ConeGeometry(rad * 0.85, bh, 8),
          new THREE.Vector3(0, -bh / 2 - 0.2, 0), E(Math.PI, r() * 3, 0), rock);
        bottomY = -bh - 0.2;
      } else if (shape === 2) {
        // jagged mesa: squat box body, lumpy icosahedra on top rim
        const mw = rad * 1.1, mh = 2.2 + r() * 1.2;
        part(parts, new THREE.BoxGeometry(mw, mh, mw * 0.88),
          new THREE.Vector3(0, 0, 0), E(0, r() * 3, 0), turf);
        for (let k = 0; k < 8; k++) {
          const a2 = r() * 6.283, d2 = mw * (0.45 + r() * 0.15), ls = 0.8 + r() * 1.2;
          part(parts, new THREE.IcosahedronGeometry(1, 0),
            new THREE.Vector3(Math.cos(a2) * d2, mh / 2 + ls * 0.3, Math.sin(a2) * d2),
            E(r() * 3, r() * 3, r() * 3),
            rock.clone().offsetHSL(0, 0, (r() - 0.5) * 0.1),
            new THREE.Vector3(ls, ls * 0.7, ls));
        }
        let y2 = -mh / 2, rr2 = mw * 0.72;
        for (let t = 0; t < tiers; t++) {
          const h = (5 + r() * 4) * sz * (1 - t * 0.18);
          part(parts, new THREE.ConeGeometry(rr2, h, 6 + ((r() * 3) | 0)),
            new THREE.Vector3((r() - 0.5) * rad * 0.12, y2 - h / 2, (r() - 0.5) * rad * 0.12),
            E(Math.PI, r() * 3, 0),
            rock.clone().offsetHSL(0, 0, -t * 0.06 + (r() - 0.5) * 0.04));
          y2 -= h * 0.75; rr2 *= 0.58 + r() * 0.2;
        }
        bottomY = y2;
      } else if (shape === 3) {
        // spire island: narrow tall cylinder top, single deep narrow cone below
        const sr = rad * 0.45, sh = 2.8 + r() * 1.5;
        part(parts, new THREE.CylinderGeometry(sr, sr * 0.88, sh, 9),
          new THREE.Vector3(0, 0, 0), E(0, r() * 3, 0), turf);
        for (let k = 0; k < 4; k++) {
          const a2 = r() * 6.283, d2 = sr * (0.6 + r() * 0.25);
          part(parts, new THREE.IcosahedronGeometry(1, 1),
            new THREE.Vector3(Math.cos(a2) * d2, 0.1, Math.sin(a2) * d2),
            E(0, 0, 0), turf.clone().offsetHSL(0, 0, (r() - 0.5) * 0.08),
            new THREE.Vector3(1.0 + r() * 0.5, 0.4, 1.0 + r() * 0.5));
        }
        const bh = (18 + r() * 14) * sz;
        part(parts, new THREE.ConeGeometry(sr * 0.7, bh, 6),
          new THREE.Vector3(0, -bh / 2 - sh / 2, 0), E(Math.PI, r() * 3, 0), rock);
        bottomY = -bh - sh / 2;
      } else {
        // classic: flat cylinder top + tapered cone stack
        part(parts, new THREE.CylinderGeometry(rad, rad * 0.95, 1.5, 12),
          new THREE.Vector3(0, 0, 0), E(0, r() * 3, 0), turf);
        for (let k = 0; k < 5; k++) {
          const a2 = r() * 6.283, d2 = rad * (0.75 + r() * 0.2);
          part(parts, new THREE.IcosahedronGeometry(1, 1),
            new THREE.Vector3(Math.cos(a2) * d2, 0.1, Math.sin(a2) * d2),
            E(0, 0, 0), turf.clone().offsetHSL(0, 0, (r() - 0.5) * 0.08),
            new THREE.Vector3(1.2 + r(), 0.5, 1.2 + r()));
        }
        let y = -0.4, rr = rad * 0.95;
        for (let t = 0; t < tiers; t++) {
          const h = (7 + r() * 5) * sz * (1 - t * 0.15);
          part(parts, new THREE.ConeGeometry(rr, h, 7 + ((r() * 4) | 0)),
            new THREE.Vector3((r() - 0.5) * rad * 0.15, y - h / 2, (r() - 0.5) * rad * 0.15),
            E(Math.PI, r() * 3, 0),
            rock.clone().offsetHSL(0, 0, -t * 0.05 + (r() - 0.5) * 0.04));
          y -= h * 0.8; rr *= 0.62 + r() * 0.2;
        }
        bottomY = y;
      }
      for (let k = 0, n2 = 4 + ((r() * 5) | 0); k < n2; k++) {
        const a2 = r() * 6.283,
          d2 = r() * rad * 0.6,
          h = (2 + r() * 4) * sz;
        part(
          parts,
          new THREE.ConeGeometry(0.5 + r() * 0.7, h, 5),
          new THREE.Vector3(Math.cos(a2) * d2, bottomY - h / 2 + 1 + r() * 2, Math.sin(a2) * d2),
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
      // plants — per-island archetype cycles: 0=conifer · 1=dome/mushroom · 2=shrub cluster · 3=palm · 4=giant mushroom
      const plantType = v % 5;
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
        } else if (plantType === 3) {
          // palm: tall thin trunk + fanning frond cones at top
          const ph = 2.2 + r() * 1.8, fronds = 4 + ((r() * 3) | 0);
          part(parts, new THREE.CylinderGeometry(0.1, 0.18, ph, 4),
            new THREE.Vector3(x, 0.75 + ph / 2, z), E(0, 0, 0), STONE_BARK);
          for (let f = 0; f < fronds; f++) {
            const af = (f / fronds) * 6.283, fh = 1.4 + r() * 0.8, tilt = 0.55 + r() * 0.3;
            part(parts, new THREE.ConeGeometry(0.35 + r() * 0.2, fh, 4),
              new THREE.Vector3(x + Math.cos(af) * fh * 0.5, 0.75 + ph + fh * 0.25, z + Math.sin(af) * fh * 0.5),
              E(tilt * Math.sin(af + Math.PI), af, tilt * Math.cos(af + Math.PI)), fc);
          }
        } else if (plantType === 4) {
          // giant mushroom: squat trunk + wide flat cap
          const mh = 1.0 + r() * 1.2, cr = 1.6 + r() * 1.2;
          part(parts, new THREE.CylinderGeometry(0.22, 0.32, mh, 5),
            new THREE.Vector3(x, 0.75 + mh / 2, z), E(0, 0, 0), STONE_BARK);
          part(parts, new THREE.IcosahedronGeometry(1, 1),
            new THREE.Vector3(x, 0.75 + mh + cr * 0.3, z), E(0, r() * 3, 0), fc,
            new THREE.Vector3(cr, cr * 0.28, cr));
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
      if (r() < 0.45) {
        // glowing pond — goes into crystal mesh so MeshBasicMaterial makes it bloom
        const px = rad * 0.6 * (r() - 0.5), pz = rad * 0.6 * (r() - 0.5);
        part(crystals, new THREE.CylinderGeometry(rad * 0.25, rad * 0.25, 0.18, 10),
          new THREE.Vector3(px, 0.82, pz), E(0, 0, 0),
          new THREE.Color(...CurrentPalette.crystals[v % 3]).multiplyScalar(0.55));
      }
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
      if (r() < 0.65) {
        const n2 = 5 + ((r() * 5) | 0);
        for (let k = 0; k < n2; k++) {
          const a2 = r() * 6.283,
            s2 = 0.5 + r() * 0.8,
            hue = new THREE.Color(...CurrentPalette.crystals[v % 3]);
          // ~75% around top circumference, ~25% on the side face
          const onRim = r() < 0.75;
          const d2 = onRim ? rad * (0.82 + r() * 0.16) : rad * (0.95 + r() * 0.1);
          const cy = onRim ? 0.75 + s2 * 1.2 : 0.2 - r() * 1.5;
          part(crystals, new THREE.OctahedronGeometry(1, 0),
            new THREE.Vector3(Math.cos(a2) * d2, cy, Math.sin(a2) * d2),
            E((r() - 0.5) * 0.4, r() * 3, (r() - 0.5) * 0.4),
            hue, new THREE.Vector3(0.5 * s2, 1.6 * s2, 0.5 * s2));
        }
      }
      // rock-face crystals — embedded in the cone tiers, angled outward
      for (let k = 0, n2 = 3 + ((r() * 4) | 0); k < n2; k++) {
        const a2 = r() * 6.283, depthFrac = 0.2 + r() * 0.5,
          cs = (0.2 + r() * 0.4) * sz,
          yd = bottomY * depthFrac,
          dr = rad * (0.8 + r() * 0.15),
          hue = new THREE.Color(...CurrentPalette.crystals[(v + 2) % 3]);
        part(crystals, new THREE.OctahedronGeometry(1, 0),
          new THREE.Vector3(Math.cos(a2) * dr, yd, Math.sin(a2) * dr),
          new THREE.Euler((r() - 0.5) * 0.3, a2, 0.5 + (r() - 0.5) * 0.25),
          hue, new THREE.Vector3(0.3 * cs, 1.6 * cs, 0.3 * cs));
      }
      // hanging underside crystals — always present, contrasting palette hue, point downward
      for (let k = 0, n2 = 5 + ((r() * 6) | 0); k < n2; k++) {
        const a2 = r() * 6.283,
          d2 = rad * (0.3 + r() * 0.6),
          s2 = 0.4 + r() * 0.9,
          hue = new THREE.Color(...CurrentPalette.crystals[(v + 1) % 3]);
        part(crystals, new THREE.OctahedronGeometry(1, 0),
          new THREE.Vector3(Math.cos(a2) * d2, bottomY + s2 * 1.0 + r() * 3, Math.sin(a2) * d2),
          E(Math.PI * 0.5 + (r() - 0.5) * 0.3, r() * 3, (r() - 0.5) * 0.3),
          hue, new THREE.Vector3(0.4 * s2, 2.0 * s2, 0.4 * s2));
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
        cm.castShadow = true;

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
        kind === "ring"    ? "Monolith Ring"
        : kind === "spire" ? "Twisted Spire"
        : kind === "tombs" ? "Tombstone Field"
        : kind === "ship"  ? "Crashed Ship"
        : kind === "pillars" ? "Pillar Field"
        : kind === "crater"  ? "Impact Crater"
        : kind === "arch"    ? "Stone Arch"
        : "Floating Island",
      label: LANDMARK_NAMES[(labelOffset + list.length) % LANDMARK_NAMES.length],
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
