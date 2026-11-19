/**
 * world/precip.ts — GPU rain and snow particle system
 *
 * Purpose:
 *   A THREE.Points cloud whose motion is computed entirely in the vertex shader. Seeds fall and wrap inside a
 *   camera-anchored box, so the CPU only uploads a few uniforms per frame.
 *
 * Operations:
 *   - Precip(N): builds N points with random per-point seeds (attribute `sd`) and the shader material
 *   - Precip.pts / Precip.mat: the Points object (added to the scene by Sky) and its ShaderMaterial
 *   - Precip.update(cam, up, snow, amt, alt): sets camera basis (right/up/forward), rain vs snow mode, colour and
 *     opacity; hides the points when effectively invisible
 *
 * Usage:
 *   Created by Sky (sky.ts) with a tier-scaled count; Sky.update() calls update() every frame.
 *
 * Important:
 *   - Opacity fades to zero between 50 and 80 m altitude, and pts.visible is false below a ~0.02 amount.
 *   - frustumCulled is false because the geometry positions are all zero; the box is built in the shader.
 *   - Time comes from the shared U.uTime uniform; rain colour tracks CurrentPalette.rain, snow is white.
 */
import * as THREE from "three";
import { U } from "../render/fx";
import { CurrentPalette } from "../core/palette";
const FW = new THREE.Vector3(),
    RR = new THREE.Vector3();
export class Precip {
    pts: THREE.Points;
    mat: THREE.ShaderMaterial;
    constructor(N: number) {
        const sd = new Float32Array(N * 3);
        for (let i = 0; i < sd.length; i++) sd[i] = Math.random();
        const g = new THREE.BufferGeometry()
            .setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3))
            .setAttribute("sd", new THREE.BufferAttribute(sd, 3));
        this.mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            uniforms: {
                uT: U.uTime,
                uCam: { value: new THREE.Vector3() },
                uRt: { value: new THREE.Vector3() },
                uUp: { value: new THREE.Vector3() },
                uF2: { value: new THREE.Vector3() },
                uSnow: { value: 0 },
                uAmt: { value: 0 },
                uCol: { value: new THREE.Color(CurrentPalette.rain) },
            },
            vertexShader: `
attribute vec3 sd;
uniform float uT, uSnow;
uniform vec3 uCam, uRt, uUp, uF2;
void main() {
  float spd = uSnow > .5 ? 3. : 38.;
  vec3 L = vec3((sd.x - .5) * 50., mod(sd.y * 36. - uT * spd, 36.) - 8., (sd.z - .5) * 50.);
  if (uSnow > .5) L.x += sin(L.y * .7 + sd.y * 100.) * .8;
  vec4 mv = viewMatrix * vec4(uCam + uRt * L.x + uUp * L.y + uF2 * L.z, 1.);
  gl_PointSize = min((uSnow > .5 ? 220. : 160.) / -mv.z, 48.);
  gl_Position = projectionMatrix * mv;
}`,
            fragmentShader: `
uniform vec3 uCol;
uniform float uAmt;
void main() {
  float d = length(gl_PointCoord - .5);
  gl_FragColor = vec4(uCol, smoothstep(.5, .1, d) * uAmt * .7);
}`,
        });
        this.pts = new THREE.Points(g, this.mat);
        this.pts.frustumCulled = false;
    }
    update(cam: THREE.Camera, up: THREE.Vector3, snow: boolean, amt: number, alt: number) {
        const k = Math.min(1, Math.max(0, (alt - 50) / 30)),
            a2 = amt * (1 - k * k * (3 - 2 * k));
        this.pts.visible = a2 > 0.02;
        if (!this.pts.visible) return;
        const u = this.mat.uniforms,
            fw = cam.getWorldDirection(FW),
            r = RR.crossVectors(fw, up);
        if (r.lengthSq() < 1e-6) r.set(1, 0, 0);
        r.normalize();
        u.uCam.value.copy(cam.position);
        u.uRt.value.copy(r);
        u.uUp.value.copy(up);
        u.uF2.value.crossVectors(up, r);
        u.uSnow.value = snow ? 1 : 0;
        u.uAmt.value = a2;
        u.uCol.value.set(snow ? 0xffffff : CurrentPalette.rain);
    }
}
