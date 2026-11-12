import * as THREE from "three";
import { Planet } from "./world/planet";
import { Sky } from "./world/sky";
import { SkyDome } from "./world/skyfx";
import { Aurora, Fireflies, GalacticBand, Bioluminescence } from "./world/night";
import { Birds, ShootingStars, Lightning, Flutter } from "./world/life";
import { Player } from "./player/player";
import { Scatter, placementBakeMaterial } from "./world/vegetation";
import { Collider } from "./world/collision";
import { PostFX } from "./render/postfx";
import { Shadows } from "./render/shadows";
import { Footprints } from "./world/footprints";
import { setupGui } from "./ui/gui";
import { findSpots } from "./world/spots";
import { setRenderer, precompileBakes } from "./render/bake";
import { U } from "./render/fx";
import { smoothstep } from "./core/utilgeo";
import { S, currentSeedWord, pushSeedUrl } from "./core/config";
import { isTouchDevice, setupTouch, setGuiToggle, setMapToggle, lockPointer } from "./player/touch";
import { MapOverlay } from "./ui/map";
import { detectGpuTier, setGpuTier, gpuTier } from "./render/gputier";

// ---- GPU tier detection (offscreen probe so antialias can be set correctly) ------
{
    const probe = document.createElement("canvas");
    // Request high-performance so dual-GPU laptops probe the discrete GPU, matching the main renderer.
    const ctxOpts: WebGLContextAttributes = { powerPreference: "high-performance" };
    const gl = probe.getContext("webgl2", ctxOpts);
    if (!gl) {
        // three (r163+) and every shader here need WebGL 2. Without this check the renderer constructor below threw at
        // module level — outside the startup try/catch — leaving the loading screen on "Preparing world…" forever.
        // WebGL 2 ships on iOS/iPadOS 15+, Chrome/Edge/Firefox since 2017, Android Chrome on any GLES 3.0 GPU.
        const tip = document.getElementById("ls-tip");
        if (tip) {
            tip.textContent =
                "This browser or device doesn't support WebGL 2 (or it is disabled). Try an up-to-date Chrome, Edge, Firefox or Safari.";
            tip.style.color = "#f88";
        }
        throw new Error("[planet-explorer] WebGL 2 unavailable");
    }
    setGpuTier(detectGpuTier(gl));
    // Release context immediately — browsers cap the number of live WebGL contexts.
    (gl.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
}

// ---- renderer & scene ------------------------------------------------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
    // The scene is drawn into PostFX's own MSAA target (samples set per tier there); the canvas only receives the
    // final full-screen output pass, so a multisampled default framebuffer would be pure memory + resolve cost.
    antialias: false,
    powerPreference: "high-performance",
});
setRenderer(renderer);
// Production: skip three's per-program error check. It calls getProgramInfoLog right after linking, which forces the
// browser to wait for each compile synchronously — defeating KHR_parallel_shader_compile and serialising ~90 programs
// (measured: 66 calls, 128 s of a 134 s startup on Windows/ANGLE). Dev builds keep it so shader errors still surface.
renderer.debug.checkShaderErrors = import.meta.env.DEV;
// Tier-based quality: low = mobile/integrated, medium = mid-range, high = discrete/flagship mobile
const isMobileHigh = gpuTier === "high" && isTouchDevice;
if (gpuTier === "low") {
    S.resolution = 128;
    S.renderScale = 0.6;
    S.octaves = 4;
} else if (gpuTier === "medium") {
    S.resolution = 160;
    S.renderScale = 0.75;
    S.octaves = 5;
} else {
    // High tier: 320 gives 36% fewer base-mesh vertices than the default 400 with no visible
    // difference at flight/orbital altitude; the chunk system supplies close-up detail.
    S.resolution = 320;
    // Mobile high (e.g. S22 Ultra, iPad): lower mesh resolution, higher render scale for native-feeling sharpness.
    // Capped by a pixel budget, not a fixed DPR: 2.0 is right for a phone (412×915 CSS → 1.5 MP) but an iPad Pro
    // (1024×1366 CSS) would render 5.6 MP — ~270 MB for the 4× MSAA HalfFloat scene target alone, enough for iPadOS
    // to kill the tab. 2.4 MP keeps phones at 2.0 and lands iPads at ~1.3–1.5×.
    if (isMobileHigh) {
        S.resolution = 256;
        const css = Math.max(screen.width * screen.height, innerWidth * innerHeight);
        S.renderScale = Math.max(1, Math.min(2.0, Math.sqrt(2.4e6 / css)));
    }
    // Desktop/laptop Retina (DPR≥2): cap at 1.5 — saves GPU bandwidth on 4K/5K displays.
    else if (devicePixelRatio > 1) S.renderScale = 1.5;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, S.renderScale));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(
        70,
        innerWidth / innerHeight,
        0.2,
        gpuTier === "low" ? 20000 : gpuTier === "medium" ? 30000 : 40000
    );

