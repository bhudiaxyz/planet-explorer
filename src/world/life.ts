import * as THREE from "three";
import { T, TERRAIN_GLSL } from "../render/terrain";
import { U } from "../render/fx";
import { gpuTier } from "../render/gputier";
import { CFG } from "../core/config";
const X = new THREE.Vector3(1, 0, 0),
    Y = new THREE.Vector3(0, 1, 0);

// Ambient life & sky events. Everything is GPU-driven: positions come from time + per-instance seeds in the vertex
// shader, so there is no per-frame CPU work beyond a handful of uniforms, and each effect is a single draw call.

// ---- Birds ---------------------------------------------------------------------------------------------------------
// One instanced mesh of low-poly birds (body + two flapping wings, 3 tris). Birds belong to flocks; each pass crosses the
// view left→right or right→left in front of the player, anchored in the world, re-seeded each cycle so a flock
// "occasionally" passes.
// Flock type follows the ground under the flight path (sampled once per flock from the terrain function):
//   coast → gulls (white, wheeling, loose), forest → crows (dark, ragged), open land → geese (grey V-formation).
const BIRD_VS = `
attribute vec4 aB; // x: flock index, y: slot in flock, z,w: per-bird jitter
uniform float uT, uPeriod, uFlocks, uPerFlock, uDay, uCov;
uniform vec3  uAnchor[3]; // per-flock ground anchor: where the player stood when this flock's pass began
uniform vec3  uUpA[3];    // up vector at that anchor
uniform vec3  uFwdA[3];   // camera forward at that anchor, flattened onto the ground plane
varying vec3  vCol;
varying float vVis;
${TERRAIN_GLSL}
float hh(float x) { return fract(sin(x * 91.3458) * 47453.5453); }
void main() {
  float fi    = aB.x, slot = aB.y;
  // each flock runs its own cycle, staggered; cycle index re-seeds the flock's path, type and timing
  float t     = uT / uPeriod + fi * .37;
  float cyc   = floor(t), ph = fract(t);
  float s     = hh(cyc * 13.1 + fi * 7.7);
  // a flock is airborne for 40% of its cycle (≈25 s of 60 s) and only in daylight with some chance per cycle
  float on    = step(.35, hh(cyc * 3.3 + fi)) * smoothstep(0., .08, ph) * (1. - smoothstep(.32, .4, ph));
  float prog  = clamp(ph / .4, 0., 1.);

  // local frame at the flock's anchor (fixed in the world for the whole pass, so walking doesn't drag the flock along)
  int  idx = int(fi + .5);
  vec3 anchor = uAnchor[idx], up = uUpA[idx];
  // Cross the view left→right or right→left: heading = ± the view's right axis (with up to ±15° wobble), and the pass
  // sits 50–140 m in front of where the player was looking, so the flock sweeps across the field of view.
  vec3 fwd   = uFwdA[idx];
  vec3 right = normalize(cross(fwd, up));
  float sgn  = hh(s * 3.7) < .5 ? 1. : -1.;
  float wob  = (hh(s * 6.1) - .5) * .52;
  vec3 dir   = normalize(right * sgn * cos(wob) + fwd * sin(wob)); // flight heading
  vec3 side  = normalize(cross(up, dir));
  side      *= sign(dot(side, fwd));             // "side" points away from the viewer
  float off  = 50. + hh(s * 5.1) * 90.;          // distance of the pass in front of the viewer
  float alt = 18. + hh(s * 9.7) * 27.;           // height above the player: 18–45 m, low across the sky

  // ground under the middle of the pass decides the flock type
  vec3  mid = normalize(anchor + side * off);
  float e   = e3(mid, false);
  float m   = pn(mid * uFreq * 2.2 + vec3(30., 0., 0.), 1);
  float coast  = 1. - smoothstep(.0, .06, abs(e));
  float forest = treeDensity(mid, m) * step(.02, e);
  float type   = coast > .5 ? 0. : forest > .35 ? 1. : 2.;   // 0 gull · 1 crow · 2 goose

  // formation offset in the flock's own (dir, side) frame
  float n = slot;
  vec2  f;
  if (type > 1.5) {            // V: alternate sides, trailing back
    float k = floor((n + 1.) * .5), sgn = mod(n, 2.) < .5 ? 1. : -1.;
    f = vec2(-k * 2.6, sgn * k * 2.4);
  } else {                     // loose cloud, wheeling (gulls) / ragged (crows)
    float a2 = n * 2.399 + uT * (type < .5 ? .45 : .2);
    float r2 = 2.5 + sqrt(n) * (type < .5 ? 3.2 : 2.4);
    f = vec2(cos(a2), sin(a2)) * r2;
  }
  f += (aB.zw - .5) * 1.4;

  float span  = 520.;
  vec3  base  = anchor + up * alt + side * off + dir * (prog - .5) * span;
  vec3  wpos  = base + dir * f.x + side * f.y + up * sin(uT * .9 + n) * .8;

  // wing flap: wings are the two outer vertices of each wing triangle (position.z marks them)
  float flapRate = type < .5 ? 5. : type < 1.5 ? 7. : 4.;
  float flap  = sin(uT * flapRate + n * 1.7 + aB.z * 6.283);
  float scale = type < .5 ? 1.1 : type < 1.5 ? .9 : 1.5; // ~2.6 m (gull) to 3.6 m (goose) wingspan: readable at 50–140 m
  vec3  lp    = position * scale;
  lp.y       += abs(position.x) * flap * .5 * scale;
  // orient the bird along its heading
  vec3 world = wpos + side * lp.x + up * lp.y + dir * lp.z;

  vCol = type < .5 ? vec3(.92, .93, .95) : type < 1.5 ? vec3(.08, .08, .1) : vec3(.42, .4, .38);
  // fade with daylight, cloud cover (birds shelter in storms) and the flock's on/off envelope
  vVis = on * uDay * (1. - smoothstep(.55, .85, uCov));
  vec4 mv = viewMatrix * vec4(world, 1.);
  gl_Position = projectionMatrix * mv;
  if (vVis < .01) gl_Position = vec4(2., 2., 2., 1.);
}`;
const BIRD_FS = `
varying vec3  vCol;
varying float vVis;
void main() {
  if (vVis < .01) discard;
  gl_FragColor = vec4(vCol, 1.);
}`;

