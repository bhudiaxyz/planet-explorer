// GPU tier classifier self-check against real device renderer strings. Run: npm run test:tiers
import assert from "node:assert/strict";
const setEnv = (coarse: boolean, touchPoints = 0, platform = "Win32", ua = "Mozilla/5.0") => {
    (globalThis as any).window = coarse ? { ontouchstart: null } : {};
    (globalThis as any).matchMedia = (q: string) => ({
        media: q,
        matches: coarse && q.includes("coarse"),
    });
    Object.defineProperty(globalThis, "navigator", {
        value: { maxTouchPoints: touchPoints, platform, userAgent: ua },
        configurable: true,
    });
};
const gl = (renderer: string | null, astc = false) => ({
    getExtension: (n: string) =>
        n === "WEBGL_debug_renderer_info"
            ? renderer === null
                ? null
                : { UNMASKED_RENDERER_WEBGL: 1 }
            : n === "WEBGL_compressed_texture_astc"
              ? astc
                  ? {}
                  : null
              : null,
    getParameter: () => renderer,
});
const load = async (tag: string) =>
    (await import(
        new URL("../src/render/gputier.ts", import.meta.url).href + "?" + tag
    )) as typeof import("../src/render/gputier.ts");
const cases: [string, string | null, boolean, number, string, boolean, string][] = [
    // label, renderer, coarse, touchPoints, platform, astc, expected
    [
        "RTX 4090 desktop",
        "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        false,
        0,
        "Win32",
        false,
        "high",
    ],
    [
        "GTX 1060 (2016)",
        "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)",
        false,
        0,
        "Win32",
        false,
        "high",
    ],
    [
        "RX 580 Polaris",
        "ANGLE (AMD, Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)",
        false,
        0,
        "Win32",
        false,
        "high",
    ],
    [
        "RX 560 (weak Polaris)",
        "ANGLE (AMD, Radeon RX 560 Series Direct3D11 vs_5_0 ps_5_0, D3D11)",
        false,
        0,
        "Win32",
        false,
        "medium",
    ],
    [
        "RX 6700 XT",
        "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
        false,
        0,
        "Win32",
        false,
        "high",
    ],
    [
        "UHD 620 laptop",
        "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        false,
        0,
        "Win32",
        false,
        "medium",
    ],
    [
        "HD 620 laptop (old driver)",
        "ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        false,
        0,
        "Win32",
        false,
        "medium",
    ],
    [
        "HD 4000 (2012)",
        "ANGLE (Intel, Intel(R) HD Graphics 4000 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        false,
        0,
        "Win32",
        false,
        "low",
    ],
    [
        "Iris Xe",
        "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
        false,
        0,
        "Win32",
        false,
        "medium",
    ],
    [
        "Touchscreen laptop UHD 630 (fine pointer)",
        "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        false,
        10,
        "Win32",
        false,
        "medium",
    ],
    ["M1 Mac Safari", "Apple GPU", false, 0, "MacIntel", true, "high"],
    ["Intel Mac Safari 2019", "Apple GPU", false, 0, "MacIntel", false, "medium"],
    [
        "M2 Mac Chrome",
        "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
        false,
        0,
        "MacIntel",
        true,
        "high",
    ],
    ["iPad desktop-mode Safari", "Apple GPU", true, 5, "MacIntel", true, "high"],
    ["iPhone", "Apple GPU", true, 5, "iPhone", true, "medium"],
    ["Galaxy S22 Ultra Snapdragon", "Adreno (TM) 730", true, 5, "Linux armv8l", true, "high"],
    ["Galaxy S22 Ultra Exynos", "Samsung Xclipse 920", true, 5, "Linux armv8l", true, "high"],
    ["Galaxy S20 (Adreno 650)", "Adreno (TM) 650", true, 5, "Linux armv8l", true, "high"],
    ["Galaxy S10 (Adreno 640)", "Adreno (TM) 640", true, 5, "Linux armv8l", true, "high"],
    ["Galaxy S9 Exynos (Mali-G72)", "Mali-G72", true, 5, "Linux armv8l", true, "medium"],
    ["Galaxy S8 (Adreno 540)", "Adreno (TM) 540", true, 5, "Linux armv8l", true, "medium"],
    ["Pixel 3a (Adreno 615)", "Adreno (TM) 615", true, 5, "Linux armv8l", true, "medium"],
    ["Budget SD665 (Adreno 610)", "Adreno (TM) 610", true, 5, "Linux armv8l", true, "low"],
    ["Dimensity 8100 (Mali-G610)", "Mali-G610 MC6", true, 5, "Linux armv8l", true, "medium"],
    ["Budget Mali-G52", "Mali-G52 MC2", true, 5, "Linux armv8l", true, "low"],
    ["PowerVR GE8320 budget", "PowerVR Rogue GE8320", true, 5, "Linux armv8l", true, "low"],
    [
        "SwiftShader",
        "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
        false,
        0,
        "Win32",
        false,
        "low",
    ],
    ["Blocked ext desktop", null, false, 0, "Win32", false, "medium"],
    ["Blocked ext mobile", null, true, 5, "Linux armv8l", false, "low"],
];
let fails = 0,
    i = 0;
for (const [label, r, coarse, tp, plat, astc, want] of cases) {
    setEnv(coarse, tp, plat);
    const m = await load(String(i++));
    const got = m.detectGpuTier(gl(r, astc) as any);
    const ok = got === want;
    if (!ok) fails++;
    console.log(
        `${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : " (want " + want + ")"}  touch=${m.isTouchDevice}`
    );
}
assert.equal(fails, 0, `${fails} tier cases failed`);
