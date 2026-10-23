import * as THREE from "three";
import type { Planet } from "./planet";
import type { Player } from "./player";
import { type Landmark, LANDMARK_ICON } from "./landmarks";
import type { Spot } from "./spots";
import { U } from "./fx";

const W = 1024, H = 512;

// emoji icon per landmark kind — matches visual style of scouted locations

export class MapOverlay {
  visible = false;
  private container: HTMLDivElement;
  private bg: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private dotLon = 0;
  private dotLat = 0;
  private dotHeading = 0;
  private ctx: CanvasRenderingContext2D;
  private baseCanvas: HTMLCanvasElement | null = null;
  private landmarks: Landmark[] = [];
  private ungroupedSpots: Spot[] = [];
  private nightCanvas: HTMLCanvasElement;
  private nightCtx: CanvasRenderingContext2D;
  private nightBuf!: Uint8ClampedArray;
  private nightImageData!: ImageData;
  private lastSun = new THREE.Vector3(Infinity, 0, 0);

  setSpots(spots: Spot[]) {
    this.ungroupedSpots = spots.filter(s => !s.group);
  }

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

    document.body.appendChild(this.bg);
    document.body.appendChild(this.container);

    const OW = 256, OH = 128;
    this.nightCanvas = document.createElement("canvas");
    this.nightCanvas.width = OW;
    this.nightCanvas.height = OH;
    this.nightCtx = this.nightCanvas.getContext("2d")!;
    this.nightBuf = new Uint8ClampedArray(OW * OH * 4);
    this.nightImageData = new ImageData(OW, OH);

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
      this.updateDot();
      if (!this.baseCanvas) this.bakeBase();
      this.drawBase();
      this.updateDot();
    }
  }

  /** Call from frame loop while visible to keep the player dot and day/night overlay current. */
  tick() {
    if (!this.visible) return;
    if (!this.baseCanvas && this.planet.atlas?.done) this.bakeBase();
    this.drawBase();
    this.updateDot();
  }

  /** Call after planet rebuild to invalidate the cached base image. */
  reset() {
    this.baseCanvas = null;
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
    mat.dispose();
    geo.dispose();
    rt.dispose();

    // bake landmarks + spots into a static canvas — avoids per-frame putImageData + label redraws
    const bc = document.createElement("canvas");
    bc.width = W; bc.height = H;
    const bctx = bc.getContext("2d")!;
    bctx.putImageData(imgData, 0, 0);
    bctx.font = "14px sans-serif";
    bctx.textAlign = "center";
    for (const lm of this.landmarks) {
      const d = lm.pos.clone().normalize();
      const lat = Math.asin(Math.max(-1, Math.min(1, d.y)));
      const lon = Math.atan2(d.z, d.x);
      const px = ((lon / (Math.PI * 2)) + 0.5) * W;
      const py = (0.5 - lat / Math.PI) * H;
      const icon = LANDMARK_ICON[lm.name] ?? "📍";
      bctx.fillStyle = "rgba(0,0,0,0.55)";
      bctx.fillText(icon, px + 1, py + 5);
      bctx.fillStyle = "#fff";
      bctx.fillText(icon, px, py + 4);
      bctx.font = "bold 11px sans-serif";
      bctx.fillStyle = "rgba(0,0,0,0.65)";
      bctx.fillText(lm.label, px + 1, py + 16);
      bctx.fillStyle = "#e8e4d0";
      bctx.fillText(lm.label, px, py + 15);
      bctx.font = "14px sans-serif";
    }
    for (const sp of this.ungroupedSpots) {
      const lat = Math.asin(Math.max(-1, Math.min(1, sp.dir.y)));
      const lon = Math.atan2(sp.dir.z, sp.dir.x);
      const px = ((lon / (Math.PI * 2)) + 0.5) * W;
      const py = (0.5 - lat / Math.PI) * H;
      bctx.fillStyle = "rgba(0,0,0,0.55)";
      bctx.fillText(sp.icon, px + 1, py + 5);
      bctx.fillStyle = "#fff";
      bctx.fillText(sp.icon, px, py + 4);
      bctx.font = "bold 11px sans-serif";
      bctx.fillStyle = "rgba(0,0,0,0.65)";
      bctx.fillText(sp.name, px + 1, py + 16);
      bctx.fillStyle = "#e8e4d0";
      bctx.fillText(sp.name, px, py + 15);
      bctx.font = "14px sans-serif";
    }
    this.baseCanvas = bc;
  }

  private drawNightOverlay() {
    const sun = U.uSun.value;
    // skip pixel rebuild if sun hasn't moved noticeably
    if (sun.distanceToSquared(this.lastSun) > 1e-6) {
      this.lastSun.copy(sun);
      const OW = this.nightCanvas.width, OH = this.nightCanvas.height;
      const buf = this.nightBuf;
      for (let y = 0; y < OH; y++) {
        const lat = (0.5 - y / OH) * Math.PI;
        const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
        for (let x = 0; x < OW; x++) {
          const lon = (x / OW - 0.5) * Math.PI * 2;
          const dx = cosLat * Math.cos(lon), dy = sinLat, dz = cosLat * Math.sin(lon);
          const dot = dx * sun.x + dy * sun.y + dz * sun.z;
          const t = 1 - Math.max(0, Math.min(1, (dot + 0.07) / 0.14));
          const alpha = Math.round(t * 148);
          const i = (y * OW + x) * 4;
          buf[i] = 0; buf[i+1] = 0; buf[i+2] = 8; buf[i+3] = alpha;
        }
      }
      this.nightImageData.data.set(buf);
      this.nightCtx.putImageData(this.nightImageData, 0, 0);
    }
    this.ctx.drawImage(this.nightCanvas, 0, 0, W, H);
  }

  private drawBase() {
    if (this.baseCanvas) {
      this.ctx.drawImage(this.baseCanvas, 0, 0, W, H);
    } else {
      this.ctx.fillStyle = "#0d0c10";
      this.ctx.fillRect(0, 0, W, H);
      this.ctx.fillStyle = "rgba(201,173,115,.7)";
      this.ctx.font = "18px sans-serif";
      this.ctx.textAlign = "center";
      this.ctx.fillText("Map building — open again in a moment", W / 2, H / 2);
    }
    this.drawNightOverlay();
    this.drawDot();
    this.drawCompass();
  }

  private drawCompass() {
    const ctx = this.ctx;
    const cx = W - 36, cy = 36, r = 22;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 6;
    // N arrow (points to top of map = north pole)
    ctx.fillStyle = "#e84444";
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + 6, cy);
    ctx.lineTo(cx, cy - 4);
    ctx.lineTo(cx - 6, cy);
    ctx.closePath();
    ctx.fill();
    // S arrow
    ctx.fillStyle = "#cccccc";
    ctx.beginPath();
    ctx.moveTo(cx, cy + r);
    ctx.lineTo(cx + 6, cy);
    ctx.lineTo(cx, cy + 4);
    ctx.lineTo(cx - 6, cy);
    ctx.closePath();
    ctx.fill();
    // N label
    ctx.shadowBlur = 3;
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("N", cx, cy - r - 4);
    ctx.restore();
  }

  private drawDot() {
    const px = ((this.dotLon / (Math.PI * 2)) + 0.5) * W;
    const py = (0.5 - this.dotLat / Math.PI) * H;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(this.dotHeading * Math.PI / 180);
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 4;
    ctx.fillStyle = "#ee8844";
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.lineTo(10, 10);
    ctx.lineTo(0, 4);
    ctx.lineTo(-10, 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private updateDot() {
    const up = this.player.dir;
    this.dotLat = Math.asin(Math.max(-1, Math.min(1, up.y)));
    this.dotLon = Math.atan2(up.z, up.x);
    const fwd = this.player.forward;
    const eastX = -Math.sin(this.dotLon), eastZ = Math.cos(this.dotLon);
    const northX = -Math.sin(this.dotLat) * Math.cos(this.dotLon),
          northY = Math.cos(this.dotLat),
          northZ = -Math.sin(this.dotLat) * Math.sin(this.dotLon);
    const e = fwd.x * eastX + fwd.z * eastZ;
    const n = fwd.x * northX + fwd.y * northY + fwd.z * northZ;
    this.dotHeading = Math.atan2(e, n) * (180 / Math.PI);
  }
}
