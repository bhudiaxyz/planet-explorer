export function rng(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
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
  p = new Uint8Array(512);
  constructor(seed: number) {
    const r = rng(seed),
      a = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = (r() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    for (let i = 0; i < 512; i++) this.p[i] = a[i & 255];
  }
  get(x: number, y: number, z: number) {
    const p = this.p,
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
    const A = p[xi] + yi,
      AA = p[A] + zi,
      AB = p[A + 1] + zi,
      B = p[xi + 1] + yi,
      BA = p[B] + zi,
      BB = p[B + 1] + zi;
    return lerp(
      lerp(
        lerp(grad(p[AA], x, y, z), grad(p[BA], x - 1, y, z), u),
        lerp(grad(p[AB], x, y - 1, z), grad(p[BB], x - 1, y - 1, z), u),
        v,
      ),
      lerp(
        lerp(grad(p[AA + 1], x, y, z - 1), grad(p[BA + 1], x - 1, y, z - 1), u),
        lerp(
          grad(p[AB + 1], x, y - 1, z - 1),
          grad(p[BB + 1], x - 1, y - 1, z - 1),
          u,
        ),
        v,
      ),
      w,
    );
  }
  fbm(x: number, y: number, z: number, oct: number, lac: number, per: number) {
    let s = 0,
      a = 1,
      f = 1,
      n = 0;
    for (let i = 0; i < oct; i++) {
      s += a * this.get(x * f, y * f, z * f);
      n += a;
      a *= per;
      f *= lac;
    }
    return s / n;
  }
}
