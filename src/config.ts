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
    near:   [22, 32, 0, 0.5],  // inner fade disabled (near is finest tier); outer pushed further
    mid:    [50, 72, 8, 20],
    far:    [155, 200, 38, 56],
    flower: [30, 44, 0, 0.5],  // inner fade disabled
    mush:   [12, 28, 0, 0.5],  // inner fade disabled
  },
  plantRadius: { near: 36, mid: 76, far: 204, flower: 48, mush: 32 },
  forest: { count: 22000, minSpacing: 2.4, tries: 12 },
  shadow: { size: 2048, half: 120, hz: 30 },
} as const;
