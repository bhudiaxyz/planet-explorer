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

  // arc.{0,8} handles "Arc(TM) A770"; apple m\d+ catches M1/M1 Pro/M2/etc.
  const HIGH = /rtx|rx [5-9]\d{3}|gtx 1[0-9]{3}|gtx 9[5-9]\d|arc.{0,8}a[5-9]\d{2}|apple m\d+/i;
  if (HIGH.test(renderer)) return 'high';

  // (uhd|hd graphics) without "Intel" prefix — "(R)" in real strings breaks prefix match
  // adreno.{0,8} handles "Adreno (TM) 530" ANGLE wrapper format
  const LOW = /(uhd [2-6]\d{2}|hd graphics)|mali[-\s]|adreno.{0,8}[3-5]\d{2}|videocore|powervr g[67]|sgx/i;
  if (LOW.test(renderer)) return 'low';

  return 'medium';
}

/** Instance count multiplier: 1.0 high, 0.80 medium, 0.65 low */
export const plantRadiusMul = () =>
  gpuTier === 'low' ? 0.50 : gpuTier === 'medium' ? 0.65 : 1.0;
