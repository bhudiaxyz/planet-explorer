import * as THREE from "three";
import { U } from "./fx";
const V = THREE.Vector3,
  N = 3500,
  FW = new V(),
  RR = new V();
// Rain/snow computed entirely in the vertex shader: seeds fall and wrap inside a camera-anchored box; the CPU only uploads a few uniforms.
export class Precip {
  pts: THREE.Points;
  mat: THREE.ShaderMaterial;
  constructor() {
    const sd = new Float32Array(N * 3);
    for (let i = 0; i < sd.length; i++) sd[i] = Math.random();
    const g = new THREE.BufferGeometry()
      .setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(N * 3), 3),
      )
      .setAttribute("sd", new THREE.BufferAttribute(sd, 3));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uT: U.uTime,
        uCam: { value: new V() },
        uRt: { value: new V() },
        uUp: { value: new V() },
        uF2: { value: new V() },
        uSnow: { value: 0 },
        uAmt: { value: 0 },
        uCol: { value: new THREE.Color(0xaabbd0) },
      },
      vertexShader: `attribute vec3 sd;uniform float uT,uSnow;uniform vec3 uCam,uRt,uUp,uF2;
void main(){float spd=uSnow>.5?3.:38.;vec3 L=vec3((sd.x-.5)*50.,mod(sd.y*36.-uT*spd,36.)-8.,(sd.z-.5)*50.);if(uSnow>.5)L.x+=sin(L.y*.7+sd.y*100.)*.8;
vec4 mv=viewMatrix*vec4(uCam+uRt*L.x+uUp*L.y+uF2*L.z,1.);gl_PointSize=min((uSnow>.5?220.:160.)/-mv.z,48.);gl_Position=projectionMatrix*mv;}`,
      fragmentShader:
        "uniform vec3 uCol;uniform float uAmt;void main(){float d=length(gl_PointCoord-.5);gl_FragColor=vec4(uCol,smoothstep(.5,.1,d)*uAmt*.7);}",
    });
    this.pts = new THREE.Points(g, this.mat);
    this.pts.frustumCulled = false;
  }
  update(
    cam: THREE.Camera,
    up: THREE.Vector3,
    snow: boolean,
    amt: number,
    alt: number,
  ) {
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
    u.uCol.value.set(snow ? 0xffffff : 0xaabbd0);
  }
}
