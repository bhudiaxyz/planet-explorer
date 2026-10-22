import GUI from "lil-gui";
import { S, WEATHER_TYPE, type Settings } from "./settings";
import { isTouchDevice } from "./touch";
import { PALETTES, biomeColors, setPalette } from "./palette";
import type { Planet } from "./planet";
import type { Player } from "./player";
import type { PostFX } from "./postfx";
import type { Spot } from "./spots";

interface Ctx {
  planet: Planet;
  player: Player;
  post: PostFX;
  rebuild: (respawn?: boolean) => void;
  rebuildVeg: () => void;
  spots: Spot[];
}
// [setting, min, max, step]; terrain settings rebuild the planet when released (seed/radius also respawn the player)
const TERRAIN: [keyof Settings, number, number, number][] = [
  ["seed", 0, 99999, 1],
  ["radius", 200, 1500, 10],
  ["resolution", 64, 256, 8],
  ["amplitude", 5, 200, 1],
  ["frequency", 0.3, 5, 0.05],
  ["octaves", 1, 8, 1],
  ["persistence", 0.2, 0.8, 0.01],
  ["lacunarity", 1.5, 3, 0.05],
  ["mountains", 0, 1.5, 0.01],
  ["seaLevel", -0.3, 0.4, 0.01],
];

/** Builds the settings panel (G toggles it). */
export function setupGui({ planet, player, post, rebuild, rebuildVeg, spots }: Ctx) {
  const gui = new GUI({ title: "Planet settings", width: Math.min(280, innerWidth - 8) });
  const paletteState = { palette: "Earth" };
  gui.add(paletteState, "palette", Object.keys(PALETTES))
    .name("🪐 Planet palette")
    .onChange((name: string) => {
      const p = PALETTES[name];
      setPalette(p);
      S.snowline = p.snowline;
      S.forest = p.forestDensity;
      planet.water.color.set(biomeColors.water);
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      rebuildVeg();
      rebuild();
    });
  const terrain = gui.addFolder("Terrain");
  for (const [k, min, max, step] of TERRAIN)
    terrain
      .add(S, k, min, max, step)
      .onFinishChange(() => rebuild(k === "seed" || k === "radius"));
  const biomes = gui.addFolder("Biomes");
  biomes
    .add(S, "forest", 0, 2, 0.05)
    .name("forest density")
    .onFinishChange(() => rebuild());
  biomes.add(S, "snowline", -0.2, 0.8, 0.01).onFinishChange(() => rebuild());
  for (const k of ["sand", "grass", "forest", "rock", "snow"] as const)
    biomes
      .addColor(biomeColors, k)
      .name(k + " colour")
      .onFinishChange(() => rebuild());
  biomes
    .addColor(biomeColors, "water")
    .onChange((v: string) => planet.water.color.set(v));
  const sky = gui.addFolder("Sky & weather");
  sky.add(S, "timeOfDay", 0, 1, 0.001).listen();
  sky.add(S, "dayLength", 20, 1200, 1).name("day length (s)");
  sky.add(S, "wind", 0, 3, 0.05);
  sky.add(S, "windSway", 0, 2, 0.05).name("wind sway");
  sky.add(S, "cloudiness", 0, 1, 0.01);
  sky
    .add(S, "renderScale", 0.5, 2, 0.05)
    .name("render scale")
    .onFinishChange((v: number) => post.requestScale(v));
  if (isTouchDevice)
    sky.add(S, "touchLookSensitivity", 0.5, 6, 0.1).name("look sensitivity");
  sky.add(S, "weather", Object.values(WEATHER_TYPE));
  let locs: GUI | null = null;
  if (spots.length) {
    const touch = isTouchDevice;
    locs = new GUI({ title: "📍", width: touch ? 70 : 58 });
    for (const spot of spots)
      locs.add({ go: () => player.warpTo(spot.dir) }, "go").name(spot.icon);
    Object.assign(locs.domElement.style, { position: "fixed", top: "78px", left: "10px" });
    if (touch) {
      locs.domElement.style.setProperty("--widget-height", "44px");
      locs.hide();
    }
  }
  gui
    .add(
      {
        randomize: () => {
          S.seed = Math.floor(Math.random() * 99999);
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
          rebuild(true);
        },
      },
      "randomize",
    )
    .name("🎲 New random world");
  gui.add({ fly: () => player.toggle() }, "fly").name("Toggle walk / fly (F)");
  addEventListener("keydown", (e) => {
    if (e.code === "KeyG") {
      const show = gui._hidden;
      gui.show(show);
      locs?.show(show);
    }
  });
  return { gui, locs };
}
export type { GUI };
export type SetupGuiResult = { gui: GUI; locs: GUI | null };
