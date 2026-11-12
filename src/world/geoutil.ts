import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
// Shared procedural-geometry helpers: every plant/tree part is baked into one merged, vertex-coloured, non-indexed geometry.
// Foliage parts carry aLeaf = 1 and a neutral height-AO shade (hue is supplied per tree / per plant); other parts keep their own colour.
export const UP = new THREE.Vector3(0, 1, 0),
    C = (h: number) => new THREE.Color(h);
export const N0 = C(0);
const hh = (x: number, y: number, z: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return s - Math.floor(s);
};

// Bake one primitive into the part list. Foliage (leaf = true) gets a neutral height-AO shade; other parts keep their colour. soft = jittered blob with radial normals.
export function add(
    parts: THREE.BufferGeometry[],
    g0: THREE.BufferGeometry,
    m: THREE.Matrix4,
    c: THREE.Color,
    ao = 0,
    soft = false,
    leaf = false,
    flutter: false | [number, number] = false
) {
    const g = g0.index ? g0.toNonIndexed() : g0.clone();
    g.deleteAttribute("uv");
    const p = g.attributes.position,
        n = g.attributes.normal,
        ctr = new THREE.Vector3().setFromMatrixPosition(m),
        col = new Float32Array(p.count * 3),
        t = new THREE.Vector3(),
        cc = new THREE.Color();
    // aLeaf: 0 bark · 1 foliage · motion bands (colour uses min(aLeaf, 1), so all of these stay leaf-coloured):
    //   1→2 polygonal leaf blade, stem → tip (fast flicker) · 2→3 palm frond, base → tip (slow bob)
    // The ramp comes from the part's own y before transform, mapped onto flutter = [from, to].
    const al = new Float32Array(p.count).fill(leaf ? 1 : 0);
    if (flutter) {
        const [from, to] = flutter;
        g0.computeBoundingBox();
        const { min, max } = g0.boundingBox!,
            span = Math.max(1e-6, max.y - min.y);
        for (let i = 0; i < p.count; i++)
            al[i] = from + (to - from) * Math.min(1, Math.max(0, (p.getY(i) - min.y) / span));
    }
    if (soft)
        for (let i = 0; i < p.count; i++) {
            const k = 1 + 0.6 * (hh(p.getX(i), p.getY(i), p.getZ(i)) - 0.5);
            p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
        }
    g.applyMatrix4(m);
    for (let i = 0; i < p.count; i++) {
        if (soft) {
            t.fromBufferAttribute(p, i).sub(ctr).normalize();
            n.setXYZ(i, t.x, t.y, t.z);
        }
        const sh = ao ? 0.6 + 0.55 * Math.min(1, Math.max(0, ((p.getY(i) - ctr.y) / ao) * 0.5 + 0.5)) : 1;
        if (leaf) cc.setRGB(sh, sh, sh);
        else cc.copy(c).multiplyScalar(sh);
        cc.toArray(col, i * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aLeaf", new THREE.BufferAttribute(al, 1));
    parts.push(g);
}
export const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
export function cyl(
    p: THREE.BufferGeometry[],
    a: THREE.Vector3,
    b: THREE.Vector3,
    r0: number,
    r1: number,
    c: THREE.Color,
    seg = 6
) {
    const m = new THREE.Matrix4().compose(
        a.clone().add(b).multiplyScalar(0.5),
        new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize()),
        new THREE.Vector3(1, 1, 1)
    );
    add(p, new THREE.CylinderGeometry(r1, r0, a.distanceTo(b), seg, 1), m, c);
}
// When set, every foliage blob records its canopy ellipsoid here (trees.ts uses it to add leaves to detailed crowns).
let canopyLog: [THREE.Vector3, number, number][] | null = null;
export const logCanopies = (log: [THREE.Vector3, number, number][] | null) => (canopyLog = log);
export const blob = (
    p: THREE.BufferGeometry[],
    c0: THREE.Vector3,
    r: number,
    c: THREE.Color,
    sy = 0.8,
    det = 1,
    leaf = true
) => {
    if (leaf) canopyLog?.push([c0.clone(), r, sy]);
    add(
        p,
        new THREE.IcosahedronGeometry(1, det),
        new THREE.Matrix4().compose(c0, new THREE.Quaternion(), new THREE.Vector3(r, r * sy, r)),
        c,
        r * sy,
        true,
        leaf
    );
};
// One polygonal leaf: a diamond (tip at +y) folded slightly along its midrib, with both faces built in — the tree material
// is single-sided, and making it double-sided would cost every tree. 4 triangles, unit length, ~0.55 wide.
const LEAF = (() => {
    const f = 0.12, // midrib fold depth (fraction of width): catches light like a real leaf
        quad = [0, 0, 0, -0.28, 0.42, f, 0, 1, 0, 0.28, 0.42, f], // stem, left, tip, right
        g = new THREE.BufferGeometry();
    // vertices duplicated for the back so each side gets its own (opposite) normal
    g.setAttribute("position", new THREE.Float32BufferAttribute([...quad, ...quad], 3));
    g.setIndex([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7]); // front, then back (reverse winding)
    g.computeVertexNormals();
    return g;
})();
/**
 * Scatter n leaves over the surface of an ellipsoid canopy (centre c0, radius r, vertical squash sy), each pointing
 * outward with random spin and size. Foliage-flagged like blob(), so per-tree hue, autumn tint and snow apply.
 * Used on the detailed tree tier only (~70 m), so the cost (4 triangles a leaf) never reaches the far forest.
 */
export function leaves(
    p: THREE.BufferGeometry[],
    rand: () => number,
    c0: THREE.Vector3,
    r: number,
    sy: number,
    n: number,
    size = 0.55
) {
    const dir = new THREE.Vector3(),
        q = new THREE.Quaternion(),
        spin = new THREE.Quaternion(),
        Y = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
        // random direction biased upward and outward (crowns read from below and the side)
        dir.set(rand() * 2 - 1, rand() * 1.4 - 0.4, rand() * 2 - 1).normalize();
        const pos = new THREE.Vector3(dir.x * r, dir.y * r * sy, dir.z * r)
                .multiplyScalar(0.92 + rand() * 0.14)
                .add(c0),
            s = size * (0.75 + rand() * 0.5);
        // leaf tip points outward, tilted toward the sky by up to ~35°, then spun about its own axis
        q.setFromUnitVectors(
            Y,
            dir
                .clone()
                .lerp(Y, 0.15 + rand() * 0.25)
                .normalize()
        );
        spin.setFromAxisAngle(Y, rand() * 6.283);
        add(
            p,
            LEAF,
            new THREE.Matrix4().compose(pos, q.multiply(spin), new THREE.Vector3(s, s, s)),
            N0,
            0,
            false,
            true,
            [1, 2]
        );
    }
}
export const done = (p: THREE.BufferGeometry[]) => mergeGeometries(p)!;
/** Palm frond segment. sway = [from, to] places it in the frond motion band (2 base → 3 tip); omit for a rigid frond. */
export function frond(
    p: THREE.BufferGeometry[],
    a: THREE.Vector3,
    b: THREE.Vector3,
    w: number,
    c: THREE.Color,
    sway: [number, number] | false = false
) {
    const len = a.distanceTo(b),
        m = new THREE.Matrix4().compose(
            a.clone().add(b).multiplyScalar(0.5),
            new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize()),
            new THREE.Vector3(1, 1, 0.28)
        );
    add(p, new THREE.ConeGeometry(w, len, 4), m, c, len / 2, false, true, sway);
}
