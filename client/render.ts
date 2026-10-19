// The world renderer: Canvas 2D, its own requestAnimationFrame loop, reading
// the client's state directly. Everything is drawn procedurally from a small
// visual bible (rounded forms, a soft dark outline, warm light from the upper
// left, one palette per stage that drains toward its "dead" colour as tiles
// lose life), so every asset is code in this file and replaceable in one place.
import { BUILDINGS, CLAIM_SIZE, LINES, STAGES, itemLabel, type BuildingType, type Family, type LineKind, type StageDef } from "../shared/content.ts";
import type { Building, Lobbyist, Player, Snapshot, Tile } from "../shared/protocol.ts";
import { averageLife, buildCost, claimProblem, effectiveLife, lifeCap, placementProblem, shortfalls } from "../shared/sim.ts";
import { DIRS, claimAt, linePathProblem, route } from "../shared/layout.ts";
import { complete, isIdle, isRunning } from "../shared/world.ts";
import type { RoomState } from "../shared/protocol.ts";
import { TH, TW, screenToTile, toScreen, toWorld, type Camera } from "./iso.ts";
import type { GameClient } from "./net.ts";

export type Tool = "harvest" | "build" | "inspect" | "demolish" | "mark" | "claim" | "line" | "tend";

export interface View {
  tool: Tool;
  build: BuildingType | null;
  /** build the efficient version (costs parts, kit built in) */
  eff: boolean;
  /** the line being laid: its kind, quality, and the start tile once one is picked */
  line: { kind: LineKind; q: 0 | 1; from: [number, number] | null } | null;
  /** show cables, pipes and belts over everything */
  networks: boolean;
  hover: [number, number] | null;
  /** keyboard placement: the tile in front of the avatar, used when the mouse is idle */
  keyboardTarget: boolean;
  /** the last pointer was a finger or pen: the target is the aimed tile, not the hover */
  touch: boolean;
  /** touch only: the tile tapped once, previewed until a second tap or the touch bar confirms */
  aim: [number, number] | null;
  survey: boolean;
  selected: number | null;
  reducedMotion: boolean;
  low: boolean;
  zoom: number;
}

export const PLAYER_COLOURS = ["#e8735a", "#4f9de0", "#f2c14e", "#8fcf6a", "#b47ce0", "#f08ab8", "#4fc6b8", "#c9905a"];
const OUTLINE = "rgba(40,30,40,0.55)";

const mix = (a: [number, number, number], b: [number, number, number], k: number): string =>
  `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)})`;

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number): number => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