// ---- world & systems ---------------------------------------------------------------------------------------------------------------------------
(async () => {
    const lsTip = document.getElementById("ls-tip")!;
    const STEPS = 5;
    const setStep = (n: number, label: string) => {
        lsTip.textContent = `Step ${n} of ${STEPS}: ${label}…`;
        return new Promise<void>((r) => requestAnimationFrame(() => r()));
    };

    await setStep(1, "Building terrain");
    // Fire off every terrain-bake shader compile at once (parallel, off the main thread where KHR_parallel_shader_compile
    // exists) so the bakes below don't each trigger a blocking compile in turn. Not awaited: it overlaps the CPU setup.
    void precompileBakes(camera, [placementBakeMaterial()]);
    const planet = new Planet(scene);
    await planet.build();
    pushSeedUrl(currentSeedWord);

    // Rivers and scouting run concurrently — findSpots does its terrain scan while rivers build,
    // then awaits riversReady before reading planet.riverSystem for river teleport entries.
    const riversPromise = planet.buildRivers().catch(() => {});
    const spotsPromise = findSpots(planet, riversPromise);

    await setStep(2, "Setting up world");
    const player = new Player(camera, planet, renderer.domElement);
    player.spawn();
    const sky = new Sky(scene, planet);
    const skyDome = new SkyDome(scene);
    const scatter = new Scatter(planet);
    const collider = new Collider(planet, scatter);
    const shadows = new Shadows(renderer, sky.light, sky.moon);
    const aurora = new Aurora(scene, camera);
    const fireflies = new Fireflies(scene);
    const galacticBand = new GalacticBand(scene);
    const biolumi = new Bioluminescence(scene);
    const birds = new Birds(scene);
    const shootingStars = new ShootingStars(scene);
    const lightning = gpuTier === "low" ? null : new Lightning(scene);
    const flutter = gpuTier === "high" ? new Flutter(scene) : null; // butterflies & falling leaves
    const radiusAt = (d: THREE.Vector3) => planet.radiusAt(d);
    const camForward = new THREE.Vector3();
    const flashColor = new THREE.Color(0.75, 0.8, 0.95);
    const footprints = gpuTier === "low" ? null : new Footprints(player, planet);
    const postFX = new PostFX(renderer, scene, camera);
    if (gpuTier !== "low") postFX.aerial.setCamera(camera.near, camera.far);
    scene.add(scatter.group, sky.light.target);
    player.col = collider;

    // ---- rebuilds (debounced) and context-loss recovery ---------------------------------------------------------------------------------------------
    const mapOverlay = new MapOverlay(renderer, planet, player);
    addEventListener("keydown", (e) => {
        if (e.code === "KeyM" && !e.repeat) mapOverlay.toggle();
    });

    // Rebuilds are chained: build() awaits GPU bakes, so a second rebuild starting mid-flight
    // would clear the group and then both would add their terrain/rivers (duplicate meshes).
    let rebuildTimer = 0,
        rebuildChain = Promise.resolve();
    const rebuild = (respawn = false) => {
        clearTimeout(rebuildTimer);
        rebuildTimer = window.setTimeout(() => {
            rebuildChain = rebuildChain
                .then(async () => {
                    await planet.build();
                    const newRiversPromise = planet.buildRivers().catch(() => {});
                    mapOverlay.reset();
                    scatter.dirty = true;
                    collider.dirty = true;
                    respawn ? player.spawn() : player.refresh();
                    // Re-scout so teleport list and map reflect the new planet
                    const newSpots = await findSpots(planet, newRiversPromise);
                    mapOverlay.setSpots(newSpots);
                })
                .catch((err) => console.error("[planet-explorer] rebuild failed", err));
        }, 120);
    };
    renderer.domElement.addEventListener("webglcontextlost", (e) => e.preventDefault());
    renderer.domElement.addEventListener("webglcontextrestored", () => rebuild(false));

    await setStep(3, "Scouting locations");
    const spots = await spotsPromise;
    mapOverlay.setSpots(spots);

    const { gui, locs } = setupGui({
        planet,
        player,
        post: postFX,
        rebuild,
        rebuildVeg: () => scatter.rebuild(),
        spots,
    });
    addEventListener("resize", () => {
        postFX.resize();
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
    });
    setupTouch(player, renderer.domElement);
    if (isTouchDevice) {
        setGuiToggle(() => {
            const show = gui._hidden;
            gui.show(show);
            locs?.show(show);
        });
        setMapToggle(() => mapOverlay.toggle());
    }
    const hud = document.getElementById("hud")!;

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
        let nearestD = 1e9,
            nearestN = "";
        for (const l of planet.landmarks.list) {
            const d = l.pos.distanceTo(camera.position);
            if (d < nearestD) {
                nearestD = d;
                nearestN = l.name;
            }
        }
        const nearestLandmark = { d: nearestD, n: nearestN };
        const weather = sky.snow && sky.precipitationAmount > 0.3 ? "snow" : sky.kind === "precip" ? "rain" : sky.kind;
        const modeLabel = player.mode === "drone" && player.landing ? "LANDING" : player.mode.toUpperCase();
        return `${modeLabel} · alt ${Math.round(player.alt)} m · ${String(Math.floor(hourOfDay)).padStart(2, "0")}:${String(Math.floor((hourOfDay % 1) * 60)).padStart(2, "0")}${nearestLandmark.n ? " · " + nearestLandmark.n + " " + Math.round(nearestLandmark.d) + " m" : ""} · ${weather}`;
    };

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
    splashControls.textContent = isTouchDevice
        ? "Left joystick · move   ↑ · ascend   ↓ · descend   ⚡ · sprint   ✈ · fly toggle   Swipe right · look"
        : "WASD · move   Shift · sprint   Space · jump/ascend   C · descend   F · walk↔fly   Q/E · roll   G · panel   Esc · release mouse";

    // Pre-compile all shaders so the first visible frame is instant.
    // compileAsync is synchronous on browsers without KHR_parallel_shader_compile (iOS Safari, many
    // mobile Chrome builds) — labelling it as a loading step keeps the screen honest during the block.
    await setStep(4, "Compiling shaders");
    await renderer.compileAsync(scene, camera).catch(() => {});

    // Render one warm-up frame — uploads geometry/textures to GPU and pre-compiles all
    // EffectComposer pass shaders. Routing through postFX ensures aerial/bloom/output passes
    // compile here (during labelled loading) rather than lazy-compiling on the first visible frame.
    await setStep(5, "Warming up");
    sky.update(0, camera, player.up, player.alt, 0.5);
    planet.update(player.up, player.alt);
    postFX.render(0);
    // Frame loop must be running before the RAF wait so the first visible frame
    // is already rendered when showSplash reveals the canvas (memory: project_startup_sequence)
    let lastFrameTime = performance.now(),
        hudTimer = 0;
    renderer.setAnimationLoop(() => {
        const now = performance.now(),
            dt = Math.min(0.1, (now - lastFrameTime) / 1000);
        lastFrameTime = now;
        // movement runs in ≤33 ms sub-steps so walking speed and collision stay correct even at low frame rates
        const steps = Math.ceil(dt / 0.033);
        for (let i = 0; i < steps; i++) player.update(dt / steps);
        if (!Number.isFinite(player.alt) || !Number.isFinite(camera.position.x)) {
            player.spawn();
            player.update(0);
        } // NaN safety net
        const near = player.mode === "walk" ? 0.1 : Math.max(0.1, Math.min(10, player.alt * 0.02));
        if (Math.abs(near - camera.near) > camera.near * 0.02) {
            camera.near = near;
            camera.updateProjectionMatrix();
            if (gpuTier !== "low") postFX.aerial.setCamera(camera.near, camera.far);
        }

        sky.update(dt, camera, player.up, player.alt, tempAt());
        // lightning flash: applied after sky.update, which rebuilds bg / fog / ambient from scratch every frame
        if (lightning) {
            camera.getWorldDirection(camForward);
            const flash = lightning.update(
                dt,
                camera.position,
                camForward,
                player.up,
                sky.precipitationAmount,
                radiusAt
            );
            if (flash > 0) {
                sky.bg.lerp(flashColor, flash * 0.55);
                (scene.fog as THREE.FogExp2).color.copy(sky.bg);
                sky.ambientLight.intensity += flash * 1.4;
            }
        }
        U.uTime.value += dt;
        U.uWind.value = S.wind * (0.6 + sky.cloud * 1.2);
        U.uSway.value = S.windSway;
        U.uSun.value.copy(sky.sun);
        U.uDayF.value = sky.dayF;
        U.uSky.value.copy(sky.bg);
        U.uCov.value = Math.min(1, S.cloudiness * 0.75 + sky.cloud * 0.55);
        U.uCT.value += dt * (0.6 + S.wind * 0.5);
        // ground wetness: soaks in over ~10 s of rain, dries over ~1 min (snow doesn't wet the ground)
        const raining = sky.snow ? 0 : sky.precipitationAmount;
        U.uWet.value += (raining - U.uWet.value) * Math.min(1, dt * (raining > U.uWet.value ? 0.1 : 0.016));
        planet.clouds.update(camera.position, sky);
        skyDome.update(camera.position, player.up, sky, dt);
        planet.atmosphere.visible = planet.atmosphere.uniforms.fade.value > 0.01;

        planet.update(player.up, player.alt);
        planet.tick(dt);
        planet.forest.update(camera.position);
        scatter.update(player.up, player.alt);
        footprints?.update(dt);
        const night = (1 - sky.dayF) * (1 - sky.space) * (1 - sky.cloud);
        U.uNight.value = night;
        if (night > 0.01) galacticBand.mesh.rotation.y = S.timeOfDay * Math.PI * 2;
        aurora.update(camera.position, player.up, night * smoothstep(0.1, 0.45, Math.abs(player.up.y)), U.uTime.value);
        fireflies.update(
            dt,
            U.uTime.value,
            camera.position,
            night * (1 - smoothstep(20, 40, player.alt)) * (1 - sky.precipitationAmount),
            sky.dayF
        );
        biolumi.update(dt, camera.position);
        camera.getWorldDirection(camForward);
        birds.update(camera.position, camForward, player.up, sky.dayF, player.alt);
        shootingStars.update(camera.position, player.up, camForward, night);
        flutter?.update(camera.position, sky.dayF, player.alt);
        shadows.update(dt, player.alt, sky.dayF, sky.sun, camera.position);
        if ((hudTimer += dt) > 0.25) {
            hudTimer = 0;
            hud.textContent = hudText();
        }
        mapOverlay.tick();
        postFX.render(dt);
    });

    // Loop is now running — wait for one rendered frame then reveal the splash
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    showSplash(enterLabel);
    splash.addEventListener("click", () => {
        hideSplash();
        if (!isTouchDevice) lockPointer(renderer.domElement);
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
})().catch((err: unknown) => {
    // Surface startup errors on the loading screen instead of silently stalling.
    const tip = document.getElementById("ls-tip");
    if (tip) {
        tip.style.display = "";
        tip.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
        tip.style.color = "#f88";
    }
    console.error("[planet-explorer] startup failed", err);
});
