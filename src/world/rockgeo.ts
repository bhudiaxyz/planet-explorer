import * as THREE from "three";
import { rng } from "../core/noise";
import { CurrentPalette } from "../core/palette";
import { T, add, done } from "./geoutil";

export function rockGeo() {
    const p: THREE.BufferGeometry[] = [];
    add(p, new THREE.IcosahedronGeometry(1, 2), T(0, 0.3, 0), new THREE.Color(CurrentPalette.rockWarm), 1, true);
    return done(p);
}
export function rockLow() {
    const p: THREE.BufferGeometry[] = [];
    add(p, new THREE.IcosahedronGeometry(1, 0), T(0, 0.3, 0), new THREE.Color(CurrentPalette.rockWarm), 1, true);
    return done(p);
}
// Flat layered slabs — warm ochre/tan palette, biased to mid-altitude rocky slopes
export function rockSlabGeo() {
    const p: THREE.BufferGeometry[] = [],
        r = rng(37);
    // Large flat slab
    add(
        p,
        new THREE.IcosahedronGeometry(1, 2),
        new THREE.Matrix4().compose(
            new THREE.Vector3(0, 0.12, 0),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r() * 6.28, (r() - 0.5) * 0.25)),
            new THREE.Vector3(1.15, 0.2, 1.0)
        ),
        new THREE.Color(CurrentPalette.rockWarmAlt),
        0.22,
        true
    );
    // Smaller angled piece resting on top
    add(
        p,
        new THREE.IcosahedronGeometry(1, 1),
        new THREE.Matrix4().compose(
            new THREE.Vector3(0.35, 0.3, -0.15),
            new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * 0.5, r() * 6.28, (r() - 0.5) * 0.4)),
            new THREE.Vector3(0.48, 0.36, 0.42)
        ),
        new THREE.Color(CurrentPalette.rockWarmDark),
        0.38,
        true
    );
    return done(p);
}
export function rockSlabLow() {
    const p: THREE.BufferGeometry[] = [];
    add(
        p,
        new THREE.IcosahedronGeometry(1, 0),
        new THREE.Matrix4().compose(
            new THREE.Vector3(0, 0.12, 0),
            new THREE.Quaternion(),
            new THREE.Vector3(1.1, 0.22, 1.0)
        ),
        new THREE.Color(CurrentPalette.rockWarmAlt),
        0.22,
        true
    );
    return done(p);
}

// Angular pale rocks near the snowline — cool grey/blue-grey palette, high altitude only
export function frostRockGeo() {
    const p: THREE.BufferGeometry[] = [],
        r = rng(53);
    for (let i = 0; i < 2; i++) {
        const s = i === 0 ? 0.85 : 0.52;
        add(
            p,
            new THREE.IcosahedronGeometry(1, 1), // det=1 stays angular after jitter
            new THREE.Matrix4().compose(
                new THREE.Vector3(i * 0.4 - 0.2, s * 0.55 + i * 0.1, i * 0.15 - 0.08),
                new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * 0.5, r() * 6.28, (r() - 0.5) * 0.6)),
                new THREE.Vector3(s, s * 0.9, s * 0.8)
            ),
            new THREE.Color(CurrentPalette.rockCool),
            s * 0.9,
            true
        );
    }
    return done(p);
}
export function frostRockLow() {
    const p: THREE.BufferGeometry[] = [];
    add(p, new THREE.IcosahedronGeometry(1, 0), T(0, 0.45, 0), new THREE.Color(CurrentPalette.rockCool), 0.85, true);
    return done(p);
}

const tinyRock = (c: THREE.Color, y: number, sx: number, sy: number) => {
    const p: THREE.BufferGeometry[] = [];
    add(
        p,
        new THREE.OctahedronGeometry(1, 0),
        new THREE.Matrix4().compose(new THREE.Vector3(0, y, 0), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sx)),
        c,
        sy,
        true,
        false
    );
    return done(p);
};
export const rockSlabTiny = () => tinyRock(new THREE.Color(CurrentPalette.rockWarmAlt), 0.12, 1.1, 0.22);
export const frostRockTiny = () => tinyRock(new THREE.Color(CurrentPalette.rockCool), 0.45, 0.85, 0.75);

export const rockTiny = () => tinyRock(new THREE.Color(CurrentPalette.rockWarm), 0.3, 1, 0.8);

// ---- extra rock types (reuse the palette rock colours; per-instance hue/size comes from the catalog `look` in plants.ts)
const ico = (
    p: THREE.BufferGeometry[],
    det: number,
    pos: THREE.Vector3,
    rot: THREE.Euler,
    s: THREE.Vector3,
    c: string
) =>
    add(
        p,
        new THREE.IcosahedronGeometry(1, det),
        new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromEuler(rot), s),
        new THREE.Color(c),
        s.y,
        true
    );
