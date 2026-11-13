import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { S } from "../core/config";
import { gpuTier, isTouchDevice } from "./gputier";
import { AerialPass } from "./aerialfx";

/**
 * Post-processing chain (HDR scene render → NaN/Inf sanitiser → aerial haze → half-res bloom → tone-map/output) plus adaptive resolution.
 * The sanitiser exists because one NaN/Inf pixel in a float target is smeared by bloom's blur into a black frame.
 * Resolution changes are applied right before drawing (changing canvas size clears it, which would flash a blank frame if done after).
 *
 * The scene renders into its own target (MSAA + depth texture); the sanitiser reads it and writes into the composer's ping-pong
 * buffers, which are plain (no MSAA, no depth). Previously the composer cloned the MSAA+depth target for both buffers, so every
 * post pass paid for multisampled writes, and the aerial pass read a depth texture that the fullscreen passes overwrote on
 * alternate frames (haze flickered on/off each frame on medium/high).
 */
class ScenePass extends Pass {
    private quad: FullScreenQuad;
    constructor(
        private scene: THREE.Scene,
        private camera: THREE.Camera,
        readonly target: THREE.WebGLRenderTarget,
        material: THREE.ShaderMaterial
    ) {
        super();
        this.quad = new FullScreenQuad(material);
        material.uniforms.tDiffuse.value = target.texture;
    }
    setSize(w: number, h: number) {
        // the composer hands passes unrounded width×ratio (e.g. 281.25); floor like WebGL does for its own buffers
        this.target.setSize(Math.floor(w), Math.floor(h));
    }
    render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget) {
        renderer.setRenderTarget(this.target);
        renderer.clear();
        renderer.render(this.scene, this.camera);
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this.quad.render(renderer);
    }
}

