export function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function grad(h: number, x: number, y: number, z: number) {
  h &= 15;
  const u = h < 8 ? x : y,
    v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v);
}
export class Noise3 {
  permutation = new Uint8Array(512);
  constructor(seed: number) {
    const r = rng(seed),
      a = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = (r() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    for (let i = 0; i < 512; i++) this.permutation[i] = a[i & 255];
  }
  get(x: number, y: number, z: number) {
    const perm = this.permutation,
      X = Math.floor(x),
      Y = Math.floor(y),
      Z = Math.floor(z),
      xi = X & 255,
      yi = Y & 255,
      zi = Z & 255;
    x -= X;
    y -= Y;
    z -= Z;
    const u = fade(x),
      v = fade(y),
      w = fade(z);
    const A = perm[xi] + yi,
      AA = perm[A] + zi,
      AB = perm[A + 1] + zi,
      B = perm[xi + 1] + yi,
      BA = perm[B] + zi,
      BB = perm[B + 1] + zi;
    return lerp(
      lerp(
        lerp(grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z), u),
        lerp(grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z), u),
        v
      ),
      lerp(
        lerp(grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1), u),
        lerp(grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1), u),
        v
      ),
      w
    );
  }
  fbm(x: number, y: number, z: number, octaves: number, lacunarity: number, persistence: number) {
    let sum = 0,
      amplitude = 1,
      frequency = 1,
      norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amplitude * this.get(x * frequency, y * frequency, z * frequency);
      norm += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    return sum / norm;
  }
}