export class Birds {
    mesh: THREE.Mesh;
    private mat: THREE.ShaderMaterial;
    constructor(scene: THREE.Scene) {
        // low tier: one small flock; the effect is a few hundred vertices on any tier
        const flocks = gpuTier === "low" ? 1 : gpuTier === "medium" ? 2 : 3,
            perFlock = gpuTier === "low" ? 7 : 11;
        // one bird = 2 wing triangles + body triangle; x = span axis, y = up, z = forward
        const tri = [
            // left wing (outer vertex at x = -1.2)
            0, 0, 0.35, 0, 0, -0.25, -1.2, 0, -0.1,
            // right wing
            0, 0, -0.25, 0, 0, 0.35, 1.2, 0, -0.1,
            // body / tail
            0, -0.05, 0.6, 0.12, -0.05, -0.55, -0.12, -0.05, -0.55,
        ];
        const g = new THREE.InstancedBufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3));
        const ab = new Float32Array(flocks * perFlock * 4);
        for (let f = 0, i = 0; f < flocks; f++)
            for (let s = 0; s < perFlock; s++, i++) ab.set([f, s, Math.random(), Math.random()], i * 4);
        g.setAttribute("aB", new THREE.InstancedBufferAttribute(ab, 4));
        g.instanceCount = flocks * perFlock;
        this.mat = new THREE.ShaderMaterial({
            side: THREE.DoubleSide,
            uniforms: {
                ...T,
                uT: U.uTime,
                uCov: U.uCov,
                uPeriod: { value: 62 },
                uFlocks: { value: flocks },
                uPerFlock: { value: perFlock },
                uDay: { value: 1 },
                uAnchor: { value: [0, 1, 2].map(() => new THREE.Vector3()) },
                uUpA: { value: [0, 1, 2].map(() => new THREE.Vector3(0, 1, 0)) },
                uFwdA: { value: [0, 1, 2].map(() => new THREE.Vector3(1, 0, 0)) },
            },
            vertexShader: BIRD_VS,
            fragmentShader: BIRD_FS,
        });
        this.mesh = new THREE.Mesh(g, this.mat);
        this.mesh.frustumCulled = false;
        scene.add(this.mesh);
    }
    private lastCycle = [-1, -1, -1];
    update(cam: THREE.Vector3, camFwd: THREE.Vector3, up: THREE.Vector3, dayF: number, alt: number) {
        const u = this.mat.uniforms,
            period = u.uPeriod.value as number,
            anchors = u.uAnchor.value as THREE.Vector3[],
            ups = u.uUpA.value as THREE.Vector3[],
            fwds = u.uFwdA.value as THREE.Vector3[];
        // re-anchor a flock only when its cycle rolls over (same cycle maths as the shader), while it is off screen
        for (let f = 0; f < u.uFlocks.value; f++) {
            const cyc = Math.floor(U.uTime.value / period + f * 0.37);
            if (cyc !== this.lastCycle[f]) {
                this.lastCycle[f] = cyc;
                anchors[f].copy(cam);
                ups[f].copy(up);
                // view direction flattened onto the ground plane (looking straight up/down: any horizontal axis)
                fwds[f].copy(camFwd).addScaledVector(up, -camFwd.dot(up));
                if (fwds[f].lengthSq() < 1e-4) fwds[f].crossVectors(up, Math.abs(up.y) < 0.9 ? Y : X);
                fwds[f].normalize();
            }
        }
        u.uDay.value = THREE.MathUtils.smoothstep(dayF, 0.15, 0.45);
        // birds fly near the ground: hide them once the player is well above their height band
        this.mesh.visible = dayF > 0.12 && alt < 400;
    }
}

