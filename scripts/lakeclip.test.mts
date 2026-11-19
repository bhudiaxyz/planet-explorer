/**
 * scripts/lakeclip.test.mts — river-into-lake clip self-check.
 *
 * Purpose:
 *   Verifies clipAtLakes (world/geoutil.ts) truncates a river path where the ground dips below a lake surface and
 *   ends it with points sitting just above the water.
 *
 * Operations:
 *   - Builds a 40-point river along the equator of a 500 m planet with a basin at 200 m holding a lake.
 *   - Asserts: clipped length, untouched prefix, tail sits at lake.level + 0.05, nothing below the surface.
 *   - Asserts: a path short of the lake is unchanged, and an empty lake list returns the same path object.
 *
 * Usage:
 *   npm run test:lakeclip  (node --experimental-strip-types). Prints "lakeclip ok"; throws on failure.
 *
 * Important:
 *   - Expected counts (17 kept + 3 surface points) depend on the 10 m step and 0.3 clearance; change them together.
 *   - Runs under Node with type stripping, so no TS-only syntax such as enums.
 */
import assert from "node:assert/strict";
import * as THREE from "three";
import { clipAtLakes } from "../src/world/geoutil.ts";

const R = 500;
// river walking along the equator in 10 m steps; the ground dips 3 m below R inside a 40 m-radius basin at 200 m
const at = (m: number, h: number) => new THREE.Vector3(Math.cos(m / R), 0, Math.sin(m / R)).multiplyScalar(R + h);
const ground = (m: number) => (Math.abs(m - 200) < 40 ? -3 : 1);
const path = Array.from({ length: 40 }, (_, i) => at(i * 10, ground(i * 10) + 0.3));
const lake = { center: at(200, 0), radius: 40, level: R - 1 };

const out = clipAtLakes(path, [lake], 0.3);
// first point below the water is index 17 (170 m): keep 0..16, then 3 surface points
assert.equal(out.length, 17 + 3);
for (let i = 0; i < 17; i++) assert.equal(out[i], path[i]);
for (const p of out.slice(17)) assert.ok(Math.abs(p.length() - (lake.level + 0.05)) < 1e-6, "tail sits on the water");
assert.ok(out.every((p) => p.length() >= lake.level), "nothing left under the lake surface");

// a path that never reaches the lake is untouched
assert.equal(clipAtLakes(path.slice(0, 15), [lake], 0.3).length, 15);
// a basin with no lake does nothing
assert.equal(clipAtLakes(path, [], 0.3), path);
console.log("lakeclip ok");
