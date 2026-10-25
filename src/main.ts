import * as THREE from "three";
import { Planet } from "./planet";
import { Sky } from "./sky";
import { SkyDome } from "./skyfx";
import { Aurora, Fireflies, GalacticBand, Bioluminescence } from "./night";
import { Player } from "./player";
import { Scatter } from "./vegetation";
import { Collider } from "./collision";
import { PostFX } from "./postfx";
import { Shadows } from "./shadows";
import { Footprints } from "./footprints";
import { setupGui } from "./gui";
import { findSpots } from "./spots";
import { setRenderer } from "./bake";
import { U } from "./fx";
import { smoothstep } from "./utilgeo";
import { genSeedWord, hashSeedWord } from "./util";
import { S } from "./config";
import { isTouchDevice, setupTouch, setGuiToggle, setMapToggle } from "./touch";
import { MapOverlay } from "./map";
import { detectGpuTier, setGpuTier, gpuTier } from "./gputier";

// word-based seed: hash string → number for noise; URL stores the word
export let currentSeedWord = genSeedWord();
const urlWord = new URLSearchParams(location.search).get("seed");
if (urlWord) currentSeedWord = urlWord;
S.seed = hashSeedWord(currentSeedWord);
export function pushSeedUrl(word: string) {
  currentSeedWord = word;
  S.seed = hashSeedWord(word);
  const p = new URLSearchParams(location.search);
  p.set("seed", word);
  history.replaceState(null, "", "?" + p.toString());
}

// ---- renderer & scene ------------------------------------------------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
});
setRenderer(renderer);
{
  const gl = renderer.getContext();
  setGpuTier(detectGpuTier(gl));
}
// Tier-based quality: low = mobile/integrated, medium = mid-range, high = discrete
if (gpuTier === 'low')    { S.resolution = 128; S.renderScale = 0.75; S.octaves = 4; }
else if (gpuTier === 'medium') { S.resolution = 160; S.renderScale = 0.85; S.octaves = 5; }
renderer.setPixelRatio(Math.min(devicePixelRatio, S.renderScale));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(),
  camera = new THREE.PerspectiveCamera(
    70,
    innerWidth / innerHeight,
    0.2,
    40000,
  );

