import * as THREE from "three";
import { T, TERRAIN_GLSL } from "./gpu";
const V = THREE.Vector3,
  N = 320,
  AF = new V(),
  AX = new V(1, 0, 0),
  AZ = new V(0, 0, 1);
const NZ =
  "float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}";
// Aurora: additive curtain shell around the camera, strongest at night near the poles.
export class Aurora {
  mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    uniforms: {
      uT: { value: 0 },
      uAmt: { value: 0 },
      uUp: { value: new V(0, 1, 0) },
      uR: { value: new V(1, 0, 0) },
      uF: { value: new V(0, 0, 1) },
    },
    vertexShader:
      "varying vec3 vD;void main(){vD=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
    fragmentShader: `uniform float uT,uAmt;uniform vec3 uUp,uR,uF;varying vec3 vD;${NZ}
void main(){float e=dot(vD,uUp);if(e<.05||uAmt<.01)discard;float az=atan(dot(vD,uR),dot(vD,uF)+1e-5);
float w=n(vec2(az*3.+uT*.05,uT*.1))*2.+n(vec2(az*9.,uT*.3)),c=pow(abs(sin(az*2.+w+uT*.15)),3.),b=smoothstep(.08,.22,e)*(1.-smoothstep(.4,.75,e)),ray=n(vec2(az*40.,e*3.-uT*.5));
float I=c*b*(.5+.7*ray)*uAmt*1.6;vec3 col=mix(vec3(.15,1.,.5),vec3(.6,.25,.9),smoothstep(.2,.6,e));gl_FragColor=vec4(col*I,I);}`,
  });
  mesh = new THREE.Mesh(new THREE.SphereGeometry(16000, 32, 16), this.mat);
  constructor(scene: THREE.Scene) {
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  update(cam: THREE.Vector3, up: THREE.Vector3, amt: number, t: number) {
    this.mesh.visible = amt > 0.01;
    if (!this.mesh.visible) return;
    this.mesh.position.copy(cam);
    const u = this.mat.uniforms,
      f = AF.crossVectors(up, Math.abs(up.x) < 0.9 ? AX : AZ).normalize();
    u.uT.value = t;
    u.uAmt.value = amt;
    u.uUp.value.copy(up);
    u.uF.value.copy(f);
    u.uR.value.crossVectors(f, up);
  }
}
// Fireflies: fully GPU. Seeds wrap in a world-anchored 80 m cube around the camera; the vertex shader samples the terrain function to hover each mote above the ground.
export class Fireflies {
  pts: THREE.Points;
  mat: THREE.ShaderMaterial;
  constructor(scene: THREE.Scene, _pl?: unknown) {
    const sd = new Float32Array(N * 4);
    for (let i = 0; i < sd.length; i++) sd[i] = Math.random();
    const g = new THREE.BufferGeometry()
      .setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(N * 3), 3),
      )
      .setAttribute("sd", new THREE.BufferAttribute(sd, 4));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        ...T,
        uT: { value: 0 },
        uAmt: { value: 0 },
        uPx: { value: 140 },
        uCam: { value: new V() },
      },
      vertexShader: `attribute vec4 sd;uniform float uT,uAmt,uPx;uniform vec3 uCam;varying float vA;${TERRAIN_GLSL}
void main(){vec3 p=uCam+(mod(sd.xyz*80.-uCam,80.)-40.)+vec3(sin(uT*.7+sd.x*30.),cos(uT*.6+sd.y*30.),sin(uT*.5+sd.z*30.))*.8;vec3 d=normalize(p);
vec3 w=d*(uR+e3(d,true)*uAmp+.4+sd.w*2.4+sin(uT*.6+sd.w*40.)*.4);float ph=.5+.5*sin(uT*2.+sd.w*6.283);
vA=ph*uAmt*(1.-smoothstep(25.,40.,distance(w,uCam)));vec4 mv=modelViewMatrix*vec4(w,1.);gl_PointSize=min(uPx*(.6+.6*ph)/-mv.z,64.);gl_Position=projectionMatrix*mv;}`,
      fragmentShader:
        "varying float vA;void main(){float d=length(gl_PointCoord-.5);gl_FragColor=vec4(.8,1.,.4,smoothstep(.5,0.,d)*vA*3.);}",
    });
    this.pts = new THREE.Points(g, this.mat);
    this.pts.frustumCulled = false;
    scene.add(this.pts);
  }
  update(_dt: number, t: number, cam: THREE.Vector3, amt: number) {
    this.mat.uniforms.uT.value = t;
    this.mat.uniforms.uAmt.value = amt;
    this.mat.uniforms.uCam.value.copy(cam);
    this.pts.visible = amt > 0.02;
  }
}
