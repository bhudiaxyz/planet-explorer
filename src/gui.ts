import GUI from "lil-gui";
import { S, WEATHER_TYPE, type Settings } from "./config";
import { pushSeedUrl, currentSeedWord } from "./main";
import { genSeedWord } from "./util";
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
// [setting, min, max, step]; terrain settings rebuild the planet when released (radius also respawns the player)
const TERRAIN: [keyof Settings, number, number, number][] = [
  ["radius", 200, 1500, 10],
  ["resolution", 64, 512, 16],
  ["amplitude", 5, 200, 1],
  ["frequency", 0.3, 5, 0.05],
  ["octaves", 1, 8, 1],
  ["persistence", 0.2, 0.8, 0.01],
  ["lacunarity", 1.5, 3, 0.05],
  ["mountains", 0, 1.5, 0.01],
  ["seaLevel", -0.3, 0.4, 0.01],
];

// left-align button labels inside the locations panel
const locsStyle = document.createElement("style");
locsStyle.textContent = [
  ".locs-panel .lil-controller.lil-function button { text-align: left; }",
  ".locs-panel .children .lil-controller.lil-function button { padding-left: 14px; }",
].join(" ");
document.head.appendChild(locsStyle);

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
  const seedState = { word: currentSeedWord };
  terrain.add(seedState, "word").name("seed").onFinishChange((v: string) => { pushSeedUrl(v); rebuild(true); });
  for (const [k, min, max, step] of TERRAIN)
    terrain
      .add(S, k, min, max, step)
      .onFinishChange(() => { rebuild(k === "radius"); });
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
    locs = new GUI({ title: "📍", width: touch ? 120 : 110 });
    locs.domElement.classList.add("locs-panel");
    // ungrouped spots (fixed nav + terrain features) go flat
    for (const spot of spots.filter(s => !s.group))
      locs.add({ go: () => player.warpTo(spot.dir) }, "go").name(`${spot.icon} ${spot.name}`);
    // landmark types go into collapsible subfolders — single pass
    const grouped = new Map<string, Spot[]>();
    for (const s of spots) if (s.group) {
      if (!grouped.has(s.group)) grouped.set(s.group, []);
      grouped.get(s.group)!.push(s);
    }
    for (const [g, members] of grouped) {
      const folder = locs.addFolder(g);
      folder.close();
      for (const spot of members)
        folder.add({ go: () => player.warpTo(spot.dir) }, "go").name(`${spot.icon} ${spot.name}`);
    }
    Object.assign(locs.domElement.style, { position: "fixed", top: "78px", left: "10px" });
    if (touch) {
      locs.domElement.style.setProperty("--widget-height", "44px");
      Object.assign(locs.domElement.style, {
        maxHeight: "calc(100dvh - 90px)",
        overflowY: "auto",
      });
      locs.hide();
    }
  }
  gui
    .add(
      {
        randomize: () => {
          const word = genSeedWord();
          seedState.word = word;
          const weathers = Object.values(WEATHER_TYPE);
          S.weather = weathers[Math.floor(Math.random() * weathers.length)];
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
          pushSeedUrl(word);
          rebuild(true);
        },
      },
      "randomize",
    )
    .name("🎲 New random world");
  gui.add({ fly: () => player.toggle() }, "fly").name("Cycle walk / drone / fly (F)");
  gui.add({ land: () => { if (player.mode !== "walk") player.land(); } }, "land").name("Land (L)");
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