// ---- Shooting stars ------------------------------------------------------------------------------------------------
// A few instanced streak quads on a 9 km shell around the camera (inside the 17 km sky dome, which draws first),
// placed in front of the viewer and crossing the view sideways (left→right or right→left). Each slot fires a ~0.9 s meteor at a random moment in its own 7–19 s cycle; the streak is a quad
// stretched along its path with a bright head and a fading tail. Night only, hidden by cloud and daylight.
export class ShootingStars {
    mesh: THREE.Mesh;
    private mat: THREE.ShaderMaterial;
    private seeds!: Float32Array;
    private per!: Float32Array;
    private lastCycle: number[] = [];
    constructor(scene: THREE.Scene) {
        const slots = gpuTier === "low" ? 2 : 4;
        const g = new THREE.InstancedBufferGeometry();
        // quad: x along the streak (0 = head … 1 = tail end), y across it
        g.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        const seed = new Float32Array(slots),
            per = new Float32Array(slots * 2);
        for (let i = 0; i < slots; i++) {
            seed[i] = Math.random() * 100;
            per[i * 2] = 7 + Math.random() * 12; // each slot fires once per 7–19 s
            per[i * 2 + 1] = Math.random();
        }
        g.setAttribute("aS", new THREE.InstancedBufferAttribute(seed, 1));
        g.setAttribute("aP", new THREE.InstancedBufferAttribute(per, 2));
        this.per = per;
        g.setAttribute(
            "aI",
            new THREE.InstancedBufferAttribute(
                new Float32Array(slots).map((_, i) => i),
                1
            )
        );
        g.instanceCount = slots;
        this.seeds = seed;
        this.mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            // The streak's across axis flips with its travel direction, so half the quads face away from the camera;
            // single-sided they were back-face culled and never drew.
            side: THREE.DoubleSide,
            // depth-tested so mountains and trees hide meteors (9 km is inside every tier's 20–40 km far plane)
            blending: THREE.AdditiveBlending,
            uniforms: {
                uT: U.uTime,
                uNight: U.uNight,
                uUp: { value: new THREE.Vector3(0, 1, 0) },
                uCam: { value: new THREE.Vector3() },
                // per-slot view direction latched when that slot's cycle starts, so a meteor doesn't swing as you turn
                uFwd: { value: Array.from({ length: 4 }, () => new THREE.Vector3(1, 0, 0)) },
            },
            vertexShader: `
attribute float aS;
attribute vec2  aP;      // x: cycle period (s), y: phase offset — computed on the CPU so both sides agree exactly
attribute float aI;      // slot index
uniform float uT, uNight;
uniform vec3  uUp, uCam; // uCam: camera position, passed explicitly every frame
uniform vec3  uFwd[4];   // per-slot camera view direction flattened onto the ground plane
varying float vA, vX;
// sin-free hash (Hoskins): sin() hashes lose precision on large arguments in float32 on some GPUs
float hh(float x) { x = fract(x * .1031); x *= x + 33.33; x *= x + x; return fract(x); }
void main() {
  float period = aP.x;
  float t   = uT / period + aP.y;
  float cyc = floor(t), ph = fract(t) * period;            // seconds into this slot's cycle
  float s   = hh(cyc * 17.3 + aS);
  float dur = .7 + hh(s * 3.1) * .4, start = hh(s * 5.9) * (period - dur);
  float life = clamp((ph - start) / dur, 0., 1.);
  float alive = step(start, ph) * step(ph, start + dur);
  // Start in front of the viewer (within ±40° of where they look, 8°–30° up: a level gaze sees ±35° vertically) and
  // cross the view left→right or right→left, slanting downward.
  vec3 fwd = uFwd[int(aI + .5)];
  vec3 right = normalize(cross(fwd, uUp));
  float az = (hh(s * 1.3) - .5) * 1.4, el = .14 + hh(s * 7.7) * .38;
  vec3 hz = fwd * cos(az) + right * sin(az);
  vec3 d0 = normalize(uUp * sin(el) + hz * cos(el));
  float sgn = hh(s * 2.2) < .5 ? 1. : -1.;
  d0 = normalize(d0 - right * sgn * .25);                 // begin on the far side so it travels across the view
  vec3 tang = normalize(right * sgn - uUp * (.2 + hh(s * 4.4) * .45));
  tang = normalize(tang - d0 * dot(tang, d0));
  float R = 9000., len = 900. + hh(s * 8.8) * 900.;
  vec3 head = normalize(d0 + tang * life * .32) * R;     // head advances along its arc
  vec3 across = normalize(cross(tang, normalize(head)));
  float tail = position.x * len * (.35 + .65 * min(life * 3., 1.)); // tail grows quickly, then holds
  // ~2 px wide at the head at 9 km (≈30 m), tapering to the tail; thinner was sub-pixel
  vec3 p = head - tang * tail + across * position.y * (30. * (1. - position.x * .8));
  vX = position.x;
  vA = alive * uNight * sin(life * 3.1416);               // fade in and out over its life
  gl_Position = projectionMatrix * (viewMatrix * vec4(uCam + p, 1.));
  if (vA < .005) gl_Position = vec4(2., 2., 2., 1.);
}`,
            fragmentShader: `
varying float vA, vX;
void main() {
  // just above the bloom threshold (0.75) at the head only: hotter values bloomed into large soft discs
  float a = vA * pow(max(1. - vX, 0.), 2.2);
  gl_FragColor = vec4(vec3(1., .94, .85) * a * 1.1, a);
}`,
        });
        this.mesh = new THREE.Mesh(g, this.mat);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = -50; // after the sky dome (−100)
        scene.add(this.mesh);
    }
    update(cam: THREE.Vector3, up: THREE.Vector3, camFwd: THREE.Vector3, night: number) {
        const u = this.mat.uniforms,
            fwds = u.uFwd.value as THREE.Vector3[];
        // three's built-in cameraPosition uniform read as the planet centre here (the streak was drawn ~8 km inside
        // the planet), so the camera position is passed explicitly every frame
        u.uCam.value.copy(cam);
        u.uUp.value.copy(up);
        for (let i = 0; i < this.seeds.length; i++) {
            // same cycle maths as the shader (exact shared period/offset): latch the view direction once per meteor
            const cyc = Math.floor(U.uTime.value / this.per[i * 2] + this.per[i * 2 + 1]);
            if (cyc === this.lastCycle[i]) continue;
            this.lastCycle[i] = cyc;
            // view direction flattened onto the ground plane (looking straight up: fall back to any horizontal axis)
            const f = fwds[i];
            f.copy(camFwd).addScaledVector(up, -camFwd.dot(up));
            if (f.lengthSq() < 1e-4) f.crossVectors(up, Math.abs(up.y) < 0.9 ? Y : X);
            f.normalize();
        }
        this.mesh.visible = night > 0.15;
    }
}

