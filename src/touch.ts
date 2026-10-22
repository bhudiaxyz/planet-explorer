import nipplejs from "nipplejs";
import type { Player } from "./player";
import { S } from "./settings";

export const isTouchDevice = "ontouchstart" in window;

const STYLE = `
#touch-btns {
  position: fixed; right: max(20px, env(safe-area-inset-right)); bottom: max(110px, calc(80px + env(safe-area-inset-bottom)));
  display: flex; flex-direction: column; gap: 14px;
  pointer-events: auto; z-index: 10;
}
#touch-btns button {
  width: 60px; height: 60px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.32);
  background: rgba(0,0,0,0.45); color: #fff;
  font-size: 22px; line-height: 1; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  user-select: none; touch-action: none;
}
#touch-btns button:active { background: rgba(255,255,255,0.28); }
#touch-roll {
  position: fixed; right: max(90px, calc(70px + env(safe-area-inset-right))); bottom: max(110px, calc(80px + env(safe-area-inset-bottom)));
  display: flex; flex-direction: column; gap: 14px;
  pointer-events: auto; z-index: 10;
}
#touch-roll button {
  width: 50px; height: 50px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.22);
  background: rgba(0,0,0,0.38); color: #fff;
  font-size: 18px; line-height: 1; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  user-select: none; touch-action: none;
}
#touch-roll button:active { background: rgba(255,255,255,0.22); }
#btn-gui {
  position: fixed; left: 20px; top: 20px;
  width: 48px; height: 48px; border-radius: 12px;
  border: 2px solid rgba(255,255,255,0.32);
  background: rgba(0,0,0,0.45); color: #fff;
  font-size: 18px; cursor: pointer; pointer-events: auto;
  -webkit-tap-highlight-color: transparent;
  user-select: none; display: none; z-index: 10;
}
/* nipplejs zone covers left half */
#joy-zone {
  position: fixed; left: 0; top: 0;
  width: 50%; height: 100%;
  z-index: 5; touch-action: none;
}
`;