const hash = (i: number): number => {
  let h = i * 374761393;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

interface Fx {
  x: number;
  y: number;
  t0: number;
  text?: string;
  colour: string;
  kind: "pop" | "dust" | "smoke";
  vx: number;
  vy: number;
}

const BUILD_LOOK: Record<BuildingType, { colour: string; roof: string; h: number }> = {
  extractor: { colour: "#d9a441", roof: "#8a5a2b", h: 14 },
  furnace: { colour: "#a35d4a", roof: "#5b3a35", h: 22 },
  solar: { colour: "#3d5a8a", roof: "#7fb2ff", h: 4 },
  city: { colour: "#f3e2c7", roof: "#d0664f", h: 26 },
  datacentre: { colour: "#5a6170", roof: "#2e333d", h: 30 },
  habitat: { colour: "#d8e6ee", roof: "#9fc8de", h: 22 },
  radiator: { colour: "#8b8f99", roof: "#ff7a4d", h: 16 },
  relay: { colour: "#c7cbd6", roof: "#6fd0ff", h: 30 },
  plaza: { colour: "#e0c99a", roof: "#e8735a", h: 4 },
  depot: { colour: "#a58a5c", roof: "#6b5a3a", h: 24 },
  engine: { colour: "#6b6f88", roof: "#c9c4ff", h: 28 },
  factory: { colour: "#b98b5e", roof: "#6a7d8c", h: 24 },
  store: { colour: "#c9a36b", roof: "#8a6a3a", h: 10 },
  intake: { colour: "#7fa6b8", roof: "#3d6a80", h: 12 },
};

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  cam: Camera = { x: 0, y: 0, zoom: 1, w: 800, h: 600 };
  private fx: Fx[] = [];
  private last = performance.now();
  private raf = 0;
  private boundaryAt = 0;
  private cap = 100;
  private hint: { text: string; x: number; y: number } | null = null;
  frameMs = 0;
  private canvas: HTMLCanvasElement;
  private client: GameClient;
  private view: View;

  constructor(canvas: HTMLCanvasElement, client: GameClient, view: View) {
    this.canvas = canvas;
    this.client = client;
    this.view = view;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    client.onTile = (i, before, after) => this.tileFx(i, before - after);
    client.onBoundary = () => {
      this.boundaryAt = performance.now();
      this.fx = [];
    };
  }

  start(): void {
    const loop = (now: number): void => {
      this.frame(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  pick(sx: number, sy: number): [number, number] {
    return screenToTile(this.cam, sx, sy);
  }

  /** The front-most building whose drawn volume (not just its footprint) is under the pointer. */
  pickBuilding(sx: number, sy: number): Building | null {
    const s = this.client.state;
    if (!s) return null;
    let best: Building | null = null;
    let depth = -Infinity;
    for (const b of s.buildings) {
      const n = BUILDINGS[b.type].size;
      const [T, R, B, L] = this.corners(b.x, b.y, n);
      const h = BUILD_LOOK[b.type].h * this.cam.zoom + (b.type === "habitat" || b.type === "engine" ? 14 * this.cam.zoom : 0);
      const hex: [number, number][] = [[T[0], T[1] - h], [R[0], R[1] - h], R, B, L, [L[0], L[1] - h]];
      let inside = false;
      for (let i = 0, j = hex.length - 1; i < hex.length; j = i++) {
        const [xi, yi] = hex[i];
        const [xj, yj] = hex[j];
        if (yi > sy !== yj > sy && sx < ((xj - xi) * (sy - yi)) / (yj - yi) + xi) inside = !inside;
      }
      const d = b.x + b.y + (n - 1) * 2;
      if (inside && d > depth) [best, depth] = [b, d];
    }
    return best;
  }

  /** The tile in front of the avatar: where keyboard building and harvesting aim. */
  facingTile(): [number, number] | null {
    const s = this.client.state;
    const p = s?.players[this.client.you];
    if (!s || !p) return null;
    const a = (p.facing / 8) * Math.PI * 2;
    return [Math.round(this.client.me.x + Math.cos(a) * 1.2), Math.round(this.client.me.y + Math.sin(a) * 1.2)];
  }

  target(): [number, number] | null {
    return this.view.keyboardTarget ? this.facingTile() : this.view.touch ? this.view.aim : this.view.hover;
  }

  private tileFx(i: number, amount: number): void {
    const s = this.client.state;
    if (!s || this.view.low) return;
    const st = STAGES[s.stage];
    const t = s.tiles[i];
    const x = i % s.w;
    const y = Math.floor(i / s.w);
    const colour = t.d ? st.palette[t.d] : "#fff";
    this.fx.push({ x, y, t0: performance.now(), text: `+${amount} ${t.d ? st.families[t.d].label : ""}`, colour, kind: "pop", vx: 0, vy: 0 });
    for (let k = 0; k < 5; k++) this.fx.push({ x, y, t0: performance.now(), colour, kind: "dust", vx: (Math.random() - 0.5) * 1.6, vy: (Math.random() - 0.5) * 1.6 });
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cam.w = w;
    this.cam.h = h;
  }

  frame(now: number): void {
    const t0 = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.resize();
    const s = this.client.state;
    const ctx = this.ctx;
    if (!s) {
      ctx.fillStyle = "#fdf3d8";
      ctx.fillRect(0, 0, this.cam.w, this.cam.h);
      return;
    }
    this.client.predict(dt);
    const st = STAGES[s.stage];
    const anim = this.view.reducedMotion ? 0 : now / 1000;

    // camera: follow our avatar, pull back during a transition and after the end
    const [mx, my] = toWorld(this.client.me.x, this.client.me.y);
    let zoom = this.view.zoom;
    if (s.phase.k === "transition") {
      const k = Math.min(1, 1 - (s.phase.until - s.tick) / 90);
      zoom *= 1 - 0.55 * Math.max(0, k);
    } else if (s.phase.k === "ended") zoom *= 0.5;
    const ease = this.view.reducedMotion ? 1 : Math.min(1, dt * 6);
    this.cam.x += (mx - this.cam.x) * ease;
    this.cam.y += (my - this.cam.y) * ease;
    this.cam.zoom += (zoom - this.cam.zoom) * (this.view.reducedMotion ? 1 : Math.min(1, dt * 3));
    if (Math.abs(this.cam.x - mx) > 2000) [this.cam.x, this.cam.y] = [mx, my];

    // sky
    const g = ctx.createLinearGradient(0, 0, 0, this.cam.h);
    g.addColorStop(0, st.palette.sky[0]);
    g.addColorStop(1, st.palette.sky[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.cam.w, this.cam.h);
    if (st.id === "system" || st.id === "universe") this.stars(s, anim);
    if (st.id === "sun") this.sunGlow(s, anim);
    // the Sun dims as it's consumed: everything darkens with it
    const dim = st.id === "sun" ? 0.65 * (1 - (s.ledger.matter.initial ? s.ledger.matter.remaining / s.ledger.matter.initial : 0)) : 0;

    const z = this.cam.zoom;
    const visible = (x: number, y: number, pad = 80): boolean => {
      const [sx, sy] = toScreen(this.cam, ...toWorld(x, y));
      return sx > -pad * z && sx < this.cam.w + pad * z && sy > -pad * z * 2 && sy < this.cam.h + pad * z;
    };

    // ground, back to front
    this.cap = lifeCap(s.ledger);
    for (let d = 0; d <= (s.w - 1) * 2; d++) {
      for (let x = Math.max(0, d - s.w + 1); x <= Math.min(d, s.w - 1); x++) {
        const y = d - x;
        if (!visible(x, y)) continue;
        this.ground(s, st, x, y, anim);
      }
    }

    // overlays on the ground: survey, pressure, ghost footprint; then paths, claims and networks
    this.overlays(s, st, anim);
    this.lines(s, st, anim);
    this.claims(s, false);

    // objects, depth sorted
    const items: { depth: number; draw: () => void }[] = [];
    s.tiles.forEach((t, i) => {
      const x = i % s.w;
      const y = Math.floor(i / s.w);
      if ((t.d || t.mark) && !t.b && visible(x, y)) items.push({ depth: x + y, draw: () => this.deposit(s, st, t, x, y, anim, i) });
    });
    const behind = this.playersBehind(s);
    for (const b of s.buildings) {
      const n = BUILDINGS[b.type].size;
      if (!visible(b.x, b.y, 140)) continue;
      items.push({ depth: b.x + b.y + (n - 1) * 2 + 0.1, draw: () => this.building(s, st, b, anim, behind.has(b.id)) });
    }
    for (const p of Object.values(s.players)) {
      const pos = p.id === this.client.you ? [this.client.me.x, this.client.me.y] : this.client.position(p.id);
      if (!pos) continue;
      items.push({ depth: pos[0] + pos[1] + 0.5, draw: () => this.player(st, p, pos[0], pos[1], anim) });
    }
    for (const a of s.lobby.agents) {
      const [lx, ly] = this.client.lobbyPosition(a.id, a.x, a.y);
      if (!visible(lx, ly)) continue;
      items.push({ depth: lx + ly + 0.5, draw: () => this.lobbyist(st, a, lx, ly, anim) });
    }
    items.sort((a, b) => a.depth - b.depth);
    for (const it of items) it.draw();
    this.claims(s, true);
    if (this.hint) this.label(this.hint.text, this.hint.x, this.hint.y, "#fffbe0", 12);
    this.hint = null;

    if (dim > 0) {
      ctx.fillStyle = `rgba(20,8,16,${dim})`;
      ctx.fillRect(0, 0, this.cam.w, this.cam.h);
    }
    this.ghost(s, st);
    this.wildlife(s, st, anim);
    this.effects(now);
    if (this.view.survey) this.surveyArrow(s, st, anim);
    this.vignette(s);
    this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  private corners(x: number, y: number, n = 1): [number, number][] {
    const c = (a: number, b: number): [number, number] => toScreen(this.cam, ...toWorld(a, b));
    return [c(x - 0.5, y - 0.5), c(x + n - 0.5, y - 0.5), c(x + n - 0.5, y + n - 0.5), c(x - 0.5, y + n - 0.5)];
  }

  private poly(pts: [number, number][], fill: string, stroke?: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(1, this.cam.zoom);
      ctx.stroke();
    }
  }

  private ground(s: Snapshot, st: StageDef, x: number, y: number, anim: number): void {
    const i = y * s.w + x;
    const t = s.tiles[i];
    if (t.t === 2) return; // open space: the sky shows through
    const pts = this.corners(x, y);
    const k = effectiveLife(t, this.cap) / 100;
    let fill: string;
    const jitter = (hash(i) - 0.5) * 0.08;
    if (t.t === 1) {
      // water or ice: shrinks toward mud as it's drawn down
      const full = t.init ? t.amt / t.init : 0;
      if (st.id === "earth") fill = full > 0 ? mix([120, 98, 80], [80, 170, 220], 0.35 + 0.65 * full) : "rgb(132,108,86)";
      else fill = full > 0 ? mix([60, 60, 80], [200, 230, 255], full) : "rgb(70,70,84)";
    } else if (t.t === 3) {
      const full = t.init ? t.amt / t.init : 0;
      const pulse = 0.85 + 0.15 * Math.sin(anim * 2 + i);
      fill = full > 0 ? mix([90, 50, 40], [255, 240, 170], full * pulse) : "rgb(58,40,40)";
    } else if (t.t === 4) {
      fill = mix([60, 58, 66], [90, 88, 96], hash(i));
    } else {
      fill = mix(st.palette.dead, st.palette.lush, Math.max(0, Math.min(1, k + jitter)));
    }
    this.poly(pts, fill, "rgba(0,0,0,0.06)");
    // a lip on the front edges gives the island some thickness
    if (x === s.w - 1 || y === s.w - 1) {
      const h = 10 * this.cam.zoom;
      const [, r, b, l] = pts;
      if (y === s.w - 1) this.poly([l, b, [b[0], b[1] + h], [l[0], l[1] + h]], "rgba(70,50,40,0.6)");
      if (x === s.w - 1) this.poly([b, r, [r[0], r[1] + h], [b[0], b[1] + h]], "rgba(50,35,30,0.6)");
    }
    // grass tufts and flowers while the land is alive
    if (st.id === "earth" && t.t === 0 && !t.d && !t.b && k > 0.55 && hash(i * 7) > 0.55) {
      const [cx, cy] = toScreen(this.cam, ...toWorld(x + (hash(i * 3) - 0.5) * 0.6, y + (hash(i * 5) - 0.5) * 0.6));
      const ctx = this.ctx;
      ctx.fillStyle = hash(i * 11) > 0.7 ? ["#fff6a8", "#ffb3c7", "#ffffff"][Math.floor(hash(i) * 3)] : "rgba(60,120,50,0.6)";
      ctx.beginPath();
      ctx.arc(cx, cy, 2 * this.cam.zoom, 0, Math.PI * 2);
      ctx.fill();
    }
    if (t.t === 1 && t.amt > 0 && st.id === "earth" && hash(i) > 0.5) {
      const [cx, cy] = toScreen(this.cam, ...toWorld(x, y));
      const ctx = this.ctx;
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 1;
      const w = (6 + 3 * Math.sin(anim * 1.5 + i)) * this.cam.zoom;
      ctx.beginPath();
      ctx.moveTo(cx - w, cy);
      ctx.lineTo(cx + w, cy);
      ctx.stroke();
    }
    if (t.ghost && hash(i) > 0.92) {
      const [cx, cy] = toScreen(this.cam, ...toWorld(x, y));
      this.label(t.ghost, cx, cy, "rgba(220,220,230,0.7)", 10);
    }
  }

  private overlays(s: Snapshot, st: StageDef, anim: number): void {
    const ctx = this.ctx;
    if (this.view.survey) {
      s.tiles.forEach((t, i) => {
        if (!t.d || t.amt <= 0) return;
        const pts = this.corners(i % s.w, Math.floor(i / s.w));
        ctx.globalAlpha = 0.35 + 0.25 * Math.sin(anim * 4);
        this.poly(pts, "rgba(255,255,255,0.0)", "#fffbe0");
        ctx.globalAlpha = 1;
      });
    }
    if (st.mechanic === "pressure" && this.view.tool === "build") {
      for (const h of s.buildings) {
        if (h.type !== "habitat" || h.status !== "ok") continue;
        const r = BUILDINGS.habitat.pressureRadius!;
        const pts = this.corners(h.x + 0.5 - r, h.y + 0.5 - r, 2 * r + 1);
        this.poly(pts, "rgba(160,220,255,0.12)", "rgba(160,220,255,0.6)");
      }
    }
    if (st.mechanic === "relay" && this.view.tool === "build") {
      for (const h of s.buildings) {
        const range = BUILDINGS[h.type].relayRange;
        if (!range || h.status !== "ok") continue;
        const n = BUILDINGS[h.type].size;
        const c = (n - 1) / 2;
        const pts = this.corners(h.x + c - range, h.y + c - range, 2 * range + 1);
        this.poly(pts, "rgba(111,208,255,0.06)", "rgba(111,208,255,0.4)");
      }
    }
  }

  private deposit(s: Snapshot, st: StageDef, t: Tile, x: number, y: number, anim: number, i: number): void {
    const ctx = this.ctx;
    const z = this.cam.zoom;
    const [cx, cy] = toScreen(this.cam, ...toWorld(x, y));
    const full = t.init ? t.amt / t.init : 0;
    if (t.d) {
      const look = `${st.id}:${t.d}`;
      const col = st.palette[t.d as Family];
      if (look === "earth:matter") {
        if (t.amt === 0) {
          this.ellipse(cx, cy, 6 * z, 3 * z, "#8a6a4a");
          this.ellipse(cx, cy - 2 * z, 5 * z, 2.5 * z, "#c9a273");
        } else {
          const n = Math.max(1, Math.ceil(full * 3));
          for (let k = 0; k < n; k++) {
            const ox = (hash(i * 13 + k) - 0.5) * 22 * z;
            const oy = (hash(i * 17 + k) - 0.5) * 8 * z;
            const sway = Math.sin(anim * 1.2 + i + k) * 1.5 * z;
            this.tree(cx + ox, cy + oy, z * (0.8 + 0.3 * hash(i + k)), col, sway, effectiveLife(t, this.cap));
          }
        }
      } else if (t.d === "mineral") {
        const n = t.amt === 0 ? 0 : Math.max(1, Math.ceil(full * 3));
        if (n === 0) this.ellipse(cx, cy, 8 * z, 3 * z, "rgba(0,0,0,0.15)");
        for (let k = 0; k < n; k++) {
          const ox = (hash(i * 19 + k) - 0.5) * 18 * z;
          const oy = (hash(i * 23 + k) - 0.5) * 6 * z;
          const r = (6 + 4 * hash(i + k * 3)) * z;
          if (st.id === "sun" || st.id === "universe") this.crystal(cx + ox, cy + oy, r, col, anim + k);
          else this.rock(cx + ox, cy + oy, r, col);
        }
      } else if (t.d === "matter") {
        if (t.amt === 0) {
          this.ellipse(cx, cy, 8 * z, 3 * z, "rgba(0,0,0,0.18)");
        } else if (st.id === "mars") {
          this.ellipse(cx, cy - 2 * z, 13 * z * (0.5 + full / 2), 6 * z * (0.5 + full / 2), col, OUTLINE);
          this.ellipse(cx - 3 * z, cy - 4 * z, 6 * z * full, 2 * z, shade(col, 0.25));
        } else if (st.id === "sun") {
          const fl = 0.6 + 0.4 * Math.sin(anim * 5 + i * 1.7);
          ctx.globalAlpha = full * fl;
          this.ellipse(cx, cy - 6 * z, 6 * z, 10 * z * fl, "#fff6c8");
          ctx.globalAlpha = 1;
        } else if (st.id === "universe") {
          this.galaxy(cx, cy - 6 * z, 12 * z * (0.4 + 0.6 * full), col, anim + i, full);
        } else {
          this.rock(cx, cy, 8 * z * (0.5 + full / 2), col);
        }
      } else if (t.d === "coolant") {
        if (st.id === "mars" && t.amt > 0) {
          this.ellipse(cx, cy, 14 * z * full, 6 * z * full, "rgba(235,250,255,0.85)");
        } else if (st.id === "sun" && t.amt > 0) {
          this.ellipse(cx, cy, 12 * z * full, 5 * z * full, "rgba(30,40,90,0.85)");
        } else if (st.id === "system" && t.amt > 0) {
          this.ellipse(cx, cy - 8 * z, 5 * z, 5 * z, "#eef8ff", OUTLINE);
          ctx.strokeStyle = "rgba(207,232,255,0.5)";
          ctx.lineWidth = 3 * z;
          ctx.beginPath();
          ctx.moveTo(cx + 3 * z, cy - 6 * z);
          ctx.lineTo(cx + 18 * z * full, cy + 2 * z);
          ctx.stroke();
        } else if (st.id === "universe" && t.amt > 0) {
          ctx.globalAlpha = 0.5 * full;
          this.ellipse(cx, cy - 4 * z, 16 * z, 8 * z, col);
          ctx.globalAlpha = 1;
        }
      }
    }
    // little surprises at Earth's named places, gone when the place is
    if (st.id === "earth" && t.mark?.name === "Heron Pond" && t.amt > 0) this.heron(cx - 8 * z, cy + 2 * z, anim);
    if (st.id === "earth" && t.mark?.name === "Picnic Hill") this.picnic(cx - 6 * z, cy + 3 * z);
    if (t.mark) {
      ctx.strokeStyle = "#3a2c2c";
      ctx.lineWidth = 1.5 * z;
      ctx.beginPath();
      ctx.moveTo(cx + 10 * z, cy);
      ctx.lineTo(cx + 10 * z, cy - 26 * z);
      ctx.stroke();
      const wave = Math.sin(anim * 3 + i) * 2 * z;
      this.poly([[cx + 10 * z, cy - 26 * z], [cx + 24 * z, cy - 22 * z + wave], [cx + 10 * z, cy - 18 * z]], "#ff8a65", OUTLINE);
      this.label(t.mark.name, cx + 10 * z, cy - 32 * z, "#fffdf3", 11);
    }
  }

  private heron(x: number, y: number, anim: number): void {
    const ctx = this.ctx;
    const z = this.cam.zoom;
    // stands still, then dips its beak now and then
    const dip = Math.max(0, Math.sin(anim * 0.7)) > 0.97 ? 5 * z : 0;
    ctx.strokeStyle = "#5b5560";
    ctx.lineWidth = 1.2 * z;
    ctx.beginPath();
    ctx.moveTo(x - 1.5 * z, y);
    ctx.lineTo(x - 1 * z, y - 9 * z);
    ctx.moveTo(x + 1.5 * z, y);
    ctx.lineTo(x + 1 * z, y - 9 * z);
    ctx.stroke();
    this.ellipse(x, y - 12 * z, 5 * z, 3.5 * z, "#b9bec9", OUTLINE);
    ctx.strokeStyle = "#b9bec9";
    ctx.lineWidth = 2 * z;
    ctx.beginPath();
    ctx.moveTo(x + 3 * z, y - 13 * z);
    ctx.quadraticCurveTo(x + 7 * z, y - 20 * z, x + 5 * z, y - 23 * z + dip);
    ctx.stroke();
    this.ellipse(x + 5 * z, y - 23 * z + dip, 2.2 * z, 1.8 * z, "#c9ced8", OUTLINE);
    ctx.strokeStyle = "#e0a040";
    ctx.lineWidth = 1.2 * z;
    ctx.beginPath();
    ctx.moveTo(x + 7 * z, y - 23 * z + dip);
    ctx.lineTo(x + 11 * z, y - 22 * z + dip * 1.4);
    ctx.stroke();
  }

  private picnic(x: number, y: number): void {
    const z = this.cam.zoom;
    const w = 10 * z;
    const h = 5 * z;
    this.poly([[x, y - h], [x + w, y], [x, y + h], [x - w, y]], "#e86a5a", OUTLINE);
    this.poly([[x - w / 2, y - h / 2], [x, y], [x - w / 2, y + h / 2], [x - w, y]], "#fff3e8");
    this.poly([[x + w / 2, y - h / 2], [x + w, y], [x + w / 2, y + h / 2], [x, y]], "#fff3e8");
    this.ellipse(x + 2 * z, y - 3 * z, 3 * z, 2.2 * z, "#c98a4a", OUTLINE);
  }

  private ellipse(x: number, y: number, rx: number, ry: number, fill: string, stroke?: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(1, this.cam.zoom);
      ctx.stroke();
    }
  }

  private tree(x: number, y: number, z: number, col: string, sway: number, life: number): void {
    this.ellipse(x, y, 7 * z, 3 * z, "rgba(0,0,0,0.15)");
    this.poly([[x - 2 * z, y], [x + 2 * z, y], [x + 1.5 * z, y - 12 * z], [x - 1.5 * z, y - 12 * z]], "#7a5233");
    const leaf = life > 40 ? col : shade(col, -0.3);
    this.ellipse(x + sway, y - 18 * z, 10 * z, 9 * z, leaf, OUTLINE);
    this.ellipse(x + sway - 3 * z, y - 22 * z, 5 * z, 4 * z, shade(leaf, 0.2));
  }

  private rock(x: number, y: number, r: number, col: string): void {
    this.ellipse(x, y, r, r * 0.5, "rgba(0,0,0,0.15)");
    this.ellipse(x, y - r * 0.4, r, r * 0.7, col, OUTLINE);
    this.ellipse(x - r * 0.3, y - r * 0.6, r * 0.4, r * 0.25, shade(col, 0.3));
  }

  private crystal(x: number, y: number, r: number, col: string, a: number): void {
    const glow = 0.8 + 0.2 * Math.sin(a * 2);
    this.poly([[x, y - r * 2 * glow], [x + r * 0.6, y - r * 0.4], [x, y], [x - r * 0.6, y - r * 0.4]], col, OUTLINE);
    this.poly([[x, y - r * 2 * glow], [x + r * 0.6, y - r * 0.4], [x, y]], shade(col, 0.3));
  }

  private galaxy(x: number, y: number, r: number, col: string, a: number, full: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, 0.5);
    ctx.rotate(a * 0.2);
    ctx.globalAlpha = 0.3 + 0.7 * full;
    for (let arm = 0; arm < 2; arm++) {
      ctx.beginPath();
      for (let k = 0; k < 20; k++) {
        const th = k * 0.35 + arm * Math.PI;
        const rr = (k / 20) * r;
        ctx.lineTo(Math.cos(th) * rr, Math.sin(th) * rr);
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = "#fffef0";
    ctx.fill();
    ctx.restore();
  }

  private playersBehind(s: Snapshot): Set<number> {
    const out = new Set<number>();
    const pos: [number, number][] = [];
    for (const p of Object.values(s.players)) {
      const q = p.id === this.client.you ? [this.client.me.x, this.client.me.y] : this.client.position(p.id);
      if (q) pos.push([q[0], q[1]]);
    }
    for (const b of s.buildings) {
      if (!BUILDINGS[b.type].tall) continue;
      const n = BUILDINGS[b.type].size;
      const cx = b.x + (n - 1) / 2;
      const cy = b.y + (n - 1) / 2;
      for (const [px, py] of pos) {
        const depth = cx + cy - (px + py);
        if (depth > -0.5 && depth < 3.5 && Math.abs(cx - cy - (px - py)) < n + 0.6) out.add(b.id);
      }
    }
    return out;
  }

  private building(s: Snapshot, st: StageDef, b: Building, anim: number, faded: boolean): void {
    const ctx = this.ctx;
    const z = this.cam.zoom;
    const def = BUILDINGS[b.type];
    const n = def.size;
    const look = BUILD_LOOK[b.type];
    const done = complete(b);
    const ok = isRunning(b);
    ctx.globalAlpha = faded ? 0.4 : 1;
    const [T, R, B, L] = this.corners(b.x, b.y, n).map(([x, y]) => [x, y] as [number, number]);
    const inset = (p: [number, number], k = 0.12): [number, number] => {
      const cx = (T[0] + B[0]) / 2;
      const cy = (T[1] + B[1]) / 2;
      return [p[0] + (cx - p[0]) * k, p[1] + (cy - p[1]) * k];
    };
    const t = inset(T), r = inset(R), bb = inset(B), l = inset(L);
    const progress = Math.min(1, b.work / Math.max(1, b.need ?? def.build * 10));
    const h = look.h * z * (done ? 1 : 0.25 + 0.75 * progress) * (b.type === "city" && b.status.startsWith("unserved") ? 0.75 : 1);
    const up = (p: [number, number], k = h): [number, number] => [p[0], p[1] - k];
    const [cx, cy] = [(T[0] + B[0]) / 2, (T[1] + B[1]) / 2];

    if (!done) {
      // scaffold and a progress bar
      this.poly([t, r, bb, l], "rgba(120,90,60,0.35)", OUTLINE);
      ctx.strokeStyle = "#a07a4a";
      ctx.lineWidth = 1.5 * z;
      for (const p of [t, r, bb, l]) {
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(p[0], p[1] - h);
        ctx.stroke();
      }
      this.poly([up(t), up(r), up(bb), up(l)], "rgba(230,200,150,0.6)", OUTLINE);
      const w = 30 * z;
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.fillRect(cx - w / 2, cy - h - 14 * z, w, 5 * z);
      ctx.fillStyle = "#ffe08a";
      ctx.fillRect(cx - w / 2, cy - h - 14 * z, w * progress, 5 * z);
      ctx.globalAlpha = 1;
      return;
    }

    if (b.type === "habitat") {
      this.poly([t, r, bb, l], "#b9c7cf", OUTLINE);
      ctx.globalAlpha = faded ? 0.3 : 0.75;
      this.ellipse(cx, cy - 4 * z, (R[0] - L[0]) * 0.4, h * 1.2, ok ? "rgba(200,235,255,0.7)" : "rgba(150,150,160,0.7)", OUTLINE);
      ctx.globalAlpha = faded ? 0.4 : 1;
      this.ellipse(cx - 8 * z, cy - h, 6 * z, 3 * z, "rgba(255,255,255,0.7)");
    } else if (b.type === "engine") {
      this.poly([t, r, bb, l], "#4a4d60", OUTLINE);
      this.ellipse(cx, cy - h, 16 * z, 16 * z, "#5d6080", OUTLINE);
      ctx.strokeStyle = "#c9c4ff";
      ctx.lineWidth = 2 * z;
      ctx.beginPath();
      ctx.ellipse(cx, cy - h, 26 * z, 8 * z, Math.sin(anim * 0.5) * 0.2, 0, Math.PI * 2);
      ctx.stroke();
      if (b.name) this.label(b.name, cx, cy - h - 24 * z, "#e6e3ff", 11);
    } else {
      const side = look.colour;
      this.poly([l, bb, up(bb), up(l)], shade(side, -0.15), OUTLINE);
      this.poly([bb, r, up(r), up(bb)], shade(side, -0.35), OUTLINE);
      this.poly([up(t), up(r), up(bb), up(l)], look.roof, OUTLINE);
      this.details(st, b, [up(t), up(r), up(bb), up(l)], [l, bb, r], h, anim, ok);
      if (b.name && b.type === "depot") this.label(b.name, cx, cy - h - 16 * z, "#fff8e0", 11);
    }

    // idle marker: a glyph and text-backed status, never colour alone
    if (done && isIdle(b)) {
      const bob = Math.sin(anim * 3) * 2 * z;
      this.ellipse(cx, cy - h - 16 * z + bob, 9 * z, 9 * z, "#fffdf3", OUTLINE);
      ctx.fillStyle = "#3a2c2c";
      ctx.font = `bold ${Math.round(12 * z)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.status.startsWith("throttled") ? "~" : "!", cx, cy - h - 16 * z + bob);
    }
    // with the network view on, a power break or an overloaded grid is spelled out on the machine itself
    if (done && (this.view.networks || this.view.tool === "line") && /no power|not cabled|tank empty|hopper full|Bottled Sun is empty/.test(b.status)) {
      const why = b.status.includes("not cabled") ? "⚡✕ not cabled" : b.status.includes("overloaded") || b.status.includes("to spare") ? "⚡ grid overloaded" : b.status.includes("tank") ? "💧 tank empty" : b.status.includes("hopper") ? "▣ hopper full" : "⚡ reserve empty";
      this.label(why, cx, cy + 6 * z, "#ffd1cc", 10);
    }
    if (this.view.selected === b.id) this.poly([T, R, B, L], "rgba(255,255,255,0.15)", "#fffbe0");
    ctx.globalAlpha = 1;
  }

  private details(st: StageDef, b: Building, top: [number, number][], base: [number, number][], h: number, anim: number, ok: boolean): void {
    const ctx = this.ctx;
    const z = this.cam.zoom;
    const [t, r, bb, l] = top;
    const cx = (t[0] + bb[0]) / 2;
    const cy = (t[1] + bb[1]) / 2;
    switch (b.type) {
      case "city": {
        // windows on the front faces, lit when served
        const [L, B, R] = base;
        for (let k = 1; k <= 3; k++) {
          const f = k / 4;
          const wx = L[0] + (B[0] - L[0]) * f;
          const wy = L[1] + (B[1] - L[1]) * f - h * 0.55;
          ctx.fillStyle = ok ? "#ffe9a0" : "#6b6a70";
          ctx.fillRect(wx - 2 * z, wy - 3 * z, 4 * z, 5 * z);
          const vx = B[0] + (R[0] - B[0]) * f;
          const vy = B[1] + (R[1] - B[1]) * f - h * 0.55;
          ctx.fillRect(vx - 2 * z, vy - 3 * z, 4 * z, 5 * z);
        }
        // little roofs
        this.poly([[cx, cy - 12 * z], [cx + 10 * z, cy - 2 * z], [cx - 10 * z, cy - 2 * z]], shade(BUILD_LOOK.city.roof, -0.15), OUTLINE);
        break;
      }
      case "furnace": {
        ctx.fillStyle = "#4a3532";
        ctx.fillRect(cx + 2 * z, cy - 18 * z, 6 * z, 16 * z);
        if (ok && !this.view.low && Math.random() < 0.2) this.fx.push({ x: b.x, y: b.y, t0: performance.now(), colour: "rgba(90,80,80,0.5)", kind: "smoke", vx: 0.2, vy: -0.2 });
        break;
      }
      case "solar": {
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.lineWidth = 1;
        for (let k = 1; k < 4; k++) {
          const f = k / 4;
          ctx.beginPath();
          ctx.moveTo(t[0] + (r[0] - t[0]) * f, t[1] + (r[1] - t[1]) * f);
          ctx.lineTo(l[0] + (bb[0] - l[0]) * f, l[1] + (bb[1] - l[1]) * f);
          ctx.stroke();
        }
        if (ok && st.id === "sun") {
          ctx.globalAlpha = 0.3 + 0.2 * Math.sin(anim * 4);
          this.poly(top, "#fff3a0");
          ctx.globalAlpha = 1;
        }
        break;
      }
      case "datacentre": {
        for (let k = 0; k < 6; k++) {
          const on = ok && Math.sin(anim * 6 + k * 1.7 + b.id) > 0;
          ctx.fillStyle = on ? (k % 2 ? "#6fffb0" : "#6fd0ff") : "#333842";
          const [L, B] = base;
          const f = (k + 1) / 7;
          ctx.fillRect(L[0] + (B[0] - L[0]) * f - z, L[1] + (B[1] - L[1]) * f - h * 0.5, 2 * z, 2 * z);
        }
        const spin = ok ? anim * 8 : 0;
        ctx.strokeStyle = "#9aa3b5";
        ctx.lineWidth = 1.5 * z;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(spin) * 6 * z, cy + Math.sin(spin) * 3 * z);
        ctx.lineTo(cx - Math.cos(spin) * 6 * z, cy - Math.sin(spin) * 3 * z);
        ctx.stroke();
        break;
      }
      case "extractor": {
        const bob = ok ? Math.abs(Math.sin(anim * 6 + b.id)) * 6 * z : 0;
        ctx.strokeStyle = "#5b4630";
        ctx.lineWidth = 3 * z;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx, cy + 8 * z + h - bob);
        ctx.stroke();
        this.ellipse(cx, cy - 2 * z, 5 * z, 3 * z, "#ffd36b", OUTLINE);
        break;
      }
      case "radiator": {
        for (let k = -1; k <= 1; k++) {
          ctx.fillStyle = ok ? `rgba(255,${120 + k * 30},77,0.9)` : "#777";
          ctx.fillRect(cx + k * 6 * z - z, cy - 14 * z, 2 * z, 12 * z);
        }
        break;
      }
      case "relay": {
        ctx.strokeStyle = "#d9dde6";
        ctx.lineWidth = 2 * z;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx, cy - 18 * z);
        ctx.stroke();
        if (ok) {
          const k = (anim % 1.5) / 1.5;
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = "#6fd0ff";
          ctx.beginPath();
          ctx.ellipse(cx, cy - 18 * z, 20 * z * k, 10 * z * k, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        break;
      }
      case "factory": {
        // three sawtooth roof lights along the top, a chimney that smokes only while a batch runs,
        // and finished parts stacked by the door
        for (let k = 0; k < 3; k++) {
          const f = (k + 0.5) / 3;
          const ax = l[0] + (bb[0] - l[0]) * f;
          const ay = l[1] + (bb[1] - l[1]) * f;
          const off = [(t[0] - l[0]) * 0.55, (t[1] - l[1]) * 0.55];
          const p0: [number, number] = [ax + off[0] * 0.15, ay + off[1] * 0.15];
          const p1: [number, number] = [ax + off[0], ay + off[1]];
          this.poly([p0, p1, [p1[0], p1[1] - 9 * z], [p0[0], p0[1] - 3 * z]], "#b9cfdc", OUTLINE);
        }
        const [rx, ry] = [(t[0] + r[0]) / 2, (t[1] + r[1]) / 2];
        this.poly([[rx - 3 * z, ry], [rx + 3 * z, ry], [rx + 3 * z, ry - 18 * z], [rx - 3 * z, ry - 18 * z]], "#5a4a3a", OUTLINE);
        if (b.job && !this.view.low && Math.random() < 0.18) this.fx.push({ x: b.x + 1, y: b.y, t0: performance.now(), colour: "rgba(210,210,220,0.55)", kind: "smoke", vx: 0.1, vy: -0.25 });
        const made = Object.values(b.out ?? {}).reduce((a, v) => a + (v ?? 0), 0);
        const [dx0, dy0] = [(bb[0] + base[1][0]) / 2, (bb[1] + base[1][1]) / 2];
        for (let k = 0; k < Math.min(6, made); k++) this.ellipse(dx0 - 8 * z + (k % 3) * 5 * z, dy0 + h * 0.75 - Math.floor(k / 3) * 4 * z, 2.4 * z, 1.6 * z, "#e8c46a", OUTLINE);
        break;
      }
      case "store": {
        this.poly([[cx - 7 * z, cy - 2 * z], [cx, cy - 6 * z], [cx + 7 * z, cy - 2 * z], [cx, cy + 2 * z]], "#a8814a", OUTLINE);
        break;
      }
      case "intake": {
        const full = Math.min(1, (b.tank ?? 0) / 20);
        this.ellipse(cx, cy - 4 * z, 6 * z, 3 * z, "#2d4a5a", OUTLINE);
        this.ellipse(cx, cy - 4 * z, 6 * z * full, 3 * z * full, "#7fd0f0");
        break;
      }
      case "plaza": {
        const cols = ["#e8735a", "#f2c14e", "#4f9de0", "#8fcf6a"];
        for (let k = 0; k < 4; k++) {
          const f = k / 4;
          this.poly([[l[0] + (t[0] - l[0]) * f, l[1] + (t[1] - l[1]) * f - 10 * z], [l[0] + (t[0] - l[0]) * (f + 0.12), l[1] + (t[1] - l[1]) * (f + 0.12) - 10 * z], [l[0] + (t[0] - l[0]) * (f + 0.06), l[1] + (t[1] - l[1]) * (f + 0.06) - 4 * z]], cols[k]);
        }
        ctx.fillStyle = "#7a5233";
        ctx.fillRect(cx - 7 * z, cy - 2 * z, 14 * z, 3 * z);
        break;
      }
      default:
        break;
    }
  }

  private player(st: StageDef, p: Player, x: number, y: number, anim: number): void {
    const ctx = this.ctx;
    const z = this.cam.zoom;
    const [cx, cy0] = toScreen(this.cam, ...toWorld(x, y));
    const moving = p.dx !== 0 || p.dy !== 0;
    const bob = moving ? Math.abs(Math.sin(anim * 10)) * 3 * z : Math.sin(anim * 2) * 0.8 * z;
    const col = PLAYER_COLOURS[p.colour % PLAYER_COLOURS.length];
    const a = (p.facing / 8) * Math.PI * 2;
    // facing in screen space
    const [fx, fy] = [Math.cos(a) - Math.sin(a), (Math.cos(a) + Math.sin(a)) / 2];
    const away = fy < -0.1;
    const cy = cy0 - bob;
    ctx.globalAlpha = p.connected ? 1 : 0.4;
    this.ellipse(cx, cy0, 9 * z, 4 * z, "rgba(0,0,0,0.2)");
    const avatar = st.avatar;
    if (avatar === "drone" || avatar === "probe") {
      const hover = 8 * z + Math.sin(anim * 4 + p.colour) * 2 * z;
      this.ellipse(cx, cy - hover - 8 * z, 11 * z, 6 * z, col, OUTLINE);
      this.ellipse(cx, cy - hover - 11 * z, 6 * z, 3 * z, shade(col, 0.4));
      if (avatar === "drone") for (const s of [-1, 1]) this.ellipse(cx + s * 12 * z, cy - hover - 13 * z, 6 * z * Math.abs(Math.sin(anim * 30)), 1.5 * z, "rgba(255,255,255,0.7)");
      else {
        ctx.fillStyle = "#4f6fa8";
        ctx.fillRect(cx - 20 * z, cy - hover - 10 * z, 7 * z, 4 * z);
        ctx.fillRect(cx + 13 * z, cy - hover - 10 * z, 7 * z, 4 * z);
      }
      if (!away) this.eyes(cx + fx * 4 * z, cy - hover - 9 * z, z);
    } else if (avatar === "wisp") {
      const pulse = 1 + 0.15 * Math.sin(anim * 3 + p.colour);
      ctx.globalAlpha *= 0.35;
      this.ellipse(cx, cy - 16 * z, 16 * z * pulse, 16 * z * pulse, col);
      ctx.globalAlpha = p.connected ? 1 : 0.4;
      this.ellipse(cx, cy - 16 * z, 8 * z, 8 * z, shade(col, 0.5), OUTLINE);
      if (!away) this.eyes(cx + fx * 3 * z, cy - 16 * z, z);
    } else {
      // a round little person (and on Mars, a suit and helmet)
      const step = moving ? Math.sin(anim * 10) * 3 * z : 0;
      ctx.fillStyle = "#3a2c2c";
      ctx.fillRect(cx - 4 * z + step * 0.3, cy - 4 * z, 3 * z, 4 * z);
      ctx.fillRect(cx + 1 * z - step * 0.3, cy - 4 * z, 3 * z, 4 * z);
      this.ellipse(cx, cy - 11 * z, 8 * z, 9 * z, avatar === "suit" ? "#f2efe8" : col, OUTLINE);
      if (avatar === "suit") this.ellipse(cx, cy - 10 * z, 8 * z, 3 * z, col);
      this.ellipse(cx, cy - 24 * z, 8 * z, 7.5 * z, "#ffe0c2", OUTLINE);
      if (avatar === "suit") {
        ctx.globalAlpha *= 0.5;
        this.ellipse(cx, cy - 24 * z, 10 * z, 9.5 * z, "#bfe6ff", OUTLINE);
        ctx.globalAlpha = p.connected ? 1 : 0.4;
      } else {
        this.ellipse(cx, cy - 29 * z, 8 * z, 3.5 * z, shade(col, -0.3));
      }
      if (!away) this.eyes(cx + fx * 3 * z, cy - 24 * z, z);
      // tool swing while harvesting or building
      const swinging = (p.act && (p.act.k === "harvest" || p.act.k === "build")) || (p.id === this.client.you && performance.now() < this.client.swingUntil);
      if (swinging) {
        const sw = Math.sin(anim * 18) * 0.9;
        ctx.strokeStyle = "#7a5233";
        ctx.lineWidth = 2.5 * z;
        ctx.beginPath();
        ctx.moveTo(cx + fx * 6 * z, cy - 12 * z);
        ctx.lineTo(cx + fx * 6 * z + Math.cos(sw - 1) * 12 * z * Math.sign(fx || 1), cy - 12 * z + Math.sin(sw - 1) * 12 * z);
        ctx.stroke();
      }
    }
    const isMe = p.id === this.client.you;
    this.label(`${p.name}${isMe ? " (you)" : ""}${p.connected ? "" : " · away"}`, cx, cy - 44 * z, isMe ? "#fffbe0" : "#ffffff", 11, col);
    // a compact prompt for your first harvests: what E would do right now
    if (isMe && p.stats.harvested + p.stats.helped < 25 && this.view.tool === "harvest") {
      const hint = this.harvestHint(st, x, y);
      // drawn after every object, so trees in front can't cover it
      if (hint) this.hint = { text: hint, x: cx, y: cy + 14 * z };
    }
    if (p.act?.k === "emote" && p.act.e) {
      const glyph = { wave: "👋", heart: "💛", laugh: "😄", wow: "😮", sad: "😢", point: "👉" }[p.act.e];
      this.ellipse(cx + 16 * z, cy - 56 * z, 13 * z, 11 * z, "#fffdf3", OUTLINE);
      ctx.font = `${Math.round(15 * z)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(glyph, cx + 16 * z, cy - 56 * z);
    }
    ctx.globalAlpha = 1;
  }

  private harvestHint(st: StageDef, px: number, py: number): string | null {
    const s = this.client.state;
    if (!s) return null;
    for (let r = 0; r <= 2; r++)
      for (let y = Math.round(py) - r; y <= Math.round(py) + r; y++)
        for (let x = Math.round(px) - r; x <= Math.round(px) + r; x++) {
          if (x < 0 || y < 0 || x >= s.w || y >= s.w || Math.hypot(x - px, y - py) > 2.1) continue;
          const t = s.tiles[y * s.w + x];
          if (t.d && t.amt > 0) {
            const me = s.players[this.client.you];
            const y = s.pace === "rapid" ? 10 : 1;
            const m = me?.mode === "intensive" ? `+${2 * y}, wastes ${y}` : `+${y}`;
            if (this.view.touch) return `tap it to harvest ${st.families[t.d].label} (${m})`;
            return `E: harvest ${st.families[t.d].label} (${m}) · M: ${me?.mode === "intensive" ? "careful" : "intensive"}`;
          }
          const b = t.b ? s.buildings.find((q) => q.id === t.b) : undefined;
          if (b && b.work < BUILDINGS[b.type].build * 10) return this.view.touch ? "tap the site to help build" : "E: help build";
        }
    return null;
  }

  private eyes(x: number, y: number, z: number): void {
    this.ellipse(x - 3 * z, y, 1.3 * z, 1.8 * z, "#2b2030");
    this.ellipse(x + 3 * z, y, 1.3 * z, 1.8 * z, "#2b2030");
  }

  private label(text: string, x: number, y: number, colour: string, size: number, bg?: string): void {
    const ctx = this.ctx;
    const z = Math.max(0.8, Math.min(1.3, this.cam.zoom));
    ctx.font = `600 ${Math.round(size * z)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = bg ? "rgba(30,24,34,0.72)" : "rgba(30,24,34,0.6)";
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - size * z * 0.75, w, size * z * 1.5, 6);
    ctx.fill();
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(x - w / 2 + 3, y - 1, 3, 3);
    }
    ctx.fillStyle = colour;
    ctx.fillText(text, x + (bg ? 2 : 0), y + 0.5);
  }

  /** Paths always; cables, pipes and belts too, faintly unless the network view is on. */
  private lines(s: Snapshot, st: StageDef, anim: number): void {
    const ctx = this.ctx;
    const z = this.cam.zoom;
    const show = this.view.networks || this.view.tool === "line";
    const at = (x: number, y: number, dx = 0, dy = 0): [number, number] => toScreen(this.cam, ...toWorld(x + dx, y + dy));
    const seg = (x: number, y: number, kind: "cb" | "pp" | "bt", colour: string, width: number, dash: number[], off: [number, number]): void => {
      const t = s.tiles[y * s.w + x];
      const [cx, cy] = at(x + off[0], y + off[1]);
      ctx.strokeStyle = colour;
      ctx.lineWidth = width * z;
      ctx.setLineDash(dash.map((d) => d * z));
      let any = false;
      for (const [dx, dy] of DIRS) {
        const n = s.tiles[(y + dy) * s.w + x + dx];
        if (x + dx < 0 || y + dy < 0 || x + dx >= s.w || y + dy >= s.w) continue;
        const joins = n && (n[kind] || (n.b && (kind !== "bt" || (t.bt && DIRS[t.bt.d][0] === dx && DIRS[t.bt.d][1] === dy))));
        if (!joins) continue;
        any = true;
        const [ex, ey] = at(x + off[0] + dx * 0.5, y + off[1] + dy * 0.5);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }
      if (!any) this.ellipse(cx, cy, width * z, width * z * 0.6, colour);
      ctx.setLineDash([]);
    };
    for (let i = 0; i < s.tiles.length; i++) {
      const t = s.tiles[i];
      if (!t.pa && !t.cb && !t.pp && !t.bt) continue;
      const x = i % s.w;
      const y = Math.floor(i / s.w);
      if (t.pa) {
        // a path: rough track is a trampled strip, a laid path is paved stones
        const pts = this.corners(x, y).map(([px, py], k, all) => {
          const [mx, my] = [(all[0][0] + all[2][0]) / 2, (all[0][1] + all[2][1]) / 2];
          return [px + (mx - px) * 0.35, py + (my - py) * 0.35] as [number, number];
        });
        this.poly(pts, t.pa[1] ? "rgba(214,200,170,0.95)" : "rgba(150,118,84,0.7)", t.pa[1] ? "rgba(120,100,80,0.5)" : undefined);
      }
      ctx.globalAlpha = show ? 1 : 0.55;
      if (t.cb) seg(x, y, "cb", "#3a3030", 1.6, [], [-0.18, -0.18]);
      if (t.pp) seg(x, y, "pp", t.pp[1] ? "#4fa3c8" : "#8ab8cc", t.pp[1] ? 3.2 : 2.4, t.pp[1] ? [] : [4, 2], [0.18, -0.18]);
      if (t.bt) {
        seg(x, y, "bt", t.bt.q ? "#6e6a7a" : "#8a7a60", t.bt.q ? 5 : 4, [], [0, 0.15]);
        // an arrow for its direction (and a cross when it's blocked), so the state isn't colour alone
        const [d0, d1] = DIRS[t.bt.d];
        const [ax, ay] = at(x, y, 0.15 * d0, 0.15 + 0.15 * d1);
        const [bx, by] = at(x, y, -0.15 * d0, 0.15 - 0.15 * d1);
        const ang = Math.atan2(ay - by, ax - bx);
        ctx.fillStyle = t.bt.bk ? "#c0392b" : "#fff6d8";
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(ang - 0.5) * 6 * z, ay - Math.sin(ang - 0.5) * 6 * z);
        ctx.lineTo(ax - Math.cos(ang + 0.5) * 6 * z, ay - Math.sin(ang + 0.5) * 6 * z);
        ctx.fill();
        if (t.bt.it && t.bt.n > 0) {
          const [ix, iy] = at(x, y, 0, 0.15);
          const col = t.bt.it in st.palette ? st.palette[t.bt.it as Family] : "#e8c46a";
          for (let k = 0; k < t.bt.n; k++) this.ellipse(ix + (k - (t.bt.n - 1) / 2) * 5 * z, iy - 3 * z, 3 * z, 2.4 * z, col, OUTLINE);
        }
        if (t.bt.sp) {
          // a splitter: a little diamond hub, labelled when the networks are showing
          const [hx, hy] = at(x, y, 0, 0.15);
          this.poly([[hx, hy - 5 * z], [hx + 7 * z, hy], [hx, hy + 5 * z], [hx - 7 * z, hy]], "#f2c14e", OUTLINE);
          if (show) this.label("splitter", ...at(x, y, 0, -0.25), "#fff3c8", 9);
        }
        if (t.bt.bk && show) this.label("✕ blocked", ...at(x, y, 0, 0.3), "#ffd1cc", 9);
      }
      ctx.globalAlpha = 1;
    }
    void anim;
  }

  /** Claims: the boundary in the owner's colour on the ground, and their name over everything. */
  private claims(s: Snapshot, labels: boolean): void {
    const ctx = this.ctx;
    for (const c of s.claims) {
      const owner = s.players[c.owner];
      const col = PLAYER_COLOURS[(owner?.colour ?? 7) % PLAYER_COLOURS.length];
      const pts = this.corners(c.x, c.y, CLAIM_SIZE);
      if (labels) {
        const [lx, ly] = pts[3];
        this.label(`${owner?.name ?? "someone"}'s claim`, lx, ly + 6 * this.cam.zoom, "#ffffff", 10, col);
        continue;
      }
      ctx.setLineDash([6 * this.cam.zoom, 4 * this.cam.zoom]);
      this.poly(pts, "rgba(255,255,255,0.05)", col);
      ctx.lineWidth = 2.5 * this.cam.zoom;
      ctx.strokeStyle = col;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private lobbyist(st: StageDef, a: Lobbyist, x: number, y: number, anim: number): void {
    const ctx = this.ctx;
    const z = this.cam.zoom;
    const [cx, cy0] = toScreen(this.cam, ...toWorld(x, y));
    const moving = a.task.k === "walk";
    const bob = moving ? Math.abs(Math.sin(anim * 9 + a.id)) * 2.5 * z : 0;
    const cy = cy0 - bob;
    this.ellipse(cx, cy0, 8 * z, 3.5 * z, "rgba(0,0,0,0.2)");
    // green overalls, a straw hat, and a placard on a stick: clearly not a player
    ctx.fillStyle = "#3a2c2c";
    ctx.fillRect(cx - 3.5 * z, cy - 4 * z, 3 * z, 4 * z);
    ctx.fillRect(cx + 0.5 * z, cy - 4 * z, 3 * z, 4 * z);
    this.ellipse(cx, cy - 11 * z, 7 * z, 8 * z, "#4c9a52", OUTLINE);
    this.ellipse(cx, cy - 22 * z, 6.5 * z, 6 * z, "#f0d2b0", OUTLINE);
    this.ellipse(cx, cy - 26 * z, 10 * z, 2.5 * z, "#e8cf7a", OUTLINE);
    this.ellipse(cx, cy - 28 * z, 5 * z, 3 * z, "#e8cf7a", OUTLINE);
    ctx.strokeStyle = "#7a5233";
    ctx.lineWidth = 1.6 * z;
    ctx.beginPath();
    ctx.moveTo(cx + 9 * z, cy - 6 * z);
    ctx.lineTo(cx + 9 * z, cy - 34 * z);
    ctx.stroke();
    ctx.font = `700 ${Math.round(8 * Math.max(0.8, z))}px system-ui, sans-serif`;
    const w = Math.max(28 * z, ctx.measureText(a.sign).width + 6);
    ctx.fillStyle = "#fffaf0";
    ctx.strokeStyle = "#4c9a52";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(cx + 9 * z - w / 2, cy - 46 * z, w, 12 * z, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#2a5a30";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(a.sign, cx + 9 * z, cy - 40 * z);
    this.label(`${a.name} · Green Lobby`, cx, cy - 56 * z, "#d8ffdc", 10);
    if (a.task.k === "plant") {
      // a watering can or trowel, by what it's putting back
      const t = this.client.state?.tiles[a.task.i];
      const col = t?.d ? st.palette[t.d] : "#4c9a52";
      for (let k = 0; k < 3; k++) {
        const ph = (anim * 1.5 + k / 3) % 1;
        this.ellipse(cx - 10 * z, cy - 8 * z + ph * 10 * z, 1.5 * z, 1.5 * z, col);
      }
    }
    if (a.say) {
      ctx.font = `600 ${Math.round(11 * Math.max(0.8, Math.min(1.3, z)))}px system-ui, sans-serif`;
      const tw = ctx.measureText(a.say).width + 12;
      ctx.fillStyle = "#fffdf3";
      ctx.strokeStyle = OUTLINE;
      ctx.beginPath();
      ctx.roundRect(cx - tw / 2 - 14 * z, cy - 78 * z, tw, 16 * z, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#2b2533";
      ctx.fillText(a.say, cx - 14 * z, cy - 70 * z);
    }
  }

  private ghost(s: Snapshot, st: StageDef): void {
    const tgt = this.target();
    if (!tgt) return;
    const [x, y] = tgt;
    const ctx = this.ctx;
    const me = s.players[this.client.you];
    const here = me ? { ...me, x: this.client.me.x, y: this.client.me.y } : undefined;
    if (this.view.tool === "build" && this.view.build) {
      const def = BUILDINGS[this.view.build];
      const eff = this.view.eff && !!def.kit;
      const problem = placementProblem(s as RoomState, this.view.build, x, y, here, eff);
      const pts = this.corners(x, y, def.size);
      this.poly(pts, problem ? "rgba(230,80,70,0.35)" : "rgba(120,230,140,0.35)", problem ? "#ff6b5a" : "#bfffc8");
      const [T, , B] = pts;
      const cx = (T[0] + B[0]) / 2;
      const cy = (T[1] + B[1]) / 2;
      ctx.globalAlpha = 0.55;
      const h = BUILD_LOOK[this.view.build].h * this.cam.zoom;
      this.poly([[cx, cy - h - 10], [pts[1][0], pts[1][1] - h], [cx, B[1] - h], [pts[3][0], pts[3][1] - h]], BUILD_LOOK[this.view.build].roof);
      ctx.globalAlpha = 1;
      // every shortage at once, not just the first
      const short = shortfalls(s as RoomState, buildCost(this.view.build, eff));
      const text = problem && /^needs /.test(problem) && short.length > 1 ? `✕ needs ${short.join(", ")}` : problem ? `✕ ${problem}` : `✓ place ${eff ? "an efficient " : ""}${st.names[this.view.build] ?? this.view.build}`;
      this.label(text, cx, cy + 24 * this.cam.zoom, problem ? "#ffd1cc" : "#d8ffdc", 12);
      const needs: string[] = [];
      if (def.energy < 0) needs.push(`${-def.energy} power by cable`);
      if (def.workers < 0) needs.push(`${-def.workers} workers`);
      if (def.compute < 0) needs.push(`${-def.compute} compute`);
      if (def.coolantUse) needs.push(`${st.families.coolant.label} piped or filled`);
      if (needs.length) this.label(`runs on: ${needs.join(", ")}`, cx, cy + 40 * this.cam.zoom, "#fffbe0", 10);
    } else if (this.view.tool === "claim" && me) {
      const owned = claimAt(s, x, y);
      if (owned) {
        const pts = this.corners(owned.x, owned.y, CLAIM_SIZE);
        const yours = owned.owner === me.id;
        this.poly(pts, "rgba(255,255,255,0.12)", yours ? "#ffd27a" : "#ff6b5a");
        const [T, , B] = pts;
        this.label(yours ? "click to give up this claim" : `✕ that's ${s.players[owned.owner]?.name ?? "someone"}'s land`, (T[0] + B[0]) / 2, (T[1] + B[1]) / 2, yours ? "#fffbe0" : "#ffd1cc", 12);
      } else {
        const problem = claimProblem(s as RoomState, x - 1, y - 1, here!);
        const pts = this.corners(x - 1, y - 1, CLAIM_SIZE);
        this.poly(pts, problem ? "rgba(230,80,70,0.25)" : "rgba(255,220,120,0.25)", problem ? "#ff6b5a" : "#ffd27a");
        const [T, , B] = pts;
        this.label(problem ? `✕ ${problem}` : `✓ claim this ${CLAIM_SIZE}×${CLAIM_SIZE}`, (T[0] + B[0]) / 2, (T[1] + B[1]) / 2, problem ? "#ffd1cc" : "#fff3c8", 12);
      }
    } else if (this.view.tool === "line" && this.view.line && x >= 0 && y >= 0 && x < s.w && y < s.w) {
      const ln = this.view.line;
      const from = ln.from ?? [x, y];
      const path = route(s as RoomState, ln.kind, from, [x, y], this.client.you);
      const problem = path ? linePathProblem(s as RoomState, ln.kind, path, here) : "no clear route there (32 tiles at most, around buildings)";
      for (const [px, py] of path ?? [[x, y]]) this.poly(this.corners(px, py), problem ? "rgba(230,80,70,0.3)" : "rgba(255,255,200,0.3)", problem ? "#ff6b5a" : "#fffbe0");
      const fresh = (path ?? []).filter(([px, py]) => {
        const t = s.tiles[py * s.w + px];
        return ln.kind === "cable" ? !t.cb : ln.kind === "pipe" ? !t.pp : ln.kind === "belt" ? !t.bt : !t.pa;
      }).length;
      const unit = LINES[ln.kind].cost[ln.q]!;
      const cost = Object.entries(unit).map(([k, v]) => `${(v ?? 0) * fresh} ${itemLabel(st, k as Family)}`).join(", ");
      const [cx, cy] = toScreen(this.cam, ...toWorld(x, y));
      const name = LINES[ln.kind].q[ln.q];
      this.label(problem ? `✕ ${problem}` : ln.from ? `${name}: ${fresh} new tile${fresh === 1 ? "" : "s"}, ${cost || "free"}. ${this.view.touch ? "Tap again to lay" : "Click to lay"}` : `${name}: ${this.view.touch ? "tap" : "click"} where it starts`, cx, cy + 22 * this.cam.zoom, problem ? "#ffd1cc" : "#fffbe0", 12);
    } else if (x >= 0 && y >= 0 && x < s.w && y < s.w) {
      const stroke = this.view.tool === "demolish" ? "#ff8a7a" : this.view.tool === "mark" ? "#ffd27a" : "rgba(255,255,240,0.9)";
      this.poly(this.corners(x, y), "rgba(255,255,255,0.08)", stroke);
      const t = s.tiles[y * s.w + x];
      if (this.view.tool === "demolish" && !t.b && (t.bt || t.pp || t.cb || t.pa)) {
        const [cx, cy] = toScreen(this.cam, ...toWorld(x, y));
        const kind = t.bt ? "belt" : t.pp ? "pipe" : t.cb ? "cable" : "path";
        this.label(`take up this ${kind} tile`, cx, cy + 20 * this.cam.zoom, "#ffd1cc", 11);
      }
    }
  }

  private wildlife(s: Snapshot, st: StageDef, anim: number): void {
    if (this.view.low) return;
    const ctx = this.ctx;
    const life = this.lifeCache(s);
    if (st.id === "earth") {
      // birds and butterflies: as many as the land can still hold
      const n = Math.round((life / 100) ** 1.5 * 14);
      for (let k = 0; k < n; k++) {
        const ph = anim * (0.05 + hash(k) * 0.05) + hash(k * 7);
        const x = ((ph % 1) + 1) % 1;
        const sx = x * (this.cam.w + 100) - 50;
        const sy = this.cam.h * (0.1 + 0.6 * hash(k * 3)) + Math.sin(anim * 2 + k) * 12;
        if (k % 3 === 0) {
          ctx.fillStyle = ["#fff6a8", "#ffb3c7", "#bfe3ff"][k % 3];
          const f = Math.abs(Math.sin(anim * 12 + k)) * 4;
          ctx.fillRect(sx - f, sy, f, 3);
          ctx.fillRect(sx, sy, f, 3);
        } else {
          ctx.strokeStyle = "rgba(50,40,50,0.7)";
          ctx.lineWidth = 1.5;
          const f = Math.sin(anim * 8 + k) * 3;
          ctx.beginPath();
          ctx.moveTo(sx - 5, sy - f);
          ctx.lineTo(sx, sy);
          ctx.lineTo(sx + 5, sy - f);
          ctx.stroke();
        }
      }
    } else if (st.id === "mars") {
      const n = Math.round((life / 100) * 4);
      for (let k = 0; k < n; k++) {
        const sx = ((anim * 20 * (1 + hash(k)) + hash(k) * 2000) % (this.cam.w + 200)) - 100;
        const sy = this.cam.h * (0.3 + 0.5 * hash(k * 5));
        ctx.fillStyle = "rgba(230,170,130,0.25)";
        for (let j = 0; j < 6; j++) {
          ctx.beginPath();
          ctx.arc(sx + Math.sin(anim * 6 + j) * (j * 2), sy - j * 8, 6 + j, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  private lifeAt = 0;
  private lifeValue = 100;
  private lifeCache(s: Snapshot): number {
    if (performance.now() - this.lifeAt > 1000) {
      this.lifeValue = averageLife(s);
      this.lifeAt = performance.now();
    }
    return this.lifeValue;
  }

  private stars(s: Snapshot, anim: number): void {
    const ctx = this.ctx;
    const remaining = STAGES[s.stage].id === "universe" ? this.remainingFraction(s) : 1;
    const n = Math.round(160 * remaining);
    for (let k = 0; k < n; k++) {
      const x = hash(k * 3) * this.cam.w;
      const y = hash(k * 5) * this.cam.h;
      ctx.fillStyle = `rgba(255,255,255,${0.3 + 0.5 * Math.abs(Math.sin(anim * hash(k) + k))})`;
      ctx.fillRect(x, y, 1.5, 1.5);
    }
  }

  private remainingFraction(s: Snapshot): number {
    const l = s.ledger;
    const init = l.matter.initial + l.mineral.initial + l.coolant.initial;
    return init ? (l.matter.remaining + l.mineral.remaining + l.coolant.remaining) / init : 0;
  }

  private sunGlow(s: Snapshot, anim: number): void {
    const ctx = this.ctx;
    const k = s.ledger.matter.initial ? s.ledger.matter.remaining / s.ledger.matter.initial : 0;
    const c = (s.w - 1) / 2;
    const [x, y] = toScreen(this.cam, ...toWorld(c, c));
    const r = (260 + 20 * Math.sin(anim)) * this.cam.zoom * (0.4 + 0.6 * k);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,250,200,${0.9 * k})`);
    g.addColorStop(1, "rgba(255,160,60,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.cam.w, this.cam.h);
  }

  private surveyArrow(s: Snapshot, st: StageDef, anim: number): void {
    // point at the nearest remaining deposit, so the last units are never a scavenger hunt
    let best = -1;
    let bd = Infinity;
    s.tiles.forEach((t, i) => {
      if (!t.d || t.amt <= 0) return;
      const d = Math.hypot((i % s.w) - this.client.me.x, Math.floor(i / s.w) - this.client.me.y);
      if (d < bd) [bd, best] = [d, i];
    });
    if (best < 0) return;
    const [tx, ty] = toScreen(this.cam, ...toWorld(best % s.w, Math.floor(best / s.w)));
    const [mx, my] = toScreen(this.cam, ...toWorld(this.client.me.x, this.client.me.y));
    const a = Math.atan2(ty - my, tx - mx);
    const d = Math.min(Math.hypot(tx - mx, ty - my) - 20, 70);
    if (d < 10) return;
    const ctx = this.ctx;
    const px = mx + Math.cos(a) * d;
    const py = my - 20 + Math.sin(a) * d * 0.7 + Math.sin(anim * 5) * 2;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(a);
    this.poly([[10, 0], [-6, -7], [-6, 7]], "#fffbe0", OUTLINE);
    ctx.restore();
    void st;
  }

  private effects(now: number): void {
    const ctx = this.ctx;
    this.fx = this.fx.filter((f) => now - f.t0 < (f.kind === "smoke" ? 2500 : 1100));
    for (const f of this.fx) {
      const age = (now - f.t0) / 1000;
      const [sx, sy] = toScreen(this.cam, ...toWorld(f.x + f.vx * age, f.y + f.vy * age));
      if (f.kind === "pop" && f.text) {
        ctx.globalAlpha = Math.max(0, 1 - age);
        this.label(f.text, sx, sy - 30 * this.cam.zoom - age * 30, "#fffbe0", 12);
      } else if (f.kind === "dust") {
        ctx.globalAlpha = Math.max(0, 1 - age);
        ctx.fillStyle = f.colour;
        ctx.beginPath();
        ctx.arc(sx, sy - 10 * this.cam.zoom - age * 20, 2.5 * this.cam.zoom, 0, Math.PI * 2);
        ctx.fill();
      } else if (f.kind === "smoke") {
        ctx.globalAlpha = Math.max(0, 0.5 - age / 5);
        ctx.fillStyle = f.colour;
        ctx.beginPath();
        ctx.arc(sx + 6 * this.cam.zoom + age * 8, sy - 40 * this.cam.zoom - age * 25, (4 + age * 6) * this.cam.zoom, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  private vignette(s: Snapshot): void {
    const ctx = this.ctx;
    const since = performance.now() - this.boundaryAt;
    if (since < 1500) {
      ctx.fillStyle = `rgba(255,255,255,${1 - since / 1500})`;
      ctx.fillRect(0, 0, this.cam.w, this.cam.h);
    }
    if (s.phase.k === "ended" && s.phase.how !== "restraint") {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, 0, this.cam.w, this.cam.h);
    }
  }

  /** a PNG of the current view, for the in-game photograph */
  photo(): string {
    return this.canvas.toDataURL("image/png");
  }
}

export { TW, TH };