// flat-shaded hex prism (non-indexed + computeVertexNormals → crisp facets)
const hex = (p: THREE.BufferGeometry[], x: number, z: number, r: number, h: number, c: string) => {
    const g = new THREE.CylinderGeometry(r, r * 1.05, h, 6, 1).toNonIndexed();
    g.computeVertexNormals();
    add(p, g, T(x, h / 2 - 0.1, z), new THREE.Color(c), h / 2);
};

// Shore / riverbed cobbles: a scatter of small flattened rounded stones (low coast)
export function cobbleGeo(n = 6) {
    const p: THREE.BufferGeometry[] = [],
        r = rng(71);
    for (let i = 0; i < n; i++) {
        const s = 0.18 + r() * 0.22,
            a = r() * 6.283,
            d = r() * 0.9;
        ico(
            p,
            1,
            new THREE.Vector3(Math.cos(a) * d, s * 0.25, Math.sin(a) * d),
            new THREE.Euler(0, r() * 6.28, 0),
            new THREE.Vector3(s * 1.3, s * 0.55, s),
            i % 2 ? CurrentPalette.rockWarmAlt : CurrentPalette.rockWarm
        );
    }
    return done(p);
}
export const cobbleLow = () => cobbleGeo(2);

// Tors: stacked weathered blocks (upland moors)
export function torGeo() {
    const p: THREE.BufferGeometry[] = [],
        r = rng(83);
    let y = 0;
    for (let i = 0; i < 4; i++) {
        const s = 1 - i * 0.2,
            hh = s * (0.55 + r() * 0.15);
        ico(
            p,
            1,
            new THREE.Vector3((r() - 0.5) * 0.3, y + hh * 0.5, (r() - 0.5) * 0.3),
            new THREE.Euler((r() - 0.5) * 0.2, r() * 6.28, (r() - 0.5) * 0.2),
            new THREE.Vector3(s, hh * 0.6, s * 0.85),
            i % 2 ? CurrentPalette.rockWarmDark : CurrentPalette.rockWarm
        );
        y += hh * 0.95;
    }
    return done(p);
}
export function torLow() {
    const p: THREE.BufferGeometry[] = [];
    ico(
        p,
        0,
        new THREE.Vector3(0, 0.5, 0),
        new THREE.Euler(),
        new THREE.Vector3(1, 0.6, 0.85),
        CurrentPalette.rockWarm
    );
    ico(
        p,
        0,
        new THREE.Vector3(0, 1.4, 0),
        new THREE.Euler(0, 0.7, 0),
        new THREE.Vector3(0.7, 0.45, 0.6),
        CurrentPalette.rockWarmDark
    );
    return done(p);
}
export const torTiny = () => tinyRock(new THREE.Color(CurrentPalette.rockWarm), 1.0, 0.9, 1.1);

// Scree: angular shards strewn across steep high slopes
export function screeGeo(n = 7) {
    const p: THREE.BufferGeometry[] = [],
        r = rng(97);
    for (let i = 0; i < n; i++) {
        const s = 0.12 + r() * 0.3,
            a = r() * 6.283,
            d = r() * 1.2;
        add(
            p,
            new THREE.OctahedronGeometry(1, 0),
            new THREE.Matrix4().compose(
                new THREE.Vector3(Math.cos(a) * d, s * 0.35, Math.sin(a) * d),
                new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 3, r() * 6.28, r() * 3)),
                new THREE.Vector3(s * 1.2, s * 0.6, s)
            ),
            new THREE.Color(i % 3 ? CurrentPalette.rockCool : CurrentPalette.rockWarmDark),
            s * 0.6
        );
    }
    return done(p);
}
export const screeLow = () => screeGeo(3);
export const screeTiny = () => tinyRock(new THREE.Color(CurrentPalette.rockCool), 0.1, 1.2, 0.25);

// Basalt columns: clustered hexagonal prisms of mixed height (dry volcanic mid/high ground)
export function basaltGeo(n = 7) {
    const p: THREE.BufferGeometry[] = [],
        r = rng(109);
    for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.283 + r() * 0.3,
            d = i === 0 ? 0 : 0.42 + r() * 0.2;
        hex(
            p,
            Math.cos(a) * d,
            Math.sin(a) * d,
            0.24,
            i === 0 ? 2.2 : 0.8 + r() * 1.4,
            i % 2 ? CurrentPalette.rockWarmDark : CurrentPalette.rockCool
        );
    }
    return done(p);
}
export const basaltLow = () => basaltGeo(3);
export function basaltTiny() {
    const p: THREE.BufferGeometry[] = [];
    hex(p, 0, 0, 0.6, 1.6, CurrentPalette.rockWarmDark);
    return done(p);
}
