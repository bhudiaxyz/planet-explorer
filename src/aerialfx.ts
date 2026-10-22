import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { U } from "./fx";

export class AerialPass {
  pass: ShaderPass;
  constructor(depthTexture: THREE.DepthTexture) {
    this.pass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        tDepth:   { value: depthTexture },
        uNear:    { value: 1.0 },
        uFar:     { value: 20000.0 },
        uSun:     U.uSun,
        uDayF:    U.uDayF,
      },
      vertexShader: `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
      fragmentShader: `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform float     uNear, uFar, uDayF;
uniform vec3      uSun;
varying vec2      vUv;
void main() {
  float d      = texture2D(tDepth, vUv).r;
  float z      = (2.0 * uNear * uFar) / (uFar + uNear - d * (uFar - uNear));
  float fog    = 1.0 - exp(-z * 0.000012);
  vec3  day    = mix(vec3(0.72, 0.78, 0.88), vec3(0.85, 0.70, 0.52), uDayF);
  vec3  night  = vec3(0.05, 0.06, 0.12);
  vec3  haze   = mix(night, day, uDayF);
  vec4  col    = texture2D(tDiffuse, vUv);
  gl_FragColor = vec4(mix(col.rgb, haze, fog * 0.65), col.a);
}`,
    });
  }
  setCamera(near: number, far: number) {
    this.pass.uniforms.uNear.value = near;
    this.pass.uniforms.uFar.value  = far;
  }
}
