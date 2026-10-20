import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { S } from "./settings";

/**
 * Post-processing chain (HDR render → NaN/Inf sanitiser → half-res bloom → tone-map/output) plus adaptive resolution.
 * The sanitiser exists because one NaN/Inf pixel in a float target is smeared by bloom's blur into a black frame.
 * Resolution changes are applied right before drawing (changing canvas size clears it, which would flash a blank frame if done after).
 */
export class PostFX {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  private pr: number;
  private pending: number;
  private ema = 0.016;
  private since = -2; // since: seconds since the last change (negative = start-up grace)
  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    this.composer = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
        type: THREE.HalfFloatType,
        samples: 0,
      }),
    );
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(innerWidth / 2, innerHeight / 2),
      0.45,
      0.5,
      1.0,
    );
    const clean = new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader:
        "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
      fragmentShader:
        "uniform sampler2D tDiffuse;varying vec2 vUv;void main(){vec4 c=texture2D(tDiffuse,vUv);if(any(isnan(c))||any(isinf(c)))c=vec4(0.,0.,0.,1.);gl_FragColor=vec4(clamp(c.rgb,0.,32.),1.);}",
    });
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(clean);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.pr = this.pending = renderer.getPixelRatio();
  }
  /** Ask for a new pixel ratio (applied at the start of the next render). */
  requestScale(v: number) {
    this.pending = v;
  }
  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
  }
  render(dt: number) {
    if (this.pending !== this.pr) {
      this.pr = this.pending;
      this.since = 0;
      this.bloom.enabled = this.pr > 0.8;
      this.renderer.setPixelRatio(this.pr);
      this.composer.setPixelRatio(this.pr);
      this.composer.setSize(innerWidth, innerHeight);
    }
    this.composer.render();
    this.ema += (dt - this.ema) * 0.05;
    this.since += dt; // smoothed frame time drives the adaptive scale
    if (this.since > 3) {
      const cap = Math.min(devicePixelRatio, S.renderScale);
      if (this.ema > 0.03 && this.pr > 0.5)
        this.pending = Math.max(0.5, this.pr - 0.15);
      else if (this.ema < 0.0185 && this.pr < cap)
        this.pending = Math.min(cap, this.pr + 0.1);
    }
  }
}
