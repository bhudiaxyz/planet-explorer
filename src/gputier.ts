export type GpuTier = 'high' | 'medium' | 'low';

export let gpuTier: GpuTier = 'medium';

export function setGpuTier(t: GpuTier) { gpuTier = t; }

export function detectGpuTier(gl: WebGLRenderingContext | WebGL2RenderingContext): GpuTier {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  if (!ext) {
    // Extension blocked (privacy mode) — guess by touch
    return ('ontouchstart' in window) ? 'low' : 'medium';
  }
  const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
  const r = renderer.toLowerCase();

  // Apple GPU: non-touch = M-series Mac (high), touch = iPhone/iPad (medium)
  if (r.includes('apple gpu')) {
    return ('ontouchstart' in window) ? 'medium' : 'high';
  }

  // arc.{0,8} handles "Arc(TM) A770"; apple m\d+ is dead (apple gpu branch returns first, kept for clarity)
  // AMD: rx [5-9]\d{3} catches RX 5000-9000 (RDNA1-3); vega covers Vega 56/64; radeon vii is GCN5
  // Adreno 650+ (S21+, Pixel 6+) and all Adreno 7xx (S22 Ultra, S23 Ultra, S24 Ultra) are flagship mobile
  // xclipse covers Samsung Exynos 2200 "Xclipse 920" (RDNA2-based, S22 Ultra Exynos variant)
  const HIGH = /rtx|rx [5-9]\d{3}|vega [5-9]\d|radeon vii|gtx 1[0-9]{3}|gtx 9[5-9]\d|arc.{0,8}a[5-9]\d{2}|apple m\d+|adreno.{0,8}(6[5-9]\d|7\d{2})|xclipse/i;
  if (HIGH.test(renderer)) return 'high';

  // Mali-G710/G715/G720 (Dimensity 9000+, high-end Oppo/Nothing/MediaTek) → medium
  // g7\d{2} matches G710-G799; (?!\d) prevents matching G7100+; must precede broad mali LOW
  if (/mali[-\s]g7\d{2}(?!\d)/i.test(renderer)) return 'medium';

  // uhd.{0,12} handles "UHD Graphics 630" (real ANGLE string) and "UHD 630"
  // adreno.{0,8} handles "Adreno (TM) 530" ANGLE wrapper format
  // mali[-\s] catches Mali-G31/G52/G57/G68/G71/G72/G76/G78, Mali-T, Mali-4xx (all low-end)
  // Adreno 3xx-5xx (mid/budget Android), Adreno 6[0-4]x (mid-range) fall to medium below
  // Oppo/Nothing/Samsung expose the underlying Adreno or Mali name, not the brand — handled above
  const LOW = /(uhd.{0,12}[2-6]\d{2}|hd graphics)|mali[-\s]|adreno.{0,8}[3-5]\d{2}|videocore|powervr g[67]|sgx/i;
  if (LOW.test(renderer)) return 'low';

  return 'medium';
}

/** Instance count multiplier: 1.0 high, 0.65 medium, 0.50 low */
export const plantRadiusMul = () =>
  gpuTier === 'low' ? 0.50 : gpuTier === 'medium' ? 0.65 : 1.0;