// ---- world & systems ---------------------------------------------------------------------------------------------------------------------------
(async () => {
const lsTip = document.getElementById("ls-tip")!;
const STEPS = 4;
const setStep = (n: number, label: string) => {
  lsTip.textContent = `Step ${n} of ${STEPS}: ${label}`;
  return new Promise<void>(r => requestAnimationFrame(() => r()));
};

await setStep(1, "Building terrain");
const planet = new Planet(scene);
await planet.build();
pushSeedUrl(currentSeedWord);

// Start scouting immediately — only needs planet, not scatter or other systems
const spotsPromise = findSpots(planet);

await setStep(2, "Setting up world");
const player = new Player(camera, planet, renderer.domElement);
player.spawn();
const sky = new Sky(scene, planet);
const skyDome = new SkyDome(scene);
const scatter = new Scatter(planet);
const collider = new Collider(planet, scatter);
const shadows = new Shadows(renderer, sky.light, gpuTier !== 'high', sky.moon);
const aurora = new Aurora(scene);
const fireflies = new Fireflies(scene);
const galacticBand = new GalacticBand(scene);
const biolumi = new Bioluminescence(scene);
const footprints = gpuTier === 'low' ? null : new Footprints(player, planet);
const postFX = new PostFX(renderer, scene, camera);
postFX.aerial.setCamera(camera.near, camera.far);
scene.add(scatter.group, sky.light.target);
player.col = collider;

// ---- rebuilds (debounced) and context-loss recovery ---------------------------------------------------------------------------------------------
const mapOverlay = new MapOverlay(renderer, planet, player);
addEventListener("keydown", e => { if (e.code === "KeyM" && !e.repeat) mapOverlay.toggle(); });

let rebuildTimer = 0;
const rebuild = (respawn = false) => {
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(async () => {
    await planet.build();
    mapOverlay.reset();
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

await setStep(3, "Scouting locations");
const spots = await spotsPromise;
mapOverlay.setSpots(spots);

const { gui, locs } = setupGui({ planet, player, post: postFX, rebuild, rebuildVeg: () => scatter.rebuild(), spots });
addEventListener("resize", () => {
  postFX.resize();
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
setupTouch(player, renderer.domElement);
if (isTouchDevice) setGuiToggle(() => {
  const show = gui._hidden;
  gui.show(show);
  locs?.show(show);
});
if (isTouchDevice) setMapToggle(() => mapOverlay.toggle());
const hud = document.getElementById("hud")!

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
  const hourOfDay = ((S.timeOfDay + 0.25) % 1) * 24;
  let nearestD = 1e9, nearestN = "";
  for (const l of planet.landmarks.list) {
    const d = l.pos.distanceTo(camera.position);
    if (d < nearestD) { nearestD = d; nearestN = l.name; }
  }
  const nearestLandmark = { d: nearestD, n: nearestN };
  const weather =
    sky.snow && sky.precipitationAmount > 0.3
      ? "snow"
      : sky.kind === "precip"
        ? "rain"
        : sky.kind;
  const modeLabel = player.mode === "drone" && player.landing ? "LANDING" : player.mode.toUpperCase();
  return `${modeLabel} · alt ${Math.round(player.alt)} m · ${String(Math.floor(hourOfDay)).padStart(2, "0")}:${String(Math.floor((hourOfDay % 1) * 60)).padStart(2, "0")}${nearestLandmark.n ? " · " + nearestLandmark.n + " " + Math.round(nearestLandmark.d) + " m" : ""} · ${weather}`;
};

planet.update(player.up, player.alt);

const splash = document.getElementById("ls")!;
const splashEnter = document.getElementById("ls-enter")!;
const splashControls = document.getElementById("ls-controls")!;
const showSplash = (label: string) => {
  splashEnter.textContent = label;
  lsTip.style.display = "none";
  splashControls.style.display = "";
  splash.classList.add("ready");
  splash.classList.remove("dismissed");
};
const hideSplash = () => {
  splash.classList.add("dismissed");
};

const enterLabel = isTouchDevice ? "Tap to enter" : "Click to enter";


await setStep(4, "Ready");
showSplash(enterLabel); // show enter button immediately; splash stays up while shaders warm
// Warm shaders during the "click to enter" pause — fire-and-forget so it never blocks startup
renderer.compileAsync(scene, camera).catch(() => {});
splash.addEventListener("click", () => {
  hideSplash();
  if (!isTouchDevice) renderer.domElement.requestPointerLock();
});
if (!isTouchDevice) {
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement) {
      hideSplash();
    } else {
      showSplash("Click to resume");
    }
  });
}

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
  U.uSway.value = S.windSway;
  U.uSun.value.copy(sky.sun);
  U.uDayF.value = sky.dayF;
  U.uSky.value.copy(sky.bg);
  U.uCov.value = Math.min(1, S.cloudiness * 0.75 + sky.cloud * 0.55);
  U.uCT.value += dt * (0.6 + S.wind * 0.5);
  planet.clouds.update(camera.position, sky);
  skyDome.update(camera.position, player.up, sky);
  planet.atmosphere.visible = planet.atmosphere.uniforms.fade.value > 0.01;

  planet.update(player.up, player.alt);
  planet.tick(dt);
  planet.forest.update(camera.position);
  scatter.update(player.up, player.alt, dt);
  footprints?.update(dt);
  const night = (1 - sky.dayF) * (1 - sky.space) * (1 - sky.cloud);
  U.uNight.value = night;
  if (night > 0.01) galacticBand.mesh.rotation.y = S.timeOfDay * Math.PI * 2;
  aurora.update(
    camera.position,
    player.up,
    night * smoothstep(0.1, 0.45, Math.abs(player.up.y)),
    U.uTime.value,
  );
  fireflies.update(
    dt,
    U.uTime.value,
    camera.position,
    night * (1 - smoothstep(20, 40, player.alt)) * (1 - sky.precipitationAmount),
    sky.dayF,
  );
  biolumi.update(dt, camera.position);
  shadows.update(dt, player.alt, sky.dayF, sky.sun, camera.position);
  if ((hudTimer += dt) > 0.25) {
    hudTimer = 0;
    hud.textContent = hudText();
  }
  mapOverlay.tick();
  postFX.render(dt);
});
})();
