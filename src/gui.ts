import GUI from "lil-gui";
import { S } from "./settings";
import type { Planet } from "./planet";
import type { Player } from "./player";
import type { PostFX } from "./postfx";

interface Ctx {
  planet: Planet;
  player: Player;
  post: PostFX;
  rebuild: (respawn?: boolean) => void;
}
// [setting, min, max, step]; terrain settings rebuild the planet when released (seed/radius also respawn the player)
const TERRAIN: [string, number, number, number][] = [
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
export function setupGui({ planet, player, post, rebuild }: Ctx) {
  const gui = new GUI({ title: "Planet settings" });
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
  for (const k of ["sand", "grass", "forest", "rock", "snow"])
    biomes
      .addColor(S.colors, k)
      .name(k + " colour")
      .onFinishChange(() => rebuild());
  biomes
    .addColor(S.colors, "water")
    .onChange((v: string) => planet.water.color.set(v));
  const sky = gui.addFolder("Sky & weather");
  sky.add(S, "timeOfDay", 0, 1, 0.001).listen();
  sky.add(S, "dayLength", 20, 1200, 1).name("day length (s)");
  sky.add(S, "wind", 0, 3, 0.05);
  sky.add(S, "cloudiness", 0, 1, 0.01);
  sky
    .add(S, "renderScale", 0.5, 2, 0.05)
    .name("render scale")
    .onFinishChange((v: number) => post.requestScale(v));
  sky.add(S, "weather", ["auto", "clear", "rain", "snow", "fog"]);
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
    if (e.code === "KeyG") gui.show(gui._hidden);
  });
  return gui;
}
