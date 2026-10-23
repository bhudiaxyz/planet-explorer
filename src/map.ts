import * as THREE from "three";
import type { Planet } from "./planet";
import type { Player } from "./player";
import type { Landmark } from "./landmarks";
import type { Spot } from "./spots";
import { U } from "./fx";

const W = 1024, H = 512;

// emoji icon per landmark kind — matches visual style of scouted locations
const LANDMARK_ICON: Record<string, string> = {
  "monolith ring":   "🗿",
  "twisted spire":   "⛰️",
  "tombstone field": "🪦",
  "floating island": "🏝️",
};

export class MapOverlay {
  visible = false;
  private container: HTMLDivElement;
  private bg: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private dot: HTMLDivElement;
  private ctx: CanvasRenderingContext2D;
  private baseImageData: ImageData | null = null;
  private landmarks: Landmark[] = [];
  private spots: Spot[] = [];

  setSpots(spots: Spot[]) { this.spots = spots; }

  constructor(
    private renderer: THREE.WebGLRenderer,
    private planet: Planet,
    private player: Player,
  ) {
    this.bg = document.createElement("div");
    Object.assign(this.bg.style, {
      position: "fixed", inset: "0",
      background: "rgba(0,0,0,0.72)",
      display: "none", zIndex: "39",
    });

    this.canvas = document.createElement("canvas");
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext("2d")!;

    this.dot = document.createElement("div");
    Object.assign(this.dot.style, {
      position: "absolute",
      width: "12px", height: "12px",
      borderRadius: "50%",
      background: "#e84",
      border: "2px solid #fff",
      boxShadow: "0 0 6px rgba(0,0,0,.8)",
      transform: "translate(-50%,-50%)",
      pointerEvents: "none",
      zIndex: "1",
    });

    this.container = document.createElement("div");
    Object.assign(this.container.style, {
      position: "fixed",
      top: "50%", left: "50%",
      transform: "translate(-50%,-50%)",
      width: "min(55vw, 110vh)",
      height: "min(28vw, 55vh)",
      display: "none", zIndex: "40",
      border: "1px solid rgba(201,173,115,.4)",
      borderRadius: "4px",
      overflow: "hidden",
    });
    this.canvas.style.cssText = "width:100%;height:100%;display:block;";
    this.container.appendChild(this.canvas);
    this.container.appendChild(this.dot);

    document.body.appendChild(this.bg);
    document.body.appendChild(this.container);

    addEventListener("keydown", e => {
      if (e.code === "Escape" && this.visible) this.toggle();
    });
  }

  toggle() {
    this.visible = !this.visible;
    const d = this.visible ? "block" : "none";
    this.bg.style.display = d;
    this.container.style.display = d;
    if (this.visible) {
      if (!this.baseImageData) this.bakeBase();
      this.drawBase();
      this.updateDot();
    }
  }

  /** Call from frame loop while visible to keep the player dot and day/night overlay current. */
  tick() {
    if (!this.visible) return;
    if (!this.baseImageData && this.planet.atlas?.done) this.bakeBase();
    this.drawBase();
    this.updateDot();
  }

  /** Call after planet rebuild to invalidate the cached base image. */
  reset() {
    this.baseImageData = null;
  }

