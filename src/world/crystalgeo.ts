import * as THREE from "three";
import { rng } from "../core/noise";
import { CurrentPalette } from "../core/palette";
import { N0, add, done, tiny, M } from "./geoutil";

// Glowing crystals. Four kinds, each with near / mid / far tiers (see plants.ts): crystal spikes (dry mid-high ground),
// geodes (dry mid altitude), ice crystals (near the snowline) and ember shards (hot, dry lowlands).

// Crystal spikes: clusters of elongated octahedra; leaf=true so tint drives the emissive-style HDR color
export function crystalGeo() {
    const p: THREE.BufferGeometry[] = [];
    const r = rng(53);
    const count = 3 + ((r() * 3) | 0);
    for (let i = 0; i < count; i++) {
        const a = (i / count) * 6.283 + r() * 0.9;
        const rad = r() * 0.16;
        const h = 0.45 + r() * 0.65;
        add(
            p,
            new THREE.OctahedronGeometry(1, 0),
            M(
                new THREE.Vector3(Math.cos(a) * rad, h * 0.5, Math.sin(a) * rad),
                new THREE.Euler((r() - 0.5) * 0.3, a, 0.25 + (r() - 0.5) * 0.2),
                new THREE.Vector3(0.12 + r() * 0.05, h, 0.12 + r() * 0.05)
            ),
            N0,
            h * 0.5,
            false,
            true
        );
    }
    return done(p);
}
export function crystalLow() {
    const p: THREE.BufferGeometry[] = [];
    const r = rng(59);
    for (let i = 0; i < 2; i++) {
        const a = i * 2.8 + r() * 0.5;
        const h = 0.35 + r() * 0.35;
        add(
            p,
            new THREE.OctahedronGeometry(1, 0),
            M(
                new THREE.Vector3(Math.cos(a) * 0.08, h * 0.5, Math.sin(a) * 0.08),
                new THREE.Euler(0, a, 0.2),
                new THREE.Vector3(0.14, h, 0.14)
            ),
            N0,
            h * 0.5,
            false,
            true
        );
    }
    return done(p);
}
export const crystalTiny = () => tiny(N0, 0.35, 0.14, 0.7, true);

// ---- crystal variety. Glowing parts are leaf-flagged with a bright neutral shade (the `look` tint drives their HDR
// colour); rock / casing parts keep their own dark colour and are skipped by the glow mask in `look` (min channel < .4,
// the same test the flowers use for petals vs stems).
const glowSpike = (
    p: THREE.BufferGeometry[],
    pos: THREE.Vector3,
    rot: THREE.Euler,
    w: number,
    h: number,
    shape: THREE.BufferGeometry = new THREE.OctahedronGeometry(1, 0)
) =>
    add(
        p,
        shape,
        M(pos, rot, new THREE.Vector3(w, h, w)),
        N0,
        0, // no height AO: crystals glow evenly, and the bright shade (1.0) is what the glow mask keys on
        false,
        true
    );
const darkRock = (p: THREE.BufferGeometry[], m: THREE.Matrix4, det: number) =>
    add(
        p,
        new THREE.IcosahedronGeometry(1, det),
        m,
        new THREE.Color(CurrentPalette.rockWarmDark).multiplyScalar(0.55),
        0.5,
        true
    );

// Geode: a half-buried, split rock dome with a ring of crystals glowing in its opening (dry mid altitude)
export function geodeGeo(det = 1, spikes = 7) {
    const p: THREE.BufferGeometry[] = [],
        r = rng(131);
    // two shell halves leaning apart, leaving the cracked-open top
    for (const side of [-1, 1])
        darkRock(
            p,
            M(
                new THREE.Vector3(side * 0.32, 0.15, 0),
                new THREE.Euler(0, 0, side * 0.35),
                new THREE.Vector3(0.42, 0.42, 0.62)
            ),
            det
        );
    for (let i = 0; i < spikes; i++) {
        const a = (i / spikes) * 6.283 + r() * 0.5,
            rad = 0.08 + r() * 0.16,
            h = 0.22 + r() * 0.3;
        glowSpike(
            p,
            new THREE.Vector3(Math.cos(a) * rad * 0.6, 0.18 + h * 0.4, Math.sin(a) * rad),
            new THREE.Euler(Math.sin(a) * 0.5, a, Math.cos(a) * 0.5),
            0.06 + r() * 0.03,
            h
        );
    }
    return done(p);
}
export const geodeLow = () => geodeGeo(0, 3);
export function geodeTiny() {
    const p: THREE.BufferGeometry[] = [];
    darkRock(p, M(new THREE.Vector3(0, 0.15, 0), null, new THREE.Vector3(0.6, 0.4, 0.6)), 0);
    glowSpike(p, new THREE.Vector3(0, 0.4, 0), new THREE.Euler(), 0.14, 0.3);
    return done(p);
}

// Ice crystals: tall, thin, branching spires with side shoots (high altitude near the snowline)
export function iceCrystalGeo(spires = 3, shoots = 2) {
    const p: THREE.BufferGeometry[] = [],
        r = rng(137),
        hex = new THREE.ConeGeometry(1, 1, 6); // six-sided, like ice
    for (let i = 0; i < spires; i++) {
        const a = (i / spires) * 6.283 + r() * 0.6,
            off = i === 0 ? 0 : 0.12 + r() * 0.12,
            h = i === 0 ? 1.5 + r() * 0.5 : 0.6 + r() * 0.6,
            base = new THREE.Vector3(Math.cos(a) * off, h * 0.5, Math.sin(a) * off);
        glowSpike(p, base, new THREE.Euler((r() - 0.5) * 0.25, a, (r() - 0.5) * 0.25), 0.07 + r() * 0.03, h, hex);
        for (let k = 0; k < shoots; k++) {
            const y = h * (0.3 + 0.4 * r()),
                b = a + (k ? 2.1 : -2.1);
            glowSpike(
                p,
                new THREE.Vector3(base.x + Math.cos(b) * 0.09, y, base.z + Math.sin(b) * 0.09),
                new THREE.Euler(Math.sin(b) * 0.9, b, Math.cos(b) * 0.9),
                0.035,
                0.28 + r() * 0.15,
                hex
            );
        }
    }
    return done(p);
}
export const iceCrystalLow = () => iceCrystalGeo(2, 0);
export const iceCrystalTiny = () => tiny(N0, 0.7, 0.12, 1.4, true);

// Ember shards: short, broken, tilted dark shards with a hot glowing core (hot dry lowlands)
export function emberGeo(n = 5) {
    const p: THREE.BufferGeometry[] = [],
        r = rng(149);
    for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.283 + r() * 0.8,
            d = 0.1 + r() * 0.3,
            h = 0.2 + r() * 0.35,
            pos = new THREE.Vector3(Math.cos(a) * d, h * 0.35, Math.sin(a) * d),
            rot = new THREE.Euler(Math.sin(a) * 0.9, a, Math.cos(a) * 0.9);
        // dark charred casing, with the glowing core poking out of its broken top
        add(
            p,
            new THREE.OctahedronGeometry(1, 0),
            M(pos, rot, new THREE.Vector3(0.11, h, 0.11)),
            new THREE.Color(0.06, 0.04, 0.035),
            h,
            false
        );
        glowSpike(p, pos.clone().add(new THREE.Vector3(0, h * 0.25, 0)), rot, 0.06, h * 0.85);
    }
    return done(p);
}
export const emberLow = () => emberGeo(2);
export const emberTiny = () => tiny(N0, 0.2, 0.3, 0.3, true);
