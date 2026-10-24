// Central tuning constants. Distances are metres; everything that used to be a scattered magic number lives here so a change is made once.
export const CFG = {
  // terrain chunk streaming: (cells × cell) metre squares on the planet's face lattice, (2·radius+1)² around the player
  chunk: {
    cells: 80,
    cell: 1.5,
    radius: 4,
    drop: 1.5,
    skirt: 12,
    makeAlt: 480,
    clearAlt: 580,
    budget: 4,
    firstBudget: 25,
  },
  // tree LOD cross-fade bands: detailed→medium over [0]..[1], medium→low-poly over [2]..[3]
  treeLod: [40, 70, 130, 170] as const,
  // ground-cover tiers: [full-size until, gone beyond, inner gone below, inner full above]  (see vegetation.ts for the lifecycle rules)
  plantLod: {
    // small ground cover (grass, flowers, ferns, reeds, sedge, mushrooms)
    near:    [28, 52,  0,  0.5],
    mid:     [60, 100, 8,  24],
    far:     [155, 200, 42, 64],
    flower:  [40, 64,  0,  0.5],
    mush:    [20, 44,  0,  0.5],
    // medium shrub-height objects (shrubs, alpine scrub, cactus, dead scrub)
    shrub:   [42, 80,  0,  0.5],
    shrubMid:[88, 150, 14, 36],
    // large rocks, slabs, frost rocks, boulders
    rock:    [55, 110, 0,  0.5],
    rockMid: [120, 200, 20, 44],
  },
  plantRadius: { near: 56, mid: 104, far: 204, flower: 68, mush: 48, shrub: 88, shrubMid: 160, rock: 120, rockMid: 210 },
  forest: { count: 22000, minSpacing: 2.4, tries: 12 },
  shadow: { size: 2048, half: 120, hz: 30 },

  // tree instance management
  trees: {
    windFactor: 0.002,
    nearEnterAlt: 380,
    nearLeaveAlt: 420,
    nearHysteresisAlt: 400,
    nearFadeSpeed: 2.5,
  },

  // vegetation ground-cover altitude fade
  vegetation: {
    altFadeStart: 150,
    altFadeEnd: 250,
    altCullAbove: 255,
  },

  // sky / atmosphere
  sky: {
    starCount: 2500,
    starSize: 1.6,
    precipCount: 3500,
    nebulaCount: 14,
    nebulaOpacity: 0.18,
    sunDiscRadius: 450,
    moonDiscRadius: 300,
    dawnSphereRadius: 980,
    fogDensityBase: 0.0009,
    fogDensityPrecip: 0.012,
  },
  atmosphere: {
    tilt: 0.41,
    dayFadeLow: -0.12,
    dayFadeHigh: 0.25,
    spaceStartFraction: 0.08,
    spaceEndFraction: 0.5,
    cloudRadiusOffset: 120,
  },
  lights: {
    sunIntensity: 3,
    sunCloudDim: 0.55,
    moonIntensity: 0.12,
    ambientBase: 0.12,
    ambientDayMul: 0.25,
  },
  ocean: {
    opacity: 0.74,
    roughness: 0.2,
    metalness: 0.1,
  },
} as const;

// ---- mutable runtime settings (seed, radius, weather, etc.) ----

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
  touchLookSensitivity: number;

  // Time & weather
  timeOfDay: number;
  dayLength: number;
  weather: Weather;
  wind: number;
  windSway: number;
  cloudiness: number;
}

export const S: Settings = {
  seed: 1337,
  radius: 700,
  resolution: 400,
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
  touchLookSensitivity: 2.5,

  timeOfDay: 0.3,
  dayLength: 240,
  weather: "auto",
  wind: 0.35,
  windSway: 1,
  cloudiness: 0.45,
};