export class PostFX {
    readonly composer: EffectComposer;
    readonly bloom: UnrealBloomPass;
    readonly aerial: AerialPass;
    private pixelRatio: number;
    private pendingPixelRatio: number;
    private devicePixelRatio: number;
    private smoothedFrameTime = 0.016;
    private timeSinceLastScaleChange = -2; // negative = start-up grace
    // frame-cap detection: smoothed frame time when the last downscale was applied, and how many downscales in a row
    // failed to make frames faster (a 30 Hz-capped device, e.g. iOS Low Power Mode, is not GPU-bound)
    private frameAtDownscale = 0;
    private uselessDownscales = 0;
    private floor = 0.5;
    private camera: THREE.Camera;
    private sz = new THREE.Vector2();
    constructor(
        private renderer: THREE.WebGLRenderer,
        scene: THREE.Scene,
        camera: THREE.Camera
    ) {
        const pr = renderer.getPixelRatio(),
            w = Math.round(innerWidth * pr),
            h = Math.round(innerHeight * pr);
        const rt = new THREE.WebGLRenderTarget(w, h, {
            type: THREE.HalfFloatType,
            samples: gpuTier === "low" ? 0 : gpuTier === "medium" ? 2 : 4,
        });
        rt.depthTexture = new THREE.DepthTexture(w, h);
        rt.depthTexture.format = THREE.DepthFormat;
        rt.depthTexture.type = THREE.FloatType;
        this.composer = new EffectComposer(
            renderer,
            new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false })
        );
        // allocate bloom at half the real render size; only added to the composer on medium/high to avoid
        // committing ~2.5 MB of HalfFloat RTs on low-tier devices where it's never rendered.
        this.bloom = new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.45, 0.5, 0.75);
        const clean = new THREE.ShaderMaterial({
            uniforms: { tDiffuse: { value: null } },
            depthTest: false,
            depthWrite: false,
            vertexShader: `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}`,
            fragmentShader: `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  // bit test instead of isnan/isinf: ANGLE's D3D compiler (Windows) assumes no NaNs and may strip
  // isnan() (warning X3577). All-ones exponent = NaN or Inf.
  uvec4 e = floatBitsToUint(c) & 0x7f800000u;
  if (any(equal(e, uvec4(0x7f800000u)))) c = vec4(0., 0., 0., 1.);
  gl_FragColor = vec4(clamp(c.rgb, 0., 32.), 1.);
}`,
        });
        // mist: medium+ (one extra matrix multiply, only at dawn/dusk). AO + sun shafts: high desktop only (8 + 12 depth taps
        // per pixel — fine on a discrete GPU, too much fill-rate for a phone or tablet).
        const highDesk = gpuTier === "high" && !isTouchDevice;
        this.aerial = new AerialPass(rt.depthTexture!, { mist: gpuTier !== "low", ao: highDesk, shafts: highDesk });
        this.camera = camera;
        this.composer.addPass(new ScenePass(scene, camera, rt, clean));
        // P2: aerial haze pass skipped on low tier — full-screen depth read + exp() wastes fill-rate
        // on Mali/Adreno 3xx for ~8% max haze that's barely visible at low resolution.
        if (gpuTier !== "low") this.composer.addPass(this.aerial.pass);
        // P1: bloom pass only added when it will be used; avoids allocating its 5 HalfFloat RTs on low tier.
        if (gpuTier !== "low") this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
        this.pixelRatio = this.pendingPixelRatio = pr;
        this.devicePixelRatio = devicePixelRatio;
        // EffectComposer takes its logical size from the target it is given (here already in device pixels) and multiplies by
        // its own pixel ratio on every setSize — so the first scale change would scale twice (canvas 600 px → targets 450 px).
        // Re-state the contract explicitly: CSS size + pixel ratio, which also sizes every pass (scene target, bloom).
        this.composer.setPixelRatio(pr);
        this.composer.setSize(innerWidth, innerHeight);
    }
    /** Ask for a new pixel ratio (applied at the start of the next render). */
    requestScale(scale: number) {
        this.pendingPixelRatio = scale;
    }
    resize() {
        this.devicePixelRatio = devicePixelRatio;
        // moved to a lower-DPR screen: drop to the new cap now (the adaptive loop handles raising it)
        this.pendingPixelRatio = Math.min(this.pendingPixelRatio, devicePixelRatio, S.renderScale);
        this.renderer.setSize(innerWidth, innerHeight);
        this.composer.setSize(innerWidth, innerHeight);
    }
    render(dt: number) {
        if (this.pendingPixelRatio !== this.pixelRatio) {
            this.pixelRatio = this.pendingPixelRatio;
            this.timeSinceLastScaleChange = 0;
            this.bloom.enabled = gpuTier !== "low";
            this.renderer.setPixelRatio(this.pixelRatio);
            // P3: setPixelRatio already triggers internal setSize on all passes — the explicit call is redundant.
            this.composer.setPixelRatio(this.pixelRatio);
        }
        if (gpuTier !== "low") {
            this.renderer.getDrawingBufferSize(this.sz);
            this.aerial.update(this.camera, this.sz.x, this.sz.y);
        }
        this.composer.render();
        this.smoothedFrameTime += (dt - this.smoothedFrameTime) * 0.08;
        this.timeSinceLastScaleChange += dt;
        const cap = Math.min(this.devicePixelRatio, S.renderScale);
        // downscale reacts quickly (0.5 s) to catch sudden load spikes (e.g. descent into terrain)
        if (this.timeSinceLastScaleChange > 0.5 && this.smoothedFrameTime > 0.03 && this.pixelRatio > this.floor) {
            // Did the previous downscale help? If frames are no faster (within 8%), resolution isn't the bottleneck —
            // usually a 30 Hz cap (iOS Low Power Mode, Android battery saver) or CPU load. Two misses in a row: stop
            // here instead of sinking to 0.5 for no gain. The floor resets when frames recover (below).
            if (this.frameAtDownscale && this.smoothedFrameTime > this.frameAtDownscale * 0.92) {
                if (++this.uselessDownscales >= 2) {
                    this.floor = Math.min(cap, this.pixelRatio + 0.15);
                    this.pendingPixelRatio = this.floor; // undo the last useless step
                    this.frameAtDownscale = 0;
                    return;
                }
            } else this.uselessDownscales = 0;
            this.frameAtDownscale = this.smoothedFrameTime;
            this.pendingPixelRatio = Math.max(this.floor, this.pixelRatio - 0.15);
        }
        // upscale is cautious (3 s) to avoid oscillation on borderline hardware
        else if (this.timeSinceLastScaleChange > 3 && this.smoothedFrameTime < 0.0185 && this.pixelRatio < cap) {
            this.floor = 0.5; // frames are fast again: whatever capped them is gone
            this.uselessDownscales = 0;
            this.frameAtDownscale = 0;
            this.pendingPixelRatio = Math.min(cap, this.pixelRatio + 0.1);
        }
    }
}
