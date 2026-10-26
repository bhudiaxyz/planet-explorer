import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { S } from "./config";
import { gpuTier } from "./gputier";
import { AerialPass } from "./aerialfx";

/**
 * Post-processing chain (HDR render → NaN/Inf sanitiser → half-res bloom → tone-map/output) plus adaptive resolution.
 * The sanitiser exists because one NaN/Inf pixel in a float target is smeared by bloom's blur into a black frame.
 * Resolution changes are applied right before drawing (changing canvas size clears it, which would flash a blank frame if done after).
 */
export class PostFX {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly aerial: AerialPass;
  private pixelRatio: number;
  private pendingPixelRatio: number;
  private devicePixelRatio: number;
  private smoothedFrameTime = 0.016;
  private timeSinceLastScaleChange = -2; // negative = start-up grace
  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera
  ) {
    const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
      type: THREE.HalfFloatType,
      samples: gpuTier === "low" ? 0 : gpuTier === "medium" ? 2 : 4,
    });
    rt.depthTexture = new THREE.DepthTexture(innerWidth, innerHeight);
    rt.depthTexture.format = THREE.DepthFormat;
    rt.depthTexture.type = THREE.FloatType;
    this.composer = new EffectComposer(renderer, rt);
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(innerWidth / 2, innerHeight / 2),
      gpuTier === "low" ? 0.3 : 0.45,
      gpuTier === "low" ? 0.35 : 0.5,
      0.75
    );
    const clean = new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
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
  if (any(isnan(c)) || any(isinf(c))) c = vec4(0., 0., 0., 1.);
  gl_FragColor = vec4(clamp(c.rgb, 0., 32.), 1.);
}`,
    });
    this.aerial = new AerialPass(rt.depthTexture!);
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(clean);
    this.composer.addPass(this.aerial.pass);
    this.bloom.enabled = gpuTier !== "low";
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.pixelRatio = this.pendingPixelRatio = renderer.getPixelRatio();
    this.devicePixelRatio = devicePixelRatio;
  }
  /** Ask for a new pixel ratio (applied at the start of the next render). */
  requestScale(scale: number) {
    this.pendingPixelRatio = scale;
  }
  resize() {
    this.devicePixelRatio = devicePixelRatio;
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
  }
  render(dt: number) {
    if (this.pendingPixelRatio !== this.pixelRatio) {
      this.pixelRatio = this.pendingPixelRatio;
      this.timeSinceLastScaleChange = 0;
      this.bloom.enabled = true;
      this.renderer.setPixelRatio(this.pixelRatio);
      this.composer.setPixelRatio(this.pixelRatio);
      this.composer.setSize(innerWidth, innerHeight);
    }
    this.composer.render();
    this.smoothedFrameTime += (dt - this.smoothedFrameTime) * 0.05;
    this.timeSinceLastScaleChange += dt;
    const cap = Math.min(this.devicePixelRatio, S.renderScale);
    // downscale reacts quickly (0.5 s) to catch sudden load spikes (e.g. descent into terrain)
    if (
      this.timeSinceLastScaleChange > 0.5 &&
      this.smoothedFrameTime > 0.03 &&
      this.pixelRatio > 0.5
    )
      this.pendingPixelRatio = Math.max(0.5, this.pixelRatio - 0.15);
    // upscale is cautious (3 s) to avoid oscillation on borderline hardware
    else if (
      this.timeSinceLastScaleChange > 3 &&
      this.smoothedFrameTime < 0.0185 &&
      this.pixelRatio < cap
    )
      this.pendingPixelRatio = Math.min(cap, this.pixelRatio + 0.1);
  }
}