// ---- Waterfall mist -----------------------------------------------------------------------------------------------
// Rivers are ribbons draped on the terrain, and the terrain has no cliffs, so a steep reach is a cascade down a slope,
// not a vertical drop: the river shader turns those reaches white (see river.ts, aSteep). This adds the spray: a cloud
// of soft sprites drifting up from the foot of every big drop (≥ 6 m over ≤ 6 path steps, slope > 0.3).
// Built once per world on medium/high; one draw call.
const MIN_DROP = 6; // metres; smaller steps read as rapids hidden in the grass, not a waterfall
export function buildWaterfalls(paths: THREE.Vector3[][], R: number, maxFalls: number): THREE.Group | null {
    type Fall = { lip: THREE.Vector3; base: THREE.Vector3; flow: THREE.Vector3; width: number; drop: number };
    const falls: Fall[] = [];
    for (const path of paths) {
        const n = path.length;
        // skip the source and mouth tapers (the ribbon is near-zero width there)
        for (let i = Math.floor(n * 0.15); i < Math.floor(n * 0.85) - 1 && falls.length < maxFalls; i++) {
            const h0 = path[i].length() - R;
            let best = -1,
                bestDrop = 0;
            // look up to 6 steps ahead: the bed is sampled every ~10 m, so a cliff shows as a steep multi-step run
            for (let k = 1; k <= 6 && i + k < n; k++) {
                const drop = h0 - (path[i + k].length() - R),
                    run = path[i].distanceTo(path[i + k]);
                if (drop > MIN_DROP && drop / run > 0.3 && drop > bestDrop) {
                    best = i + k;
                    bestDrop = drop;
                }
            }
            if (best < 0) continue;
            // keep waterfalls apart (≥ 60 m) so a long steep reach makes one fall, not a staircase
            if (falls.some((f) => f.lip.distanceTo(path[i]) < 60)) continue;
            const t = i / (n - 1),
                { widthStart: w0, widthEnd: w1 } = CFG.river,
                width = (w0 + (w1 - w0) * t * t) * 1.1; // ribbon width there (scale-free estimate), slightly wider
            falls.push({
                lip: path[i].clone(),
                base: path[best].clone(),
                flow: path[best].clone().sub(path[i]).normalize(),
                width: Math.max(1.5, width),
                drop: bestDrop,
            });
            i = best; // continue after this fall
        }
    }
    if (!falls.length) return null;

    // mist: a few soft sprites per fall, drifting up and fading, around the plunge point
    const per = 10,
        mp = new Float32Array(falls.length * per * 3),
        ms = new Float32Array(falls.length * per * 4);
    falls.forEach((f, i) => {
        for (let k = 0; k < per; k++) {
            const j = (i * per + k) * 3;
            mp[j] = f.base.x;
            mp[j + 1] = f.base.y;
            mp[j + 2] = f.base.z;
            ms.set([Math.random(), Math.random(), Math.random(), f.width], (i * per + k) * 4);
        }
    });
    const mgeo = new THREE.BufferGeometry();
    mgeo.setAttribute("position", new THREE.BufferAttribute(mp, 3));
    mgeo.setAttribute("sd", new THREE.BufferAttribute(ms, 4));
    const mist = new THREE.Points(
        mgeo,
        new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            uniforms: { uT: U.uTime, uDay: U.uDayF },
            vertexShader: `
attribute vec4 sd;
uniform float uT;
varying float vA;
void main() {
  vec3 up = normalize(position);
  vec3 a  = normalize(cross(up, abs(up.y) < .9 ? vec3(0., 1., 0.) : vec3(1., 0., 0.))), b = cross(up, a);
  float life = fract(uT * .22 + sd.x);                 // each puff rises and fades over ~4.5 s
  float ang  = sd.y * 6.283;
  vec3 w = position + (a * cos(ang) + b * sin(ang)) * (sd.w * .6 + life * 2.5) + up * (life * 3.5 - .3);
  vA = sin(life * 3.1416) * (.5 + .5 * sd.z);
  vec4 mv = modelViewMatrix * vec4(w, 1.);
  gl_PointSize = min((sd.w * 1.4 + life * 4.) * 300. / -mv.z, 140.);
  gl_Position = projectionMatrix * mv;
}`,
            fragmentShader: `
uniform float uDay;
varying float vA;
void main() {
  float d = length(gl_PointCoord - .5) * 2.;
  if (d > 1.) discard;
  gl_FragColor = vec4(vec3(.92, .95, 1.) * (.4 + .6 * uDay), (1. - d * d) * vA * .32);
}`,
        })
    );
    mist.frustumCulled = false;
    mist.renderOrder = 4;
    const g = new THREE.Group();
    g.add(mist);
    g.userData.count = falls.length;
    return g;
}

