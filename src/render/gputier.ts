export type GpuTier = "high" | "medium" | "low";

export let gpuTier: GpuTier = "medium";

// Primary input is touch: phones, tablets, iPad (incl. desktop-mode Safari). `"ontouchstart" in window` is also true on
// Windows touchscreen laptops and some Chromebooks, which then lost mouse-look/pointer-lock and got the joystick UI.
// `pointer: coarse` reflects the *primary* pointer, so those stay on desktop controls. Falls back for very old browsers.
export const isTouchDevice: boolean =
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").media !== "not all"
        ? matchMedia("(pointer: coarse)").matches
        : "ontouchstart" in window;

export function setGpuTier(t: GpuTier) {
    gpuTier = t;
}

export function detectGpuTier(gl: WebGLRenderingContext | WebGL2RenderingContext): GpuTier {
    if (location.search.includes("forcetier=")) return new URLSearchParams(location.search).get("forcetier") as GpuTier;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) {
        // Extension blocked (privacy mode / Firefox resistFingerprinting): the GPU is unknown.
        // Touch → low (can't confirm a flagship). Desktop → medium, not high: a 7-year-old Intel iGPU in a privacy
        // browser would otherwise get 4× MSAA, 320 resolution and far plant tiers; adaptive resolution still lifts sharpness.
        return isTouchDevice ? "low" : "medium";
    }
    const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
    const r = renderer.toLowerCase();

    // Apple GPU: non-touch = M-series Mac (high), touch = iPhone/iPad
    // iPadOS 13+ defaults to "Request Desktop Website" so UA reads "Macintosh" — detect via
    // navigator.platform + maxTouchPoints instead of the UA string (Macs never have touch points).
    if (r.includes("apple gpu")) {
        // Safari masks *every* Mac GPU as "Apple GPU", including 2017–2020 Intel Macs (Iris Plus / UHD 617 / UHD 630 /
        // Radeon Pro). Apple-designed GPUs (M-series, A-series) support ASTC textures; Intel and AMD Mac GPUs don't, so the
        // extension splits them. Intel/AMD Mac → medium (Radeon Pro would manage high, but can't be told apart from Iris).
        if (!isTouchDevice && !(navigator.maxTouchPoints > 1))
            return gl.getExtension("WEBGL_compressed_texture_astc") ? "high" : "medium";
        const isIpad =
            /ipad/i.test(navigator.userAgent) ||
            (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        return isIpad ? "high" : "medium";
    }

    // arc.{0,8} handles "Arc(TM) A770"; apple m\d+ is dead (apple gpu branch returns first, kept for clarity)
    // AMD: rx [5-9]\d{3} catches RX 5000-9000 (RDNA1-3); vega covers Vega 56/64; radeon vii is GCN5
    // Adreno 640+ (Snapdragon 865+, Galaxy S20 Ultra / Pixel 5 and above) are flagship mobile
    // Adreno 6[4-9]\d: 640 (S865 2020), 650 (S865+), 660 (S888 2021), 680/690 (S8 Gen1/2 2022/23)
    // xclipse covers Samsung Exynos 2200 "Xclipse 920" (RDNA2-based, S22 Ultra Exynos variant)
    // adreno.{0,8}x\d covers Snapdragon X Elite "Adreno X1-85" (2024 Copilot+ laptops)
    // Software rasterisers (GPU blocklisted / no driver / VM): everything must be minimal. Checked first — SwiftShader
    // strings can mention a real GPU vendor.
    if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) return "low";
    // rx (4[78]|5[789])0: Polaris RX 470/480/570/580/590 (2016–2019, ≈ GTX 1060) — the 3-digit names missed the RDNA rule
    const HIGH =
        /rtx|rx [5-9]\d{3}|rx (4[78]|5[789])0(?!\d)|vega [5-9]\d|radeon vii|gtx 1[0-9]{3}|gtx 9[5-9]\d|arc.{0,8}a[5-9]\d{2}|apple m\d+|adreno.{0,8}(6[4-9]\d|7\d{2}|8\d{2}|x\d)|xclipse/i;
    if (HIGH.test(renderer)) return "high";

    // Mali-G710/G715/G720 (Dimensity 9000+, high-end Oppo/Nothing/MediaTek) → medium
    // g7\d{2} matches G710-G799; (?!\d) prevents matching G7100+; must precede broad mali LOW
    if (/mali[-\s]g7\d{2}(?!\d)/i.test(renderer)) return "medium";
    // Mali-G72 (Galaxy S9/Note 8, 2017 flagship) lands medium not low — still handles medium quality
    if (/mali[-\s]g7[0-9](?!\d)/i.test(renderer)) return "medium";
    // Mali-G610/G615 (Dimensity 8000–8300, Tensor-class mid-range 2022+) ≈ G78 — must precede broad mali LOW
    if (/mali[-\s]g6[1-2]\d(?!\d)/i.test(renderer)) return "medium";
    // Adreno 610/612 (Snapdragon 665/680 budget phones, 2019–2022) are ≈ Adreno 506 — low despite the 6xx number
    if (/adreno.{0,8}61[0-2](?!\d)/i.test(renderer)) return "low";

    // uhd.{0,12} handles "UHD Graphics 630" (real ANGLE string) and "UHD 630"
    // adreno.{0,8} handles "Adreno (TM) 530" ANGLE wrapper format
    // mali[-\s] catches Mali-G31/G52/G57/G68/G71/G72/G76/G78, Mali-T, Mali-4xx (all low-end)
    // Adreno 3xx-5xx (mid/budget Android) → low; Adreno 615–630 (mid-range) fall through to medium
    // powervr / ge8xxx / img bxm: Imagination GPUs in budget MediaTek/Unisoc phones (e.g. "PowerVR Rogue GE8320")
    // Oppo/Nothing/Samsung expose the underlying Adreno or Mali name, not the brand — handled above
    // Intel (U)HD 620–640 (2017–2021 laptops) → medium; UHD 2xx–5xx, HD 4000–5xx, HD 610/615 remain low
    // "HD Graphics 620/630" is the same Kaby Lake chip as UHD 620/630 under older drivers/ANGLE builds
    if (/u?hd.{0,12}6[2-4]\d/i.test(renderer)) return "medium";
    // Intel Iris Plus (MacBook Air/Pro 2018–2020, Intel 11th gen) and Iris Xe (11th-13th gen) → medium
    if (/iris/i.test(renderer)) return "medium";
    // Adreno 530/540 (Snapdragon 820/835, Galaxy S7/S8 2016–2017) — 7-year threshold, capable of medium
    if (/adreno.{0,8}5[3-9]\d/i.test(renderer)) return "medium";
    const LOW =
        /(uhd.{0,12}[2-5]\d{2}|hd graphics)|mali[-\s]|adreno.{0,8}[3-5]\d{2}|videocore|powervr|ge8\d{3}|img bxm|sgx/i;
    if (LOW.test(renderer)) return "low";

    return "medium";
}

/** Instance count multiplier: 1.0 high, 0.65 medium, 0.50 low */
export const plantRadiusMul = () => (gpuTier === "low" ? 0.5 : gpuTier === "medium" ? 0.65 : 1.0);