/** Wire up nipplejs joystick + swipe-look for touch devices. No-ops on desktop. */
export function setupTouch(player: Player, dom: HTMLElement): void {
  if (!isTouchDevice) return;

  const s = document.createElement("style");
  s.textContent = STYLE;
  document.head.appendChild(s);

  // Left-half joystick zone
  const joyZone = document.createElement("div");
  joyZone.id = "joy-zone";
  document.body.appendChild(joyZone);

  // Action buttons (right side)
  const btns = document.createElement("div");
  btns.id = "touch-btns";
  btns.innerHTML = `
    <button id="btn-map"     aria-label="Map">🗺️</button>
    <button id="btn-jump"    aria-label="Ascend">↑</button>
    <button id="btn-descend" aria-label="Descend">↓</button>
    <button id="btn-sprint"  aria-label="Sprint">⚡</button>
    <button id="btn-fly"     aria-label="Toggle fly">✈</button>
    <button id="btn-land"    aria-label="Land">🛬</button>
  `;
  document.body.appendChild(btns);

  // Roll buttons (fly mode only, shown left of action buttons)
  const rollBtns = document.createElement("div");
  rollBtns.id = "touch-roll";
  rollBtns.innerHTML = `
    <button id="btn-roll-left"  aria-label="Roll left">⟲</button>
    <button id="btn-roll-right" aria-label="Roll right">⟳</button>
  `;
  document.body.appendChild(rollBtns);

  // GUI toggle button
  const btnGui = document.createElement("button");
  btnGui.id = "btn-gui";
  btnGui.textContent = "☰";
  btnGui.setAttribute("aria-label", "Settings");
  btnGui.style.display = "block";
  document.body.appendChild(btnGui);

  // ---- nipplejs joystick -------------------------------------------------------
  const manager = nipplejs.create({
    zone: joyZone,
    mode: "dynamic",
    restOpacity: 0.6,
    color: "white",
    size: 110,
  });

  manager.on("move", (evt) => {
    const v = (evt.data as { vector?: { x: number; y: number } }).vector;
    if (!v) return;
    player.touchStrafe = v.x;
    player.touchMove   = v.y; // nipplejs y: up=+1
  });
  manager.on("end", () => {
    player.touchMove = player.touchStrafe = 0;
  });

  // ---- right-half swipe-to-look ------------------------------------------------
  let lookId: number | null = null;
  let prevLook = { x: 0, y: 0 };

  dom.addEventListener("touchstart", e => {
    e.preventDefault();
    // Validate that any previously tracked touch is still active before accepting a new one
    if (lookId !== null) {
      const stillActive = Array.from(e.touches).some(t => t.identifier === lookId);
      if (!stillActive) lookId = null;
    }
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX >= innerWidth / 2 && lookId === null) {
        lookId = t.identifier;
        prevLook = { x: t.clientX, y: t.clientY };
      }
    }
  }, { passive: false });

  dom.addEventListener("touchmove", e => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === lookId) {
        player.look((t.clientX - prevLook.x) * S.touchLookSensitivity, (t.clientY - prevLook.y) * S.touchLookSensitivity);
        prevLook = { x: t.clientX, y: t.clientY };
      }
    }
  }, { passive: false });

  dom.addEventListener("touchend",    e => { for (const t of Array.from(e.changedTouches)) if (t.identifier === lookId) lookId = null; }, { passive: true });
  dom.addEventListener("touchcancel", e => { for (const t of Array.from(e.changedTouches)) if (t.identifier === lookId) lookId = null; }, { passive: true });

  // ---- buttons -----------------------------------------------------------------
  const btn = (id: string, down: () => void, up: () => void) => {
    const el = document.getElementById(id)!;
    el.addEventListener("touchstart",  e => { e.stopPropagation(); down(); }, { passive: true });
    el.addEventListener("touchend",    e => { e.stopPropagation(); up(); },   { passive: true });
    el.addEventListener("touchcancel", e => { e.stopPropagation(); up(); },   { passive: true });
  };
  btn("btn-jump",       () => { player.touchJump      = true;  }, () => { player.touchJump      = false; });
  btn("btn-descend",    () => { player.touchDescend   = true;  }, () => { player.touchDescend   = false; });
  btn("btn-sprint",     () => { player.touchSprint    = true;  }, () => { player.touchSprint    = false; });
  btn("btn-roll-left",  () => { player.touchRollLeft  = true;  }, () => { player.touchRollLeft  = false; });
  btn("btn-roll-right", () => { player.touchRollRight = true;  }, () => { player.touchRollRight = false; });
  document.getElementById("btn-fly")!.addEventListener("touchend", e => {
    e.stopPropagation(); player.toggle();
  });
  document.getElementById("btn-land")!.addEventListener("touchend", e => {
    e.stopPropagation(); if (player.mode !== "walk") player.land();
  });

  // Show/hide buttons based on player mode
  const btnLand = document.getElementById("btn-land")!;
  const touchRoll = document.getElementById("touch-roll")!;
  const show = (el: HTMLElement, visible: boolean) =>
    el.style.display = visible ? "" : "none";
  show(btnLand, false);
  show(touchRoll, false);
  const updateButtons = () => {
    show(btnLand,   player.mode !== "walk");
    show(touchRoll, player.mode === "fly");
    requestAnimationFrame(updateButtons);
  };
  requestAnimationFrame(updateButtons);

  // Update controls hint
  const hint = document.getElementById("ls-controls");
  if (hint) hint.textContent = "Left thumb · steer/move  ·  Right drag · look  ·  ↑ ascend  ·  ↓ descend  ·  ⟲⟳ roll (fly)  ·  ⚡ sprint  ·  ✈ cycle mode  ·  🛬 land  ·  🗺️ map  ·  ☰ settings";
}

/** Wire the GUI toggle button to show/hide lil-gui. Called from main after setupGui. */
export function setGuiToggle(fn: () => void): void {
  document.getElementById("btn-gui")?.addEventListener("touchend", e => {
    e.stopPropagation(); fn();
  });
}

/** Wire the map button. Called from main after MapOverlay is created. */
export function setMapToggle(fn: () => void): void {
  document.getElementById("btn-map")?.addEventListener("touchend", e => {
    e.stopPropagation(); fn();
  });
}