// ---- Lightning -----------------------------------------------------------------------------------------------------
// During heavy rain a bolt strikes every 4–12 s somewhere 200–600 m from the player, across the view. The bolt is a
// jagged polyline from the cloud base to the ground built in the vertex shader from a per-strike seed (one instanced
// draw, `segs` segment quads); the flash briefly lifts the sky and ambient light (applied by the caller via flash()).
export class Lightning {
    mesh: THREE.Mesh;
    private mat: THREE.ShaderMaterial;
    private next = 6;
    private t = 99; // seconds since the current strike
    private flashV = 0;
    constructor(scene: THREE.Scene) {
        const segs = 14;
        const g = new THREE.InstancedBufferGeometry();
        // quad along a segment: x 0..1 along it, y −1..1 across it
        g.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        g.setAttribute(
            "aSeg",
            new THREE.InstancedBufferAttribute(
                new Float32Array(segs).map((_, i) => i),
                1
            )
        );
        g.instanceCount = segs;
        this.mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uSeed: { value: 0 },
                uAge: { value: 99 },
                uSegs: { value: segs },
                uCam: { value: new THREE.Vector3() },
                uOrig: { value: new THREE.Vector3() }, // strike point on the ground
                uUp: { value: new THREE.Vector3(0, 1, 0) },
                uSide: { value: new THREE.Vector3(1, 0, 0) },
                uH: { value: 150 }, // cloud-base height above the strike point
            },
            vertexShader: `
attribute float aSeg;
uniform float uSeed, uAge, uSegs, uH;
uniform vec3  uCam, uOrig, uUp, uSide;
varying float vA, vY;
float hh(float x) { x = fract(x * .1031); x *= x + 33.33; x *= x + x; return fract(x); }
// jitter of the bolt at fraction f of its height: a few random kinks, tapering to zero at the ground
vec3 bolt(float f) {
  vec3 fwd = cross(uUp, uSide);
  float k = f * uSegs;
  float j1 = (hh(floor(k) + uSeed * 7.1) - .5), j2 = (hh(floor(k) + uSeed * 3.3 + 50.) - .5);
  float j1n = (hh(floor(k) + 1. + uSeed * 7.1) - .5), j2n = (hh(floor(k) + 1. + uSeed * 3.3 + 50.) - .5);
  float fr = fract(k);
  float amp = uH * .09 * f;                      // wider kinks higher up, converging on the strike point
  return uOrig + uUp * (f * uH) + (uSide * mix(j1, j1n, fr) + fwd * mix(j2, j2n, fr)) * amp;
}
void main() {
  float f0 = aSeg / uSegs, f1 = (aSeg + 1.) / uSegs;
  vec3 a = bolt(f0), b = bolt(f1);
  vec3 dir = normalize(b - a);
  vec3 toCam = normalize(uCam - a);
  vec3 across = normalize(cross(dir, toCam));    // billboard the segment toward the camera
  float w = mix(4., 1.8, f0);                    // ~2–4 px at 200–600 m; thicker near the cloud
  vec3 p = mix(a, b, position.x) + across * position.y * w;
  // strike lasts ~0.35 s: a bright flicker (two pulses) then a quick fade
  float life = uAge / .35;
  vA = life < 1. ? (1. - life) * (.6 + .4 * step(.5, fract(uAge * 22.))) : 0.;
  vY = position.y;
  gl_Position = projectionMatrix * (viewMatrix * vec4(p, 1.));
  if (vA < .01) gl_Position = vec4(2., 2., 2., 1.);
}`,
            fragmentShader: `
varying float vA, vY;
void main() {
  float core = 1. - abs(vY);
  // HDR-bright core: a strike outshines even an overcast daytime sky, and bloom adds the glow around it
  gl_FragColor = vec4(vec3(.82, .88, 1.) * (core * core * 6. + core * 1.2) * vA, core * vA);
}`,
        });
        this.mesh = new THREE.Mesh(g, this.mat);
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        scene.add(this.mesh);
    }
    /** Returns the current flash strength (0..1) so the caller can brighten sky / ambient light. */
    update(
        dt: number,
        cam: THREE.Vector3,
        camFwd: THREE.Vector3,
        up: THREE.Vector3,
        rain: number,
        groundRadiusAt: (d: THREE.Vector3) => number
    ): number {
        const u = this.mat.uniforms;
        this.t += dt;
        u.uAge.value = this.t;
        if (rain > 0.7 && (this.next -= dt) < 0) {
            this.next = 4 + Math.random() * 8;
            this.t = 0;
            u.uSeed.value = Math.random() * 1000;
            // strike point: ahead and off to one side so it is seen across the view, on the actual ground
            const right = new THREE.Vector3().crossVectors(camFwd, up).normalize();
            const fwdH = new THREE.Vector3().copy(camFwd).addScaledVector(up, -camFwd.dot(up)).normalize();
            const dist = 200 + Math.random() * 400,
                side = (Math.random() - 0.5) * 1.2 * dist;
            const target = cam.clone().addScaledVector(fwdH, dist).addScaledVector(right, side).normalize();
            u.uOrig.value.copy(target).multiplyScalar(groundRadiusAt(target));
            u.uUp.value.copy(target);
            u.uSide.value.copy(right);
            u.uCam.value.copy(cam);
            u.uH.value = 140 + Math.random() * 80;
        }
        u.uCam.value.copy(cam);
        this.mesh.visible = this.t < 0.4;
        // sky flash: a sharp spike at the strike, a weaker after-flash, gone in ~0.3 s
        // the bolt shows alone for ~40 ms (contrast against the dark storm sky), then the sky lights up and pulses once
        const fl =
            this.t < 0.04 || this.t > 0.32
                ? 0
                : (1 - (this.t - 0.04) / 0.28) * (this.t < 0.1 || (this.t > 0.15 && this.t < 0.2) ? 1 : 0.35);
        this.flashV = fl;
        return this.flashV;
    }
}

