import * as THREE from "three";
import { CFG } from "../core/config";
import { gpuTier, isTouchDevice } from "./gputier";
const X = new THREE.Vector3(1, 0, 0),
    Y = new THREE.Vector3(0, 1, 0);

/**
 * Sun + moon shadow rig. One ortho shadow frustum per light follows the camera, snapped to shadow-texel steps (no crawling) and refreshed at CFG.shadow.hz instead of every frame.
 * `castShadow` stays true for the whole session (toggling it recompiles every material); shadow *intensity* fades in/out instead.
 */
export class Shadows {
    private on = false;
    private timer = 0;
    private hz: number = CFG.shadow.hz;
    private half: number = CFG.shadow.half;
    private strength = 0;
    private moonOn = false;
    private moonStrength = 0;
    private tgt = new THREE.Vector3();
    private right = new THREE.Vector3();
    private up = new THREE.Vector3();
    private moonDir = new THREE.Vector3();
    private tex = 1; // metres per sun shadow texel (snap step)
    private moonTex = 1;
    constructor(
        private renderer: THREE.WebGLRenderer,
        private light: THREE.DirectionalLight,
        private moon?: THREE.DirectionalLight
    ) {
        const { size: rawSize } = CFG.shadow;
        // high desktop (discrete GPU / M-series): 2048² sun map → ~12 cm texels, enough for rock/shrub contact shadows.
        // Phones stay at 1024: a 2048² depth map is 16 MB re-rendered at 30 Hz, too much bandwidth for a tiler GPU.
        // High desktop: 3072² over ±190 m — same ~12 cm texels as the old 2048² over ±120 m, but the shadowed range
        // grows ~60%, so the medium-tier trees out to ~235 m (and the farther high-desktop tree LOD) stay grounded.
        // A separate coarse far-shadow light isn't possible in three: each light's shadow only darkens its own light.
        const highDesk = gpuTier === "high" && !isTouchDevice;
        const sizeMul = gpuTier === "low" ? 0.25 : gpuTier === "medium" ? 0.5 : isTouchDevice ? 1 : 3;
        this.half =
            gpuTier === "low" ? CFG.shadow.half * 0.65 : highDesk ? CFG.shadow.half * (190 / 120) : CFG.shadow.half;
        const half = this.half;
        const size = Math.round(rawSize * sizeMul);
        this.hz = gpuTier === "low" ? 20 : gpuTier === "medium" ? 30 : CFG.shadow.hz;
        // snap step must use the real map size per light, or texel-snapping only half-works on low/medium and for the moon
        this.tex = (2 * half) / size;
        this.moonTex = (2 * half) / (size >> 1);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.needsUpdate = true;
        light.castShadow = true;
        light.shadow.mapSize.set(size, size);
        Object.assign(light.shadow.camera, {
            left: -half,
            right: half,
            top: half,
            bottom: -half,
            near: 1,
            far: 700,
        });
        light.shadow.bias = -0.0004;
        // normal bias was tuned for 1024² over 240 m (0.23 m texels); the 2048² high-desktop map halves it so shadows
        // stay attached to small rocks. Never raised above 0.4, so low/medium look exactly as before.
        light.shadow.normalBias = Math.min(0.4, 0.4 * (this.tex / ((2 * CFG.shadow.half) / CFG.shadow.size)));
        // PCF in three r18x is a fixed 5-tap rotated Vogel disk; radius only widens it (same cost). Widen on high, where the
        // finer map would otherwise give hard, aliased edges. Low/medium keep 1 (their texels are already coarse).
        light.shadow.radius = gpuTier === "high" ? 2.5 : 1;
        // per-light update flags: each depth pass runs only when its light is visible (no castShadow toggling → no recompiles).
        // needsUpdate = true here so the first render (the startup warm-up) draws every light once: three only allocates a
        // light's shadow map when it renders it, and a missing map leaves lit draws with an empty sampler2DShadow.
        light.shadow.autoUpdate = false;
        light.shadow.needsUpdate = true;
        if (moon) {
            moon.shadow.autoUpdate = false;
            moon.shadow.needsUpdate = true;
            const moonSize = Math.round(size >> 1);
            moon.castShadow = true;
            moon.shadow.mapSize.set(moonSize, moonSize);
            Object.assign(moon.shadow.camera, {
                left: -half,
                right: half,
                top: half,
                bottom: -half,
                near: 1,
                far: 700,
            });
            moon.shadow.bias = -0.0004;
            moon.shadow.normalBias = 0.4;
        }
    }
    update(dt: number, alt: number, dayF: number, sun: THREE.Vector3, cam: THREE.Vector3) {
        if (alt < 150) this.on = true;
        else if (alt > 190) this.on = false; // hysteresis
        const active = this.on && dayF > 0.05;
        this.strength += ((active ? 1 : 0) - this.strength) * Math.min(1, dt * 3);
        this.light.shadow.intensity = this.strength;
        const hz = this.hz,
            tex = this.tex;
        if (active) {
            this.right.crossVectors(sun, Math.abs(sun.y) < 0.9 ? Y : X).normalize();
            this.up.crossVectors(this.right, sun);
            this.tgt
                .copy(cam)
                .addScaledVector(this.right, -(cam.dot(this.right) % tex))
                .addScaledVector(this.up, -(cam.dot(this.up) % tex));
            this.light.target.position.copy(this.tgt);
            this.light.position.copy(this.tgt).addScaledVector(sun, 300);
        }
        if (this.moon) {
            if (alt < 150) this.moonOn = true;
            else if (alt > 190) this.moonOn = false;
            const moonActive = this.moonOn && dayF < 0.95;
            const moonF = (1 - dayF) * (moonActive ? 1 : 0);
            this.moonStrength += (moonF - this.moonStrength) * Math.min(1, dt * 3);
            this.moon.shadow.intensity = this.moonStrength;
            if (moonActive && this.moonStrength > 0.01) {
                this.moonDir.copy(sun).negate();
                this.right.crossVectors(this.moonDir, Math.abs(this.moonDir.y) < 0.9 ? Y : X).normalize();
                this.up.crossVectors(this.right, this.moonDir);
                const mt = this.moonTex;
                this.tgt
                    .copy(cam)
                    .addScaledVector(this.right, -(cam.dot(this.right) % mt))
                    .addScaledVector(this.up, -(cam.dot(this.up) % mt));
                this.moon.target.position.copy(this.tgt);
                this.moon.position.copy(this.tgt).addScaledVector(this.moonDir, 300);
            }
        }
        if ((this.timer += dt) > 1 / hz) {
            this.timer = 0;
            // each light's depth pass runs only while its shadow is visible; the moon's used to be gated by
            // toggling castShadow, which recompiled every lit material at dusk/dawn (frame hitch)
            const sunOn = this.strength > 0.005,
                moonOn = !!this.moon && this.moonStrength > 0.005;
            this.light.shadow.needsUpdate = sunOn;
            if (this.moon) this.moon.shadow.needsUpdate = moonOn;
            if (sunOn || moonOn) this.renderer.shadowMap.needsUpdate = true;
        }
    }
}
