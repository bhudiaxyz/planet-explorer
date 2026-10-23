import * as THREE from "three";
import { smoothstep } from "./utilgeo";
import { S } from "./settings";
import type { Planet } from "./planet";

/** CPU mirror of the GPU treeDensity() — forestMask × groveMask × moisture.
 *  Returns 0–1; > 0 means trees can grow here. */
export function treeDensityCPU(planet: Planet, d: THREE.Vector3, moisture: number): number {
  const f = S.frequency, n = (planet as any).noise2;
  return (
    smoothstep(-0.05, 0.22, n.get(d.x * f * 5 + 50, d.y * f * 5, d.z * f * 5)) *
    smoothstep(-0.12, 0.2, moisture) *
    (0.25 + 0.75 * smoothstep(-0.1, 0.3, n.get(d.x * f * 18, d.y * f * 18 + 91, d.z * f * 18)))
  );
}
