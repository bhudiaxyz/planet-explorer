export type GpuTier = "high" | "medium" | "low";

export let gpuTier: GpuTier = "medium";

export function setGpuTier(t: GpuTier) {
  gpuTier = t;
}

export function detectGpuTier(gl: WebGLRenderingContext | WebGL2RenderingContext): GpuTier {
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  if (!ext) {
    // Extension blocked (privacy mode / Firefox resistFingerprinting) — guess by touch.
    // Use 'medium' for touch: a modern iPad Pro or Pixel in privacy mode shouldn't get
    // the lowest quality tier (128px res, 0.6x scale) just because the renderer string is hidden.
    return "medium";
  }
  const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
  const r = renderer.toLowerCase();

  // Apple GPU: non-touch = M-series Mac (high), touch = iPhone/iPad
  // iPadOS 13+ defaults to "Request Desktop Website" so UA reads "Macintosh" — detect via
  // navigator.platform + maxTouchPoints instead of the UA string (Macs never have touch points).
  if (r.includes("apple gpu")) {
    if (!("ontouchstart" in window)) return "high";
    const isIpad =
      /ipad/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    return isIpad ? "high" : "medium";
  }

  // arc.{0,8} handles "Arc(TM) A770"; apple m\d+ is dead (apple gpu branch returns first, kept for clarity)
  // AMD: rx [5-9]\d{3} catches RX 5000-9000 (RDNA1-3); vega covers Vega 56/64; radeon vii is GCN5
  // Adreno 650+ (S21+, Pixel 6+) and all Adreno 7xx (S22 Ultra, S23 Ultra, S24 Ultra) are flagship mobile
  // xclipse covers Samsung Exynos 2200 "Xclipse 920" (RDNA2-based, S22 Ultra Exynos variant)
  // adreno.{0,8}x\d covers Snapdragon X Elite "Adreno X1-85" (2024 Copilot+ laptops)
  const HIGH =
    /rtx|rx [5-9]\d{3}|vega [5-9]\d|radeon vii|gtx 1[0-9]{3}|gtx 9[5-9]\d|arc.{0,8}a[5-9]\d{2}|apple m\d+|adreno.{0,8}(6[5-9]\d|7\d{2}|x\d)|xclipse/i;
  if (HIGH.test(renderer)) return "high";

  // Mali-G710/G715/G720 (Dimensity 9000+, high-end Oppo/Nothing/MediaTek) → medium
  // g7\d{2} matches G710-G799; (?!\d) prevents matching G7100+; must precede broad mali LOW
  if (/mali[-\s]g7\d{2}(?!\d)/i.test(renderer)) return "medium";
  // Mali-G72 (Galaxy S9/Note 8, 2017 flagship) lands medium not low — still handles medium quality
  if (/mali[-\s]g7[0-9](?!\d)/i.test(renderer)) return "medium";

  // uhd.{0,12} handles "UHD Graphics 630" (real ANGLE string) and "UHD 630"
  // adreno.{0,8} handles "Adreno (TM) 530" ANGLE wrapper format
  // mali[-\s] catches Mali-G31/G52/G57/G68/G71/G72/G76/G78, Mali-T, Mali-4xx (all low-end)
  // Adreno 3xx-5xx (mid/budget Android), Adreno 6[0-4]x (mid-range) fall to medium below
  // Oppo/Nothing/Samsung expose the underlying Adreno or Mali name, not the brand — handled above
  // Intel UHD 6xx (2018–2021 laptops) → medium; UHD 2xx–5xx remain low
  if (/uhd.{0,12}6\d{2}/i.test(renderer)) return "medium";
  // Intel Iris Plus (MacBook Air/Pro 2018–2020, Intel 11th gen) → medium
  if (/iris plus/i.test(renderer)) return "medium";
  const LOW =
    /(uhd.{0,12}[2-5]\d{2}|hd graphics)|mali[-\s]|adreno.{0,8}[3-5]\d{2}|videocore|powervr g[67]|sgx/i;
  if (LOW.test(renderer)) return "low";

  return "medium";
}

/** Instance count multiplier: 1.0 high, 0.65 medium, 0.50 low */
export const plantRadiusMul = () => (gpuTier === "low" ? 0.5 : gpuTier === "medium" ? 0.65 : 1.0);
