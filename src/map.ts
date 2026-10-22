import * as THREE from "three";
import type { Planet } from "./planet";
import type { Player } from "./player";

const W = 1024, H = 512;

export class MapOverlay {
  visible = false;
  private container: HTMLDivElement;
  private bg: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private dot: HTMLDivElement;
  private ctx: CanvasRenderingContext2D;
  private baseImageData: ImageData | null = null;

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

  /** Call from frame loop while visible to keep the player dot current. */
  tick() {
    if (this.visible) this.updateDot();
  }

  /** Call after planet rebuild to invalidate the cached base image. */
  reset() {
    this.baseImageData = null;
  }

  private bakeBase() {
    const atlas = this.planet.atlas;
    if (!atlas?.done) return;

    const rt = new THREE.WebGLRenderTarget(W, H, {
      type: THREE.UnsignedByteType,
      depthBuffer: false,
    });
    const mat = new THREE.ShaderMaterial({
      uniforms: { uCube: { value: atlas.rtC.texture } },
      vertexShader: `void main() { gl_Position = vec4(position.xy, 0., 1.); }`,
      fragmentShader: `
        uniform samplerCube uCube;
        // ACES filmic approximation (matches renderer.toneMapping = ACESFilmicToneMapping)
        vec3 aces(vec3 x) {
          return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0);
        }
        void main() {
          vec2 uv = gl_FragCoord.xy / vec2(${W}.0, ${H}.0);
          float lon = (uv.x - .5) * 6.283185307;
          float lat = (uv.y - .5) * 3.141592654;
          vec3 dir = vec3(cos(lat)*cos(lon), sin(lat), cos(lat)*sin(lon));
          vec4 col = textureCube(uCube, dir);
          col.rgb = aces(col.rgb);
          col.rgb = pow(col.rgb, vec3(1.0/2.2)); // linear → sRGB
          // boost saturation
          float luma = dot(col.rgb, vec3(0.299, 0.587, 0.114));
          col.rgb = mix(vec3(luma), col.rgb, 1.5);
          gl_FragColor = col;
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
  }

  private updateDot() {
    const d = this.player.up;
    const lat = Math.asin(Math.max(-1, Math.min(1, d.y)));
    const lon = Math.atan2(d.z, d.x);
    this.dot.style.left = `${((lon / (Math.PI * 2)) + 0.5) * 100}%`;
    this.dot.style.top  = `${(0.5 - lat / Math.PI) * 100}%`;
  }
}