// ---- Butterflies & falling leaves (high tier) -----------------------------------------------------------------------
// One instanced mesh of two-triangle "flutterers" in a world-anchored 70 m cell around the player (wrapping with mod(),
// like the fireflies). Each picks its role from the ground under it:
//   meadow (open, moist grassland, outside forest)   → butterfly: bright wings flapping, wandering 0.5–3 m up
//   under trees (forest density)                     → leaf: autumn-tinted, tumbling down from canopy height
//   anywhere else (sand, rock, snow, water)          → hidden
// Daylight only. Ground height comes from the shared terrain function, so they hover over the real surface.
export class Flutter {
    mesh: THREE.Mesh;
    private mat: THREE.ShaderMaterial;
    constructor(scene: THREE.Scene) {
        const count = 160;
        const g = new THREE.InstancedBufferGeometry();
        // two triangles hinged on the x = 0 body line: left wing (x < 0) and right wing (x > 0)
        g.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(
                [0, 0, 0.12, -1, 0, 0.2, 0, 0, -0.12, 0, 0, 0.12, 0, 0, -0.12, 1, 0, 0.2],
                3
            )
        );
        const sd = new Float32Array(count * 4);
        for (let i = 0; i < sd.length; i++) sd[i] = Math.random();
        g.setAttribute("sd", new THREE.InstancedBufferAttribute(sd, 4));
        g.instanceCount = count;
        this.mat = new THREE.ShaderMaterial({
            side: THREE.DoubleSide,
            uniforms: {
                ...T,
                uT: U.uTime,
                uDay: { value: 1 },
                uWindT: U.uWind,
                uCam: { value: new THREE.Vector3() },
            },
            vertexShader: `
attribute vec4 sd;
uniform float uT, uDay, uWindT;
uniform vec3  uCam;
varying vec3  vCol;
${TERRAIN_GLSL}
void main() {
  // world-anchored cell around the camera: each seed has a fixed home that wraps as the player moves
  vec3 home = uCam + (mod(sd.xyz * 70. - uCam, 70.) - 35.);
  vec3 d    = normalize(home);
  float e   = e3(d, false);
  float m   = pn(d * uFreq * 2.2 + vec3(30., 0., 0.), 1);
  float td  = treeDensity(d, m);
  // same temperature proxy the plant bake uses; above the snowline nothing flutters (cold, white ground)
  float tt   = 1. - 1.1 * d.y * d.y - 1.2 * max(e, 0.);
  float warm = step(uSnow + .12, tt);
  float meadow = warm * step(.02, e) * (1. - step(.38, e)) * smoothstep(-.1, .15, m) * (1. - smoothstep(.15, .4, td));
  float forest = warm * step(.02, e) * smoothstep(.25, .5, td);
  float role   = forest > .5 ? 1. : meadow > .5 ? 0. : -1.; // 0 butterfly · 1 leaf · −1 hidden

  vec3 up = d;
  vec3 a  = normalize(cross(up, abs(up.y) < .9 ? vec3(0., 1., 0.) : vec3(1., 0., 0.))), b = cross(up, a);
  float ground = uR + e * uAmp;
  float t = uT + sd.w * 40.;
  vec3 pos;
  vec3 fwd, side;
  float flap, scale;
  if (role < .5) {
    // butterfly: lazy wandering loops, bobbing height, fast flap
    vec2 wander = vec2(sin(t * .31 + sd.x * 9.) + .5 * sin(t * .73 + sd.y * 5.), cos(t * .27 + sd.y * 7.) + .5 * cos(t * .61 + sd.z * 4.)) * 3.;
    float hgt = 0.6 + 1.6 * (.5 + .5 * sin(t * .5 + sd.z * 6.));
    pos  = d * (ground + hgt) + a * wander.x + b * wander.y;
    vec2 vel = vec2(cos(t * .31 + sd.x * 9.), -sin(t * .27 + sd.y * 7.));
    fwd  = normalize(a * vel.x + b * vel.y);
    side = normalize(cross(up, fwd));
    flap = abs(sin(t * 11. + sd.x * 6.)) * 1.25;   // wings 0 (flat) … up to ~70°
    scale = .09 + sd.y * .05;
    float hue = sd.z;
    vCol = hue < .25 ? vec3(1., .55, .08) : hue < .5 ? vec3(.95, .9, .3) : hue < .75 ? vec3(.35, .55, 1.) : vec3(1., 1., .97);
  } else {
    // leaf: falls from canopy height on a ~9 s loop, swaying and tumbling, drifting downwind
    float cyc = fract(t / 9.);
    float hgt = mix(9., .1, cyc);
    vec2 sway = vec2(sin(t * 1.7 + sd.x * 6.), cos(t * 1.3 + sd.y * 6.)) * (.6 + uWindT * .8) + vec2(cyc * 4. * uWindT, 0.);
    pos  = d * (ground + hgt) + a * sway.x + b * sway.y;
    fwd  = normalize(a * cos(t * 2.1 + sd.z * 6.) + b * sin(t * 2.1 + sd.z * 6.));
    side = normalize(cross(up, fwd));
    flap = sin(t * 3. + sd.w * 6.) * .8 + 1.57 * step(.5, fract(t * .4 + sd.x)); // tumble
    scale = .1 + sd.y * .05;
    vCol = mix(vec3(.85, .45, .1), vec3(.62, .2, .08), sd.z) * (.8 + .4 * sd.x);
    if (cyc > .97) role = -1.;                    // resting on the ground: hide before the loop restarts
  }
  // wing hinge: rotate each half about the body line (fwd axis)
  vec3 lp = position * scale * vec3(1., 1., 1.6);
  float s  = sign(position.x);
  float ang = flap * s;
  vec3 world = pos + fwd * lp.z + (side * cos(ang) + up * sin(ang)) * abs(lp.x) * s;
  vec4 mv = viewMatrix * vec4(world, 1.);
  gl_Position = projectionMatrix * mv;
  float vis = uDay * (role < -.5 ? 0. : 1.) * (1. - smoothstep(26., 34., length(pos - uCam)));
  vCol *= .55 + .45 * uDay;
  if (vis < .01) gl_Position = vec4(2., 2., 2., 1.);
}`,
            fragmentShader: `
varying vec3 vCol;
void main() { gl_FragColor = vec4(vCol, 1.); }`,
        });
        this.mesh = new THREE.Mesh(g, this.mat);
        this.mesh.frustumCulled = false;
        scene.add(this.mesh);
    }
    update(cam: THREE.Vector3, dayF: number, alt: number) {
        this.mat.uniforms.uCam.value.copy(cam);
        this.mat.uniforms.uDay.value = THREE.MathUtils.smoothstep(dayF, 0.2, 0.5);
        // close-range detail: off at night and once the player is well above the ground
        this.mesh.visible = dayF > 0.2 && alt < 40;
    }
}