  private bakeBase() {
    const atlas = this.planet.atlas;
    if (!atlas?.done) return;
    this.landmarks = this.planet.landmarks?.list ?? [];

    const rt = new THREE.WebGLRenderTarget(W, H, {
      type: THREE.UnsignedByteType,
      depthBuffer: false,
    });
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCube:  { value: atlas.rtC.texture },
        uCubeN: { value: atlas.rtN.texture },
      },
      vertexShader: `void main() { gl_Position = vec4(position.xy, 0., 1.); }`,
      fragmentShader: `
        uniform samplerCube uCube;
        uniform samplerCube uCubeN;
        void main() {
          vec2 uv = gl_FragCoord.xy / vec2(${W}.0, ${H}.0);
          float lon = (uv.x - .5) * 6.283185307;
          float lat = (uv.y - .5) * 3.141592654;
          vec3 dir = vec3(cos(lat)*cos(lon), sin(lat), cos(lat)*sin(lon));
          vec4 col = textureCube(uCube, dir);
          vec4 nm  = textureCube(uCubeN, dir);
          // atlas colours are already LDR — just gamma-correct
          col.rgb = pow(max(col.rgb, vec3(0.)), vec3(1.0/2.2));
          // normal-based shading: fixed sun from upper-left + AO
          vec3 sun = normalize(vec3(-0.5, 1.0, -0.3));
          float diff = clamp(dot(nm.xyz, sun), 0., 1.);
          float ao   = nm.w;
          col.rgb *= mix(0.55, 1.0, diff) * mix(0.75, 1.0, ao);
          // saturation boost
          float luma = dot(col.rgb, vec3(0.299, 0.587, 0.114));
          col.rgb = mix(vec3(luma), col.rgb, 1.4);
          gl_FragColor = vec4(col.rgb, 1.);
        }`,
    });
    const geo = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geo, mat);
    const scene = new THREE.Scene();
    scene.add(mesh);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const prevRT = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.render(scene, cam);

    const buf = new Uint8Array(W * H * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    this.renderer.setRenderTarget(prevRT);

    // WebGL origin is bottom-left; canvas is top-left — flip Y
    const imgData = this.ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W * 4;
      imgData.data.set(buf.subarray(src, src + W * 4), y * W * 4);
    }
    this.baseImageData = imgData;

    mat.dispose();
    geo.dispose();
    rt.dispose();
  }

  private drawNightOverlay() {
    // low-res overlay (bilinear upscale gives soft terminator edge)
    const OW = 256, OH = 128;
    const sun = U.uSun.value;
    const buf = new Uint8ClampedArray(OW * OH * 4);
    for (let y = 0; y < OH; y++) {
      const lat = (0.5 - y / OH) * Math.PI;
      const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
      for (let x = 0; x < OW; x++) {
        const lon = (x / OW - 0.5) * Math.PI * 2;
        const dx = cosLat * Math.cos(lon), dy = sinLat, dz = cosLat * Math.sin(lon);
        const dot = dx * sun.x + dy * sun.y + dz * sun.z;
        // smoothstep terminator: fully dark at dot < -0.07, fully lit at dot > 0.07
        const t = 1 - Math.max(0, Math.min(1, (dot + 0.07) / 0.14));
        const alpha = Math.round(t * 148); // max ~58% dark
        const i = (y * OW + x) * 4;
        buf[i] = 0; buf[i+1] = 0; buf[i+2] = 8; buf[i+3] = alpha;
      }
    }
    const off = document.createElement("canvas");
    off.width = OW; off.height = OH;
    const octx = off.getContext("2d")!;
    octx.putImageData(new ImageData(buf, OW, OH), 0, 0);
    this.ctx.drawImage(off, 0, 0, W, H);
  }

  private drawBase() {
    if (this.baseImageData) {
      this.ctx.putImageData(this.baseImageData, 0, 0);
    } else {
      this.ctx.fillStyle = "#0d0c10";
      this.ctx.fillRect(0, 0, W, H);
      this.ctx.fillStyle = "rgba(201,173,115,.7)";
      this.ctx.font = "18px sans-serif";
      this.ctx.textAlign = "center";
      this.ctx.fillText("Map building — open again in a moment", W / 2, H / 2);
    }
    this.drawNightOverlay();
    // draw landmark icons — same emoji style as scouted locations
    this.ctx.font = "14px sans-serif";
    this.ctx.textAlign = "center";
    for (const lm of this.landmarks) {
      const d = lm.pos.clone().normalize();
      const lat = Math.asin(Math.max(-1, Math.min(1, d.y)));
      const lon = Math.atan2(d.z, d.x);
      const px = ((lon / (Math.PI * 2)) + 0.5) * W;
      const py = (0.5 - lat / Math.PI) * H;
      const icon = LANDMARK_ICON[lm.name] ?? "📍";
      this.ctx.fillStyle = "rgba(0,0,0,0.55)";
      this.ctx.fillText(icon, px + 1, py + 5);
      this.ctx.fillStyle = "#fff";
      this.ctx.fillText(icon, px, py + 4);
      this.ctx.font = "bold 11px sans-serif";
      this.ctx.fillStyle = "rgba(0,0,0,0.65)";
      this.ctx.fillText(lm.label, px + 1, py + 16);
      this.ctx.fillStyle = "#e8e4d0";
      this.ctx.fillText(lm.label, px, py + 15);
      this.ctx.font = "14px sans-serif";
    }
    // draw scouted locations
    this.ctx.font = "14px sans-serif";
    for (const sp of this.spots) {
      const lat = Math.asin(Math.max(-1, Math.min(1, sp.dir.y)));
      const lon = Math.atan2(sp.dir.z, sp.dir.x);
      const px = ((lon / (Math.PI * 2)) + 0.5) * W;
      const py = (0.5 - lat / Math.PI) * H;
      // shadow then icon emoji
      this.ctx.fillStyle = "rgba(0,0,0,0.55)";
      this.ctx.fillText(sp.icon, px + 1, py + 5);
      this.ctx.fillStyle = "#fff";
      this.ctx.fillText(sp.icon, px, py + 4);
      // name label
      this.ctx.font = "bold 11px sans-serif";
      this.ctx.fillStyle = "rgba(0,0,0,0.65)";
      this.ctx.fillText(sp.name, px + 1, py + 16);
      this.ctx.fillStyle = "#e8e4d0";
      this.ctx.fillText(sp.name, px, py + 15);
      this.ctx.font = "14px sans-serif";
    }
  }

  private updateDot() {
    const d = this.player.up;
    const lat = Math.asin(Math.max(-1, Math.min(1, d.y)));
    const lon = Math.atan2(d.z, d.x);
    this.dot.style.left = `${((lon / (Math.PI * 2)) + 0.5) * 100}%`;
    this.dot.style.top  = `${(0.5 - lat / Math.PI) * 100}%`;
  }
}
