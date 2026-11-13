import * as THREE from "three";
import { wind, U, IGN, TINT_GLSL } from "./fx";
import { S, CFG } from "../core/config";
import { T as TU } from "./terrain";

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
    // per-leaf flutter (fx.ts wind): detailed tier only — the only tier whose geometry has polygonal leaf blades.
    // Palm frond bob: detailed and medium (both tiers build fronds with the sway bands).
    // Canopy rustle: detailed and medium. The low-poly far tier has no wind at all (never close enough to see sway).
    if (tier === 0) (m as any).defines = { LEAF_FLUTTER: "", FROND_SWAY: "", CANOPY_SWAY: "" };
    else if (tier === 1) (m as any).defines = { FROND_SWAY: "", CANOPY_SWAY: "" };
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
        s.uniforms.uSnowFall = U.uSnowFall;
        s.uniforms.uAmp = TU.uAmp;
        s.uniforms.uR = TU.uR;
        s.uniforms.uCw = TU.uCw;
        s.vertexShader = s.vertexShader
            .replace(
                "#include <common>",
                "#include <common>\nvarying float vLd;varying vec3 vWt;uniform vec4 uLod;attribute float aLeaf;"
            )
            .replace(
                "#include <color_vertex>",
                `#include <color_vertex>
vColor.rgb=color*mix(vec3(1.),instanceColor,min(aLeaf,1.));
// Canopy shade variety (foliage only, all tiers): one tree colour per crown read as a flat solid, so vary it across the
// crown. Per-tree seed from the instance position, so neighbours differ. Multiplies the per-tree hue (autumn, blossom,
// drought still come through). Model-space position / normal: same pattern whichever way the tree is planted.
if (aLeaf > .5) {
  vec3  ip  = instanceMatrix[3].xyz * .37;
  vec3  q   = position * .55 + ip;
  // smooth 3-D patches (sum of sines: no texture, no noise library in this shader)
  float pa  = sin(q.x * 1.3 + sin(q.y * 1.7 + ip.z)) * sin(q.z * 1.1 + sin(q.x * .9 + ip.y));
  float pb  = sin(q.y * 2.1 + q.z * .8 + ip.x) * .5 + .5;
  // 1) hue / lightness patches: yellow-green ↔ blue-green, lighter ↔ darker
  vec3  tint = mix(vec3(1.06, 1.04, .86), vec3(.9, 1., 1.1), pb);
  vColor.rgb *= tint * (.86 + .22 * (pa * .5 + .5));
  // 2) sunlit top, shaded core: up-facing foliage lighter + warmer; foliage near the trunk axis darker (crown depth)
  float up   = clamp(normal.y * .5 + .5, 0., 1.);
  float core = 1. - smoothstep(.4, 2.2, length(position.xz));
  vColor.rgb *= mix(vec3(.8, .84, .86), vec3(1.08, 1.06, .96), up) * (1. - core * .22);
  // 3) fresh growth on the outer, upper tips: a lighter, slightly yellower green
  float tip  = smoothstep(.55, .95, up) * smoothstep(1.2, 3., length(position.xz)) * (pa * .5 + .5);
  vColor.rgb  = mix(vColor.rgb, vColor.rgb * vec3(1.14, 1.16, .92), tip * .6);
}`
            )
            .replace(
                "#include <project_vertex>",
                "#include <project_vertex>\nvWt=(modelMatrix*instanceMatrix*vec4(transformed,1.)).xyz;vLd=length(vWt-cameraPosition);" +
                    cull
            );
        s.fragmentShader = s.fragmentShader
            .replace(
                "#include <common>",
                "#include <common>\nvarying float vLd;varying vec3 vWt;uniform vec4 uLod;uniform vec3 uSun,uCw;uniform float uDayF,uSnow,uSnowFall,uAmp,uR;" +
                    IGN
            )
            .replace(
                "#include <color_fragment>",
                `#include <color_fragment>\nfloat lodA=smoothstep(uLod.x,uLod.y,vLd),lodB=smoothstep(uLod.z,uLod.w,vLd),lodN=ign(gl_FragCoord.xy);${keep}`
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
  float sn  = 1. - smoothstep(uSnow + uSnowFall * .28 - .02, uSnow + uSnowFall * .28 + .16, tt);
  float upf = smoothstep(.15, .7, dot(normal, (viewMatrix * vec4(nw, 0.)).xyz));
  diffuseColor.rgb = mix(diffuseColor.rgb, uCw * .95, sn * upf * .85);
}
` + TINT_GLSL
            );
    };
    return m;
}
export const treeMats = [0, 1, 2].map(treeMat);
