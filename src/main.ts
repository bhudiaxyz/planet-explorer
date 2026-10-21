import * as THREE from "three";
import { Planet } from "./planet";
import { Sky } from "./sky";
import { SkyDome } from "./skyfx";
import { Aurora, Fireflies } from "./night";
import { Player } from "./player";
import { Scatter } from "./vegetation";
import { Collider } from "./collision";
import { PostFX } from "./postfx";
import { Shadows } from "./shadows";
import { Footprints } from "./footprints";
import { setupGui } from "./gui";
import { setRenderer } from "./bake";
import { U } from "./fx";
import { smoothstep } from "./util";
import { S } from "./settings";

// ---- renderer & scene ------------------------------------------------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, S.renderScale));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
setRenderer(renderer);
const scene = new THREE.Scene(),
  camera = new THREE.PerspectiveCamera(
    70,
    innerWidth / innerHeight,
    0.2,
    40000,
  );

// ---- world & systems ---------------------------------------------------------------------------------------------------------------------------
const planet = new Planet(scene);
planet.build();
const player = new Player(camera, planet, renderer.domElement);
player.spawn();
const sky = new Sky(scene, planet),
  skyDome = new SkyDome(scene),
  scatter = new Scatter(planet),
  collider = new Collider(planet, scatter),
  shadows = new Shadows(renderer, sky.light);
const aurora = new Aurora(scene),
  fireflies = new Fireflies(scene),
  footprints = new Footprints(player, planet),
  postFX = new PostFX(renderer, scene, camera);
scene.add(scatter.group, sky.light.target);
player.col = collider;

// ---- rebuilds (debounced) and context-loss recovery ---------------------------------------------------------------------------------------------
let rebuildTimer = 0;
const rebuild = (respawn = false) => {
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => {
    planet.build();
    scatter.dirty = true;
    collider.dirty = true;
    respawn ? player.spawn() : player.refresh();
  }, 120);
};
renderer.domElement.addEventListener("webglcontextlost", (e) =>
  e.preventDefault(),
);
renderer.domElement.addEventListener("webglcontextrestored", () =>
  rebuild(false),
);
setupGui({ planet, player, post: postFX, rebuild });
addEventListener("resize", () => {
  postFX.resize();
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
const overlay = document.getElementById("ov")!,
  hud = document.getElementById("hud")!;
document.addEventListener(
  "pointerlockchange",
  () => (overlay.style.display = document.pointerLockElement ? "none" : "grid"),
);

// temperature under the player, recomputed only when they moved ≥ ~0.15 m
const lastTempDir = new THREE.Vector3(1e9, 0, 0);
let lastTempValue = 0.5;
const tempAt = () => {
  if (player.up.distanceToSquared(lastTempDir) > 4e-8) {
    lastTempDir.copy(player.up);
    lastTempValue = planet.temp(player.up, planet.elev(player.up));
  }
  return lastTempValue;
};
const hudText = () => {
  const hourOfDay = ((S.timeOfDay + 0.25) % 1) * 24,
    nearestLandmark = planet.lm.list.reduce(
      (a, l) => {
        const d = l.pos.distanceTo(camera.position);
        return d < a.d ? { d, n: l.name } : a;
      },
      { d: 1e9, n: "" },
    );
  const weather =
    sky.snow && sky.precipitationAmount > 0.3
      ? "snow"
      : sky.kind === "precip"
        ? "rain"
        : sky.kind;
  return `${player.mode.toUpperCase()} · alt ${Math.round(player.alt)} m · ${String(Math.floor(hourOfDay)).padStart(2, "0")}:${String(Math.floor((hourOfDay % 1) * 60)).padStart(2, "0")}${nearestLandmark.n ? " · " + nearestLandmark.n + " " + Math.round(nearestLandmark.d) + " m" : ""} · ${weather}`;
};

planet.update(player.up, player.alt);
renderer.compile(scene, camera); // precompile every shader (incl. shadow variants and the first chunk) so nothing compiles mid-game

// ---- frame loop ----------------------------------------------------------------------------------------------------------------------------------
let lastFrameTime = performance.now(),
  hudTimer = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now(),
    dt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  // movement runs in ≤33 ms sub-steps so walking speed and collision stay correct even at low frame rates
  const steps = Math.ceil(dt / 0.033);
  for (let i = 0; i < steps; i++) player.update(dt / steps);
  if (
    !Number.isFinite(player.alt) ||
    !Number.isFinite(camera.position.x)
  ) {
    player.spawn();
    player.update(0);
  } // NaN safety net
  const near =
    player.mode === "walk"
      ? 0.1
      : Math.max(0.1, Math.min(10, player.alt * 0.02));
  if (Math.abs(near - camera.near) > camera.near * 0.02) {
    camera.near = near;
    camera.updateProjectionMatrix();
  }

  sky.update(dt, camera, player.up, player.alt, tempAt());
  U.uTime.value += dt;
  U.uWind.value = S.wind * (0.6 + sky.cloud * 1.2);
  U.uSun.value.copy(sky.sun);
  U.uDayF.value = sky.dayF;
  U.uSky.value.copy(sky.bg);
  U.uCov.value = Math.min(1, S.cloudiness * 0.75 + sky.cloud * 0.55);
  U.uCT.value += dt * (0.6 + S.wind * 0.5);
  planet.clouds.update(camera.position, sky);
  skyDome.update(camera.position, player.up, sky);
  planet.atmo.visible = planet.atmo.uniforms.fade.value > 0.01;

  planet.update(player.up, player.alt);
  planet.tick(dt);
  planet.forest.update(camera.position);
  scatter.update(player.up, player.alt);
  footprints.update(dt);
  const night = (1 - sky.dayF) * (1 - sky.space) * (1 - sky.cloud);
  aurora.update(
    camera.position,
    player.up,
    night * smoothstep(0.35, 0.75, Math.abs(player.up.y)),
    U.uTime.value,
  );
  fireflies.update(
    dt,
    U.uTime.value,
    camera.position,
    night * (1 - smoothstep(20, 40, player.alt)) * (1 - sky.precipitationAmount),
  );
  shadows.update(dt, player.alt, sky.dayF, sky.sun, camera.position);
  if ((hudTimer += dt) > 0.25) {
    hudTimer = 0;
    hud.textContent = hudText();
  }
  postFX.render(dt);
});
