import * as THREE from "three";
import type { Noise3 } from "./noise";
// Shared terrain-function uniforms. The permutation tables of the CPU noise are uploaded as a 512×2 float texture,
// so the GLSL height field is the same function the CPU samples for physics, trees and placement.
const tex = new THREE.DataTexture(
  new Float32Array(1024),
  512,
  2,
  THREE.RedFormat,
  THREE.FloatType,
);
tex.minFilter = tex.magFilter = THREE.NearestFilter;
tex.needsUpdate = true;
const C = () => ({ value: new THREE.Color() });
export const T = {
  uPerm: { value: tex },
  uFreq: { value: 1.6 },
  uOct: { value: 6 },
  uLac: { value: 2 },
  uPer: { value: 0.5 },
  uMtn: { value: 0.8 },
  uSea: { value: 0.05 },
  uAmp: { value: 70 },
  uSnow: { value: 0.3 },
  uR: { value: 700 },
  uCs: C(),
  uCg: C(),
  uCf: C(),
  uCr: C(),
  uCw: C(),
};
export function syncTerrain(S: any, n: Noise3, n2: Noise3) {
  const a = tex.image.data as Float32Array;
  a.set(n.p, 0);
  a.set(n2.p, 512);
  tex.needsUpdate = true;
  T.uFreq.value = S.frequency;
  T.uOct.value = S.octaves;
  T.uLac.value = S.lacunarity;
  T.uPer.value = S.persistence;
  T.uMtn.value = S.mountains;
  T.uSea.value = S.seaLevel;
  T.uAmp.value = S.amplitude;
  T.uSnow.value = S.snowline;
  T.uR.value = S.radius;
  T.uCs.value.set(S.colors.sand);
  T.uCg.value.set(S.colors.grass);
  T.uCf.value.set(S.colors.forest);
  T.uCr.value.set(S.colors.rock);
  T.uCw.value.set(S.colors.snow);
}
export const TERRAIN_GLSL = `uniform sampler2D uPerm;uniform float uFreq,uOct,uLac,uPer,uMtn,uSea,uAmp,uSnow,uR;uniform vec3 uCs,uCg,uCf,uCr,uCw;
int pi_(int i,int r){return int(texelFetch(uPerm,ivec2(i,r),0).r+.5);}
float gr(int h,vec3 f){h&=15;float u=h<8?f.x:f.y,v=h<4?f.y:((h==12||h==14)?f.x:f.z);return((h&1)==0?u:-u)+((h&2)==0?v:-v);}
float pn(vec3 q,int r){vec3 F=floor(q);ivec3 I=ivec3(F)&ivec3(255);vec3 f=q-F,w=f*f*f*(f*(f*6.-15.)+10.);
int A=pi_(I.x,r)+I.y,AA=pi_(A,r)+I.z,AB=pi_(A+1,r)+I.z,B=pi_(I.x+1,r)+I.y,BA=pi_(B,r)+I.z,BB=pi_(B+1,r)+I.z;
return mix(mix(mix(gr(pi_(AA,r),f),gr(pi_(BA,r),f-vec3(1,0,0)),w.x),mix(gr(pi_(AB,r),f-vec3(0,1,0)),gr(pi_(BB,r),f-vec3(1,1,0)),w.x),w.y),
mix(mix(gr(pi_(AA+1,r),f-vec3(0,0,1)),gr(pi_(BA+1,r),f-vec3(1,0,1)),w.x),mix(gr(pi_(AB+1,r),f-vec3(0,1,1)),gr(pi_(BB+1,r),f-vec3(1,1,1)),w.x),w.y),w.z);}
float fb(vec3 p,int oct,float lac,float per,int r){float s=0.,a=1.,f=1.,n=0.;for(int i=0;i<8;i++){if(i>=oct)break;s+=a*pn(p*f,r);n+=a;a*=per;f*=lac;}return s/n;}
float sm_(float a,float b,float x){float t=clamp((x-a)/(b-a),0.,1.);return t*t*(3.-2.*t);}
float e3(vec3 d,bool fine){float f=uFreq,q=f*.8;int o=int(uOct);
vec3 W=d+.25*vec3(pn(vec3(d.x*q+11.,d.y*q,d.z*q),1),pn(vec3(d.x*q,d.y*q+17.,d.z*q),1),pn(vec3(d.x*q,d.y*q,d.z*q+23.),1));
float b=fb(W*f,fine?o:min(o,5),uLac,uPer,0),hills=pn(W*f*3.1+vec3(9.,0.,0.),0)*.06,mask=sm_(-.1,.35,pn(W*f*.6+vec3(7.,0.,0.),1));
float r=max(0.,1.-abs(fb(W*f*1.5,min(o,5),uLac,uPer,1)*2.));
float e=b*1.1+hills+uMtn*mask*(r*r*.8+(fine?r*.06*pn(d*f*25.,0):0.))-uSea;
if(fine)e+=pn(d*f*18.,0)*.014*(1.+mask)+pn(d*f*60.,0)*.004;
if(fine&&e>0.&&e<.09)e+=pn(d*f*35.+vec3(5.,0.,0.),0)*.008*(1.-sm_(.02,.09,e));
return e<0.?e*.5:e;}
float hs(float a,float b,float c){vec3 q=fract(vec3(a,b,c)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
void basis(float c,out vec3 n,out vec3 u,out vec3 v){int fc=int(c+.5);n=vec3(0.);n[fc/2]=(fc%2==0)?1.:-1.;u=(fc/2==1)?vec3(1.,0.,0.):vec3(0.,1.,0.);v=cross(n,u);}
// ---- vegetation density fields, shared by tree placement (bake mode 1) and plant placement (decide) so the understory follows the forests
float forestMask(vec3 d,float m){return sm_(-.05,.22,pn(d*uFreq*5.+vec3(50.,0.,0.),1))*sm_(-.12,.2,m);}      // big forests, ~90-150 m across
float groveMask(vec3 d){return .25+.75*sm_(-.1,.3,pn(d*uFreq*18.+vec3(0.,91.,0.),1));}                      // stands and glades inside them, ~25 m
float treeDensity(vec3 d,float m){return forestMask(d,m)*groveMask(d);}
float clusterField(vec3 d,float k){float a=pn(d*uFreq*9.+vec3(63.+k*7.,0.,k*13.),1),b=pn(d*uFreq*24.+vec3(0.,17.+k*5.,k*11.),1);return sm_(-.05,.22,a)*(.3+.7*sm_(-.15,.3,b));}   // patches ~50 m of clumps ~18 m
`;
// Biome colour. Coast: wide noise-broken beach on gentle slopes (cliffs stay rock), pale dry upper sand, dark wet sand at the waterline, ripple banding,
// bright shallows deepening to dark seabed. Highlands: tundra → frost → deep snow starting lower, snow clinging to slopes, blue glacial ice on high flat ground.
export const BIOME_GLSL = `vec3 biome(vec3 d,float e,float m,vec3 n){float slope=1.-dot(n,d),nz=pn(d*60.,1),v1=pn(d*5.+vec3(21.,0.,0.),1),v2=pn(d*13.+vec3(0.,31.,0.),1),v3=pn(d*3.+vec3(0.,0.,47.),1);vec3 c;
if(e<0.)c=uCs*(.4+.45*sm_(-.12,0.,e))*mix(vec3(1.),vec3(.8,.95,1.05),sm_(.3,.7,v2)*.6);
else{c=mix(uCg,uCf,sm_(-.05,.2,m));
c*=mix(vec3(1.),vec3(1.2,1.08,.72),sm_(.25,.65,v1)*.65);
c*=mix(vec3(1.),vec3(.8,1.02,.92),sm_(.3,.7,v2)*.45);
c=mix(c,c*vec3(1.35,.95,1.1)+vec3(.04,0.,.05),sm_(.62,.8,v3)*.35*(1.-sm_(.2,.4,e)));
float beach=(1.-sm_(.02,.075+.025*nz,e))*(1.-sm_(.18,.4,slope));vec3 sand=uCs*mix(vec3(1.),vec3(1.12,.9,.82),sm_(.35,.7,v2)*.55);
c=mix(c,sand,beach);c=mix(c,c*1.1+vec3(.02),beach*sm_(.03,.075,e));c*=1.-.3*beach*(1.-sm_(0.,.035,e));c*=1.-.07*beach*(.5+.5*sin(e*uAmp*14.+pn(d*80.,1)*3.));
float tt=1.-1.1*d.y*d.y-1.2*max(e,0.)+.08*pn(d*9.+vec3(3.,0.,0.),1);
float rock=max(sm_(.2,.4,slope),sm_(.55,.8,e));vec3 rk=mix(uCr,mix(vec3(.46,.33,.25),vec3(.3,.36,.46),sm_(.3,.7,v1)),.55);c=mix(c,rk,rock);c=mix(c,vec3(.235,.22,.2),rock*.4*(sin(e*uAmp*.9+nz*5.)*.5+.5));
c=mix(c,c*.8+vec3(.07,.07,.05),sm_(uSnow+.4,uSnow+.2,tt)*(1.-rock));
c=mix(c,vec3(.78,.88,.94),sm_(uSnow+.24,uSnow+.1,tt)*.45);
float snow=sm_(uSnow+.16,uSnow-.02,tt)*(1.-sm_(.3,.6,slope)*.45);c=mix(c,uCw,snow);
float ice=sm_(.42,.7,e)*(1.-sm_(.12,.3,slope))*snow*(.6+.4*nz);c=mix(c,vec3(.55,.74,.88),ice*.65);}
return c*(.92+.16*nz);}`;
