// The browser's side of the protocol. Holds the latest authoritative state
// (mutated in place, read by the renderer every frame) and a version counter
// the HUD polls at a few hertz, so React never sees per-entity updates.
import { PROTOCOL_VERSION, type ClientMsg, type Command, type Delta, type LogEntry, type ServerMsg, type Snapshot } from "../shared/protocol.ts";
import { TICK_MS } from "../shared/content.ts";
import { speedAt } from "../shared/layout.ts";

export type Status = "connecting" | "live" | "reconnecting" | "error";

interface Sample {
  t: number;
  x: number;
  y: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "bad";
}

const PENDING_LIMIT = 32;

export class GameClient {
  state: Snapshot | null = null;
  you = "";
  inc = "";
  status: Status = "connecting";
  error = "";
  version = 0;
  rtt = 0;
  toasts: Toast[] = [];
  /** interpolation buffers for every player, keyed by id */
  samples = new Map<string, Sample[]>();
  /** locally predicted position of our own avatar */
  me = { x: 0, y: 0, dx: 0, dy: 0 };
  /** until when (performance.now) our own avatar swings, before the server confirms */
  swingUntil = 0;
  /** fired on every applied tile change: the renderer spawns effects from these */
  onTile: ((i: number, before: number, after: number) => void) | null = null;
  /** previous positions of the Green Lobby's agents, for smooth drawing between updates */
  lobbySamples = new Map<number, Sample[]>();
  onAck: ((ok: boolean, c: Command, reason?: string) => void) | null = null;
  onBoundary: (() => void) | null = null;

  private ws: WebSocket | null = null;
  private seq = 0;
  private nextId = 1;
  private pending = new Map<string, Command>();
  private retry = 0;
  private closed = false;
  private toastId = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  readonly room: string;
  readonly name: string;

  constructor(room: string, name: string) {
    this.room = room;
    this.name = name;
  }

  get token(): string | null {
    return localStorage.getItem(`plenty:token:${this.room}`);
  }

