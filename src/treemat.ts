import * as THREE from "three";
import { wind, U, IGN, TINT_GLSL } from "./fx";
import { S, CFG } from "./config";
import { T as TU } from "./gpu";

// Three tree tiers (0 detailed · 1 medium · 2 low-poly) cross-fade with strictly complementary screen-door dither over uLod = (H0,H1,M0,M1) metres:
// tier0 keeps noise ≥ a, tier1 keeps b ≤ noise < a, tier2 keeps noise < b  (a = smoothstep(H0,H1,d) ≥ b = smoothstep(M0,M1,d)) → no holes, no double coverage, no pops.
// Foliage vertices carry aLeaf = 1 and a NEUTRAL shaded colour; the per-tree hue comes from instanceColor (autumn, blossom, drought, species…). Trunks (aLeaf = 0) ignore it.
// The low-poly tier has no wind (it is never close enough to see sway), which removes the sin/cos work from ~1 M vertices per frame.
function treeMat(tier: number) {
  const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
    }),
    m = tier === 2 ? mat : wind(mat, CFG.trees.windFactor * S.windSway),
    base = tier === 2 ? null : (m.onBeforeCompile as any);
  const keep =
    tier === 0
      ? "if(lodN<lodA)discard;"
      : tier === 1
        ? "if(lodN>=lodA||lodN<lodB)discard;"
        : "if(lodN>=lodB)discard;";
  const cull =
    tier === 2
      ? `vec3  wpL = (modelMatrix * instanceMatrix * vec4(transformed, 1.)).xyz;
float crL = length(cameraPosition);
if (vLd < uLod.z - 20. || dot(normalize(wpL), cameraPosition / crL) < length(wpL) / crL - .06)
  gl_Position = vec4(2., 2., 2., 1.);`
      : "";
  m.customProgramCacheKey = () => "tree" + tier;
  m.onBeforeCompile = (s: any, r: any) => {
    if (base) base(s, r);
    s.uniforms.uLod = U.uLod;
    s.uniforms.uSun = U.uSun;
    s.uniforms.uDayF = U.uDayF;
    s.uniforms.uSnow = TU.uSnow;
    s.uniforms.uAmp = TU.uAmp;
    s.uniforms.uR = TU.uR;
    s.uniforms.uCw = TU.uCw;
    s.vertexShader = s.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vLd;varying vec3 vWt;uniform vec4 uLod;attribute float aLeaf;",
      )
      .replace(
        "#include <color_vertex>",
        "#include <color_vertex>\nvColor.rgb=color*mix(vec3(1.),instanceColor,aLeaf);",
      )
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvWt=(modelMatrix*instanceMatrix*vec4(transformed,1.)).xyz;vLd=length(vWt-cameraPosition);" +
          cull,
      );
    s.fragmentShader = s.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vLd;varying vec3 vWt;uniform vec4 uLod;uniform vec3 uSun,uCw;uniform float uDayF,uSnow,uAmp,uR;" +
          IGN,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>\nfloat lodA=smoothstep(uLod.x,uLod.y,vLd),lodB=smoothstep(uLod.z,uLod.w,vLd),lodN=ign(gl_FragCoord.xy);${keep}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
{
  vec3  sv  = normalize((viewMatrix * vec4(uSun, 0.)).xyz);
  float tr  = pow(clamp(dot(-normalize(vViewPosition), sv), 0., 1.), 3.)
            * (1. - clamp(dot(normal, sv), 0., 1.)) * uDayF;
  totalEmissiveRadiance += diffuseColor.rgb * tr * .55;
  vec3  nw  = normalize(vWt);
  float tt  = 1. - 1.1 * nw.y * nw.y - 1.2 * max((length(vWt) - uR) / uAmp, 0.);
  float sn  = 1. - smoothstep(uSnow - .02, uSnow + .16, tt);
  float upf = smoothstep(.15, .7, dot(normal, (viewMatrix * vec4(nw, 0.)).xyz));
  diffuseColor.rgb = mix(diffuseColor.rgb, uCw * .95, sn * upf * .85);
}
` + TINT_GLSL,
      );
  };
  return m;
}
export const treeMats = [0, 1, 2].map(treeMat);
