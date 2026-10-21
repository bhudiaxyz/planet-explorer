export const WEATHER_TYPE = {
  Auto: "auto",
  Clear: "clear",
  Fog: "fog",
  Precip: "precip",
  Rain: "rain",
  Snow: "snow",
} as const;
export type Weather = (typeof WEATHER_TYPE)[keyof typeof WEATHER_TYPE];

export interface Settings {
  // Terrain generation
  seed: number;
  radius: number;
  resolution: number;
  amplitude: number;
  frequency: number;
  octaves: number;
  persistence: number;
  lacunarity: number;

  // Biome thresholds
  mountains: number;
  seaLevel: number;
  forest: number;
  snowline: number;

  // Rendering
  renderScale: number;

  // Time & weather
  timeOfDay: number;
  dayLength: number;
  weather: Weather;
  wind: number;
  cloudiness: number;
}

export const S: Settings = {
  seed: 1337,
  radius: 700,
  resolution: 220,
  amplitude: 70,
  frequency: 1.6,
  octaves: 6,
  persistence: 0.5,
  lacunarity: 2.0,

  mountains: 0.8,
  seaLevel: 0.05,
  forest: 0.7,
  snowline: 0.3,

  renderScale: 1,

  timeOfDay: 0.3,
  dayLength: 240,
  weather: "auto",
  wind: 1,
  cloudiness: 0.45,
};