  connect(): void {
    this.closed = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.raw({ t: "hello", v: PROTOCOL_VERSION, room: this.room, token: this.token ?? undefined, name: this.name });
    };
    ws.onmessage = (e) => this.receive(JSON.parse(e.data as string) as ServerMsg);
    ws.onclose = (e) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.closed) return;
      if (e.code === 4001) {
        this.fail("This world is open in another tab.");
        return;
      }
      if (e.code === 4002) {
        // the server has forgotten this browser's place in the room
        localStorage.removeItem(`plenty:token:${this.room}`);
        this.fail("The host asked you to leave this room.");
        return;
      }
      if (this.status === "error") return;
      this.status = "reconnecting";
      this.bump();
      // back off: 0.5s, 1s, 2s ... capped at 8s
      setTimeout(() => this.connect(), Math.min(8000, 500 * 2 ** this.retry++));
    };
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private fail(msg: string): void {
    this.status = "error";
    this.error = msg;
    this.bump();
  }

  private raw(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  bump(): void {
    this.version++;
  }

  toast(text: string, kind: Toast["kind"] = "info"): void {
    const t = { id: ++this.toastId, text, kind };
    // the same message again replaces itself rather than stacking up
    this.toasts = [...this.toasts.filter((x) => x.text !== text).slice(-2), t];
    this.bump();
    setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== t.id);
      this.bump();
    }, 3500);
  }

  send(c: Command): void {
    if (!this.state || this.status !== "live") return;
    const id = `${this.inc}-${this.nextId++}`;
    if (c.k !== "move") {
      if (this.pending.size >= PENDING_LIMIT) return this.toast("Waiting for the server…", "bad");
      this.pending.set(id, c);
      // the swing is a preview; the stockpile only moves when the server says so
      if (c.k === "harvest") this.swingUntil = performance.now() + 450;
    }
    this.raw({ t: "cmd", id, inc: this.inc, gen: this.state.gen, c });
  }

  private receive(m: ServerMsg): void {
    switch (m.t) {
      case "welcome": {
        const fresh = this.inc !== m.inc || this.state?.gen !== m.snap.gen;
        if (this.inc && this.inc !== m.inc && this.pending.size) this.toast("The server restarted; your last action may not have gone through.", "bad");
        this.inc = m.inc;
        this.you = m.you;
        this.state = m.snap;
        this.seq = m.snap.seq;
        localStorage.setItem(`plenty:token:${this.room}`, m.token);
        // a new incarnation or stage makes every pending action and buffer obsolete;
        // a resync within the same one keeps them, so their acks still land
        if (fresh) {
          this.pending.clear();
          this.samples.clear();
        }
        const me = m.snap.players[m.you];
        if (me && (fresh || Math.hypot(me.x - this.me.x, me.y - this.me.y) > 1)) this.me = { x: me.x, y: me.y, dx: 0, dy: 0 };
        for (const p of Object.values(m.snap.players)) this.sample(p.id, p.x, p.y);
        this.status = "live";
        if (fresh) this.onBoundary?.();
        if (!this.pingTimer) this.pingTimer = setInterval(() => this.raw({ t: "ping", n: performance.now() }), 3000);
        this.bump();
        break;
      }
      case "delta":
        this.apply(m);
        break;
      case "ack": {
        const c = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (!m.ok) this.toast(m.reason ?? "That didn't work.", "bad");
        if (c) this.onAck?.(m.ok, c, m.reason);
        break;
      }
      case "error":
        if (m.reason === "no such room" || m.reason === "this room is full" || m.reason === "this room is locked to new players" || m.reason.startsWith("this page is out of date")) this.fail(m.reason);
        else this.toast(m.reason, "bad");
        break;
      case "pong":
        this.rtt = Math.round(performance.now() - m.n);
        break;
    }
  }

  private apply(d: Delta): void {
    const s = this.state;
    if (!s) return;
    if (d.gen !== s.gen || d.seq !== this.seq + 1) {
      // a gap (or a stage we haven't got): ask for a fresh snapshot rather than guess
      if (d.seq > this.seq) this.raw({ t: "sync" });
      return;
    }
    this.seq = d.seq;
    s.seq = d.seq;
    s.tick = d.tick;
    for (const p of d.players) {
      s.players[p.id] = p;
      this.sample(p.id, p.x, p.y);
      if (p.id === this.you) this.reconcile(p.x, p.y);
    }
    for (const [id, x, y, dx, dy, facing] of d.moves ?? []) {
      const p = s.players[id];
      if (!p) continue;
      Object.assign(p, { x, y, dx, dy, facing });
      this.sample(id, x, y);
      if (id === this.you) this.reconcile(x, y);
    }
    for (const [i, t] of d.tiles ?? []) {
      const before = s.tiles[i]?.amt ?? 0;
      s.tiles[i] = t;
      if (t.amt < before) this.onTile?.(i, before, t.amt);
    }
    if (d.buildings) for (const b of d.buildings) {
      const at = s.buildings.findIndex((q) => q.id === b.id);
      if (at >= 0) s.buildings[at] = b;
      else s.buildings.push(b);
    }
    if (d.removed) s.buildings = s.buildings.filter((b) => !d.removed!.includes(b.id));
    if (d.lobby) {
      s.lobby = d.lobby;
      for (const a of d.lobby.agents) this.sampleLobby(a.id, a.x, a.y);
    }
    if (d.meta) Object.assign(s, d.meta);
    if (d.log) {
      s.log = [...s.log, ...d.log].slice(-40) as LogEntry[];
    }
    this.bump();
  }

  private sampleLobby(id: number, x: number, y: number): void {
    const buf = this.lobbySamples.get(id) ?? [];
    buf.push({ t: performance.now(), x, y });
    while (buf.length > 8) buf.shift();
    this.lobbySamples.set(id, buf);
  }

  /** Where a lobbyist is drawn: interpolated like a remote player. */
  lobbyPosition(id: number, x: number, y: number): [number, number] {
    const buf = this.lobbySamples.get(id);
    if (!buf?.length) return [x, y];
    const t = performance.now() - TICK_MS * 2;
    for (let i = buf.length - 1; i > 0; i--) {
      const a = buf[i - 1];
      const b = buf[i];
      if (a.t <= t) {
        const k = Math.min(1, Math.max(0, (t - a.t) / Math.max(1, b.t - a.t)));
        return [a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k];
      }
    }
    return [buf[0].x, buf[0].y];
  }

  private sample(id: string, x: number, y: number): void {
    const buf = this.samples.get(id) ?? [];
    buf.push({ t: performance.now(), x, y });
    while (buf.length > 12) buf.shift();
    this.samples.set(id, buf);
  }

  /** Where a remote player is drawn: interpolated ~2 ticks behind the newest update. */
  position(id: string): [number, number] | null {
    const buf = this.samples.get(id);
    if (!buf?.length) return null;
    const t = performance.now() - TICK_MS * 2;
    for (let i = buf.length - 1; i > 0; i--) {
      const a = buf[i - 1];
      const b = buf[i];
      if (a.t <= t) {
        const k = Math.min(1, Math.max(0, (t - a.t) / Math.max(1, b.t - a.t)));
        return [a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k];
      }
    }
    return [buf[0].x, buf[0].y];
  }

  /** Own movement is predicted locally (no collisions, so prediction is exact up to timing) and eased onto the server's answer. */
  predict(dt: number): void {
    const s = this.state;
    if (!s || s.phase.k === "ended") return;
    const w = s.w - 1;
    // the same speed rule as the server (faster along a path), so prediction stays exact
    const v = speedAt(s, this.me.x, this.me.y);
    this.me.x = Math.max(0, Math.min(w, this.me.x + this.me.dx * v * dt));
    this.me.y = Math.max(0, Math.min(w, this.me.y + this.me.dy * v * dt));
  }

  private reconcile(x: number, y: number): void {
    const err = Math.hypot(x - this.me.x, y - this.me.y);
    if (err > 1.5) this.me = { ...this.me, x, y };
    else if (this.me.dx === 0 && this.me.dy === 0) {
      this.me.x += (x - this.me.x) * 0.5;
      this.me.y += (y - this.me.y) * 0.5;
    }
  }
}
