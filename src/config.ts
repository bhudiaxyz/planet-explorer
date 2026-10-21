// Central tuning constants. Distances are metres; everything that used to be a scattered magic number lives here so a change is made once.
export const CFG = {
  // terrain chunk streaming: (cells × cell) metre squares on the planet's face lattice, (2·radius+1)² around the player
  chunk: {
    cells: 64,
    cell: 1.5,
    radius: 2,
    drop: 1.5,
    skirt: 8,
    makeAlt: 185,
    clearAlt: 215,
    budget: 2,
    firstBudget: 25,
  },
  // tree LOD cross-fade bands: detailed→medium over [0]..[1], medium→low-poly over [2]..[3]
  treeLod: [40, 70, 130, 170] as const,
  // ground-cover tiers: [full-size until, gone beyond, inner gone below, inner full above]  (see vegetation.ts for the lifecycle rules)
  plantLod: {
    near: [12, 28, -2, -1],
    mid: [49, 58, 5, 11],
    far: [170, 200, 40, 52],
    flower: [24, 34, -2, -1],
    mush: [10, 22, -2, -1],
  },
  plantRadius: { near: 29, mid: 68, far: 200, flower: 34, mush: 23.8 },
  forest: { count: 14000, minSpacing: 3.2, tries: 12 },
  shadow: { size: 2048, half: 70, hz: 10 },
} as const;
