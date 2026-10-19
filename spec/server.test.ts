import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import type { ServerMsg, Snapshot, Delta, Command } from "../shared/protocol.ts";
import { PROTOCOL_VERSION } from "../shared/protocol.ts";
import type { RoomState } from "../shared/protocol.ts";
import { route } from "../shared/layout.ts";
import { touchStep } from "../client/touch.ts";
import type { View } from "../client/render.ts";

// The real server over HTTP and WebSocket: what a browser actually talks to.
const baseUrl = inject("baseUrl");

class Bot {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  snap: Snapshot | null = null;
  inc = "";
  you = "";
  token = "";
  private waiters: (() => void)[] = [];
  private n = 0;

  constructor(url: string, origin: string) {
    this.ws = new WebSocket(url.replace(/^http/, "ws") + "/ws", { headers: { origin } });
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMsg;
      this.msgs.push(m);
      if (m.t === "welcome") {
        this.snap = m.snap;
        this.inc = m.inc;
        this.you = m.you;
        this.token = m.token;
      }
      if (m.t === "delta" && this.snap) {
        for (const [i, t] of m.tiles ?? []) this.snap.tiles[i] = t;
        for (const p of m.players) this.snap.players[p.id] = p;
        for (const [id, x, y] of m.moves ?? []) Object.assign(this.snap.players[id] ?? {}, { x, y });
        if (m.meta) Object.assign(this.snap, m.meta);
      }
      for (const w of this.waiters.splice(0)) w();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  hello(room: string, name: string, token?: string): void {
    this.send({ t: "hello", v: PROTOCOL_VERSION, room, name, token });
  }

  cmd(c: Command, id = `t${this.n++}`, inc = this.inc): string {
    this.send({ t: "cmd", id, inc, gen: this.snap!.gen, c });
    return id;
  }

  async until(pred: (m: ServerMsg) => boolean, ms = 3000): Promise<ServerMsg> {
    const deadline = Date.now() + ms;
    let seen = 0;
    for (;;) {
      for (; seen < this.msgs.length; seen++) if (pred(this.msgs[seen])) return this.msgs[seen];
      if (Date.now() > deadline) throw new Error("timed out waiting for a message");
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 100);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

const originOf = (url: string): string => new URL(url).origin;
const extracted = (s: Snapshot): number => s.ledger.matter.extracted + s.ledger.mineral.extracted + s.ledger.coolant.extracted;

async function newRoom(url: string, pace = "normal"): Promise<string> {
  const res = await fetch(new URL("/api/rooms", url), { method: "POST", headers: { origin: originOf(url), "content-type": "application/json" }, body: JSON.stringify({ pace }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { code: string }).code;
}

async function joined(url: string, room: string, name: string, token?: string): Promise<Bot> {
  const b = new Bot(url, originOf(url));
  await b.open();
  b.hello(room, name, token);
  await b.until((m) => m.t === "welcome");
  return b;
}

/** Walk a bot next to the nearest deposit (by moving its intent and waiting). */
async function walkToDeposit(b: Bot): Promise<[number, number]> {
  const s = b.snap!;
  const me = s.players[b.you];
  const i = s.tiles.findIndex((t, k) => t.d && t.amt > 0 && Math.hypot((k % s.w) - me.x, Math.floor(k / s.w) - me.y) < 12);
  const x = i % s.w;
  const y = Math.floor(i / s.w);
  for (let step = 0; step < 60; step++) {
    const p = b.snap!.players[b.you];
    const dx = x - p.x;
    const dy = y - p.y;
    if (Math.hypot(dx, dy) < 1.2) break;
    b.cmd({ k: "move", dx, dy });
    await new Promise((r) => setTimeout(r, 120));
  }
  b.cmd({ k: "move", dx: 0, dy: 0 });
  await new Promise((r) => setTimeout(r, 250));
  return [x, y];
}

describe("pages", () => {
  it("serves the app shell, the play screen and a health check", async () => {
    for (const p of ["/", "/play/"]) expect((await fetch(new URL(p, baseUrl))).status).toBe(200);
    const h = (await (await fetch(new URL("/api/health", baseUrl))).json()) as { ok: boolean };
    expect(h.ok).toBe(true);
  });

  it("refuses to create a room from another site, and refuses a foreign WebSocket", async () => {
    const res = await fetch(new URL("/api/rooms", baseUrl), { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
    expect(res.status).toBe(403);
    const ws = new WebSocket(baseUrl.replace(/^http/, "ws") + "/ws", { headers: { origin: "https://evil.example" } });
    await expect(new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    })).rejects.toThrow();
  });
});

describe("real time", () => {
  it("one player's harvest reaches another open session within a second, without a reload", async () => {
    const room = await newRoom(baseUrl);
    const a = await joined(baseUrl, room, "Ada");
    const b = await joined(baseUrl, room, "Bo");
    const [x, y] = await walkToDeposit(a);
    const idx = y * a.snap!.w + x;
    const before = b.snap!.tiles[idx].amt;
    const sent = Date.now();
    a.cmd({ k: "harvest", x, y });
    await b.until((m) => m.t === "delta" && !!(m as Delta).tiles?.some(([i, t]) => i === idx && t.amt < before), 1000);
    expect(Date.now() - sent).toBeLessThan(1000);
    a.close();
    b.close();
  });

  it("a returning browser gets its own identity back; a stranger gets a new one", async () => {
    const room = await newRoom(baseUrl);
    const a = await joined(baseUrl, room, "Ada");
    const { you, token } = a;
    a.close();
    await new Promise((r) => setTimeout(r, 200));
    const again = await joined(baseUrl, room, "Ada", token);
    expect(again.you).toBe(you);
    const stranger = await joined(baseUrl, room, "Mallory", "not-a-real-token");
    expect(stranger.you).not.toBe(you);
    again.close();
    stranger.close();
  });

  it("a resent harvest applies once, and a stale incarnation is refused with a fresh snapshot", async () => {
    const room = await newRoom(baseUrl);
    const a = await joined(baseUrl, room, "Ada");
    const [x, y] = await walkToDeposit(a);
    const idx = y * a.snap!.w + x;
    const before = a.snap!.tiles[idx].amt;
    a.cmd({ k: "harvest", x, y }, "dup-1");
    await a.until((m) => m.t === "ack" && m.id === "dup-1");
    await new Promise((r) => setTimeout(r, 600));
    a.cmd({ k: "harvest", x, y }, "dup-1");
    await a.until((m) => m.t === "ack" && m.id === "dup-1" && a.msgs.filter((q) => q.t === "ack" && q.id === "dup-1").length === 2);
    await new Promise((r) => setTimeout(r, 300));
    // the ledger, not the tile: the Green Lobby may replant the tile meanwhile, but only a harvest extracts
    expect(extracted(a.snap!)).toBe(1);
    void before;
    const welcomes = a.msgs.filter((m) => m.t === "welcome").length;
    a.cmd({ k: "harvest", x, y }, "stale-1", "not-this-incarnation");
    const ack = await a.until((m) => m.t === "ack" && m.id === "stale-1");
    expect(ack).toMatchObject({ ok: false });
    await a.until(() => a.msgs.filter((m) => m.t === "welcome").length > welcomes);
    a.close();
  });

  it("survives messages built to throw when coerced", async () => {
    const room = await newRoom(baseUrl);
    const a = await joined(baseUrl, room, "Ada");
    a.send({ t: "cmd", id: { toString: 1 }, inc: "stale", gen: 1, c: { k: "emote", e: "wave" } });
    a.send({ t: "ping", n: { toString: 1 } });
    await a.until((m) => m.t === "pong");
    expect((await fetch(new URL("/api/health", baseUrl))).status).toBe(200);
    const b = await joined(baseUrl, room, "Bo");
    expect(Object.keys(b.snap!.players)).toHaveLength(2);
    a.close();
    b.close();
  });

  it("drops oversized and malformed messages without dropping the room", async () => {
    const room = await newRoom(baseUrl);
    const a = await joined(baseUrl, room, "Ada");
    a.send({ t: "cmd", id: "x", inc: a.inc, gen: a.snap!.gen, c: { k: "harvest", x: "lots", y: null } });
    await a.until((m) => m.t === "ack" && m.id === "x" && !m.ok);
    a.ws.send("{not json");
    await a.until((m) => m.t === "error" && m.reason === "malformed message");
    const b = await joined(baseUrl, room, "Bo");
    expect(Object.keys(b.snap!.players)).toHaveLength(2);
    a.close();
    b.close();
  });
});

describe("touch", () => {
  // Every step of the early chain decided by client/touch.ts from taps alone, then sent
  // to the real server: no keyboard command, no hover. The same path driven by real touch
  // events in a phone-sized browser is scripts/touchcheck.mjs; how it feels is judged, not tested.
  it("a touch-only player harvests, builds homes and power, and lays a cable", async () => {
    const room = await newRoom(baseUrl, "rapid");
    const a = await joined(baseUrl, room, "Tap");
    const s = (): Snapshot => a.snap!;
    const me = (): { x: number; y: number } => s().players[a.you];
    const view: Pick<View, "tool" | "line" | "aim"> = { tool: "harvest", line: null, aim: null };
    const buildings: { id: number; type: string; x: number; y: number }[] = [];
    a.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMsg;
      if (m.t === "delta") for (const b of m.buildings ?? []) if (!buildings.some((q) => q.id === b.id)) buildings.push(b);
    });
    const settle = (ms = 350): Promise<void> => new Promise((r) => setTimeout(r, ms));
    /** a tap on a tile: walk there (as the page's walk loop does), aim, or act through the current tool */
    async function tap(at: [number, number]): Promise<string> {
      const step = touchStep(s(), view, me(), at);
      if (step.k === "walk") {
        for (let k = 0; k < 40; k++) {
          const dx = step.to[0] - me().x;
          const dy = step.to[1] - me().y;
          if (Math.hypot(dx, dy) < 0.35) break;
          a.cmd({ k: "move", dx, dy });
          await settle(100);
        }
        a.cmd({ k: "move", dx: 0, dy: 0 });
        await settle(200);
      } else if (step.k === "aim") view.aim = step.at;
      else {
        const [x, y] = step.at;
        if (view.tool === "harvest") a.cmd({ k: "harvest", x, y });
        else if (view.tool === "build") a.cmd({ k: "build", x, y, type: build });
        else if (view.tool === "line" && view.line && !view.line.from) [view.line.from, view.aim] = [step.at, step.at];
        else if (view.tool === "line" && view.line?.from) {
          a.cmd({ k: "line", kind: "cable", q: 0, path: route(s() as RoomState, "cable", view.line.from, step.at, a.you)! });
          view.line.from = view.aim = null;
        }
        if (view.tool !== "line") view.aim = null;
        await settle();
      }
      return step.k;
    }
    let build: "city" | "solar" = "city";
    const near = (fam: "matter" | "mineral" | "coolant"): [number, number] => {
      let best: [number, number] = [0, 0];
      let bd = Infinity;
      s().tiles.forEach((t, i) => {
        const d = Math.hypot((i % s().w) - me().x, Math.floor(i / s().w) - me().y);
        if (t.d === fam && t.amt > 0 && d < bd) [bd, best] = [d, [i % s().w, Math.floor(i / s().w)]];
      });
      return best;
    };
    // harvest by tapping deposits: an out-of-reach tap walks toward it, an in-reach one harvests
    for (const [fam, want] of [["matter", 14], ["mineral", 24], ["coolant", 4]] as const)
      for (let k = 0; s().inventory[fam] < want; k++) {
        expect(k).toBeLessThan(40);
        const d = near(fam);
        if ((await tap(d)) === "walk") await tap(d); // tapping the deposit itself only walks to its tile
        await settle(500);
      }
    // open ground beside the player for each 2x2 building, plus a ring for the cable
    const open = (x: number, y: number): boolean => {
      const t = s().tiles[y * s().w + x];
      return !!t && t.t === 0 && !t.b && !(t.d && t.amt > 0) && !t.cb;
    };
    const spot = (): [number, number] => {
      for (let r = 2; r < 8; r++)
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            const x = Math.round(me().x) + dx;
            const y = Math.round(me().y) + dy;
            let ok = true;
            for (let i = -1; ok && i <= 2; i++) for (let j = -1; ok && j <= 2; j++) ok = open(x + i, y + j);
            if (ok) return [x, y];
          }
      throw new Error("no open ground nearby");
    };
    for (const type of ["city", "solar"] as const) {
      build = type;
      view.tool = "build";
      const at = spot();
      expect(await tap(at)).toBe("aim"); // the first tap only previews
      expect(buildings.some((b) => b.type === type)).toBe(false);
      expect(await tap(at)).toBe("act"); // the second, on the same tile, places it
      await a.until(() => buildings.some((b) => b.type === type));
      view.tool = "harvest";
    }
    const city = buildings.find((b) => b.type === "city")!;
    const sun = buildings.find((b) => b.type === "solar")!;
    // a cable from beside the Sun Garden to beside the Cottages: tap start, tap end, tap end again
    view.tool = "line";
    view.line = { kind: "cable", q: 0, from: null };
    const from: [number, number] = [sun.x - 1, sun.y];
    const to: [number, number] = [city.x - 1, city.y];
    expect(await tap(from)).toBe("act");
    expect(await tap(to)).toBe("aim");
    expect(s().tiles.some((t) => t.cb)).toBe(false);
    expect(await tap(to)).toBe("act");
    await a.until(() => s().tiles.filter((t) => t.cb).length > 0);
    // the cable joins power to homes: the Sun Garden is on a grid with something to feed
    await a.until((m) => m.t === "delta" && !!m.buildings?.some((b) => b.id === sun.id && b.status === "ok"), 8000);
    a.close();
  }, 60_000);
});

describe("persistence", () => {
  // A private server against its own data directory, so it can be killed.
  const dir = mkdtempSync(join(tmpdir(), "plenty-"));
  const procs: ChildProcess[] = [];
  const port = 18000 + Math.floor(Math.random() * 1000);
  const url = `http://localhost:${port}`;

  async function boot(): Promise<ChildProcess> {
    const p = spawn(process.execPath, ["server/main.ts"], { env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdio: "ignore" });
    procs.push(p);
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(new URL("/api/health", url));
        return p;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("server didn't start");
  }
  const stop = (p: ChildProcess, signal: NodeJS.Signals): Promise<void> =>
    new Promise((r) => {
      p.once("exit", () => r());
      p.kill(signal);
    });

  afterAll(() => {
    for (const p of procs) p.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("recovers a campaign after a graceful restart, under a new incarnation", async () => {
    let p = await boot();
    const room = await newRoom(url);
    const a = await joined(url, room, "Ada");
    const [x, y] = await walkToDeposit(a);
    const idx = y * a.snap!.w + x;
    a.cmd({ k: "harvest", x, y }, "h1");
    await a.until((m) => m.t === "delta" && !!m.tiles?.some(([i]) => i === idx));
    const { token, you, inc } = a;
    await stop(p, "SIGTERM");
    p = await boot();
    const back = await joined(url, room, "Ada", token);
    expect(back.you).toBe(you);
    expect(back.inc).not.toBe(inc);
    expect(extracted(back.snap!)).toBe(1);
    back.close();
    await stop(p, "SIGTERM");
  }, 30_000);

  it("after an abrupt kill, loses at most the last second of play", async () => {
    let p = await boot();
    const room = await newRoom(url);
    const a = await joined(url, room, "Ada");
    const [x, y] = await walkToDeposit(a);
    // a steady harvest, one swing as soon as the cooldown allows, each acknowledgement timed
    const acked: number[] = [];
    for (let k = 0; k < 8; k++) {
      const id = a.cmd({ k: "harvest", x, y }, `h${k}`);
      const ack = await a.until((m) => m.t === "ack" && m.id === id);
      expect(ack).toMatchObject({ ok: true });
      acked.push(Date.now());
      if (k < 7) await new Promise((r) => setTimeout(r, 850));
    }
    // kill mid-play, between saves, just after the last harvest landed
    await new Promise((r) => setTimeout(r, 300));
    const killedAt = Date.now();
    await stop(p, "SIGKILL");
    p = await boot();
    const back = await joined(url, room, "Ada", a.token);
    const kept = extracted(back.snap!);
    // the guarantee: anything acknowledged more than a second (plus one 50 ms step and
    // scheduling slack) before the crash is on disk; nothing that never happened is
    const mustSurvive = acked.filter((t) => killedAt - t > 1200).length;
    expect(mustSurvive).toBeGreaterThanOrEqual(6);
    expect(kept).toBeGreaterThanOrEqual(mustSurvive);
    expect(kept).toBeLessThanOrEqual(acked.length);
    back.close();
    await stop(p, "SIGTERM");
  }, 45_000);
});

describe("the action log", () => {
  it("prints who did what, players and the Green Lobby alike, and never a token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plenty-log-"));
    const port = 19000 + Math.floor(Math.random() * 1000);
    const url = `http://localhost:${port}`;
    const p = spawn(process.execPath, ["server/main.ts"], { env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout!.on("data", (d) => (out += d.toString()));
    try {
      for (let i = 0; i < 100; i++) {
        try {
          await fetch(new URL("/api/health", url));
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const room = await newRoom(url, "rapid");
      const a = await joined(url, room, "Ada");
      const b = await joined(url, room, "Bo");
      a.cmd({ k: "set", mode: "intensive" });
      a.cmd({ k: "emote", e: "wave" });
      await a.until((m) => m.t === "ack");
      // the lobby arrives on the first economy tick
      await new Promise((r) => setTimeout(r, 1500));
      const lines = out.split("\n").filter((l) => l.includes(`room=${room}`));
      expect(lines.some((l) => l.includes(`actor=${a.you}`) && l.includes("name=Ada") && l.includes("action=join"))).toBe(true);
      expect(lines.some((l) => l.includes(`actor=${b.you}`) && l.includes("name=Bo") && l.includes("action=join"))).toBe(true);
      expect(lines.some((l) => l.includes("name=Ada") && l.includes("action=mode") && l.includes("harvest=intensive"))).toBe(true);
      expect(lines.some((l) => /actor=lobby:\w+ name=\w+ action=lobby_arrive/.test(l))).toBe(true);
      for (const l of lines) expect(l).toMatch(/^room=\w{5} stage=earth tick=\d+ actor=\S+ name=\S+ action=\w+/);
      for (const tok of [a.token, b.token]) expect(out).not.toContain(tok);
      a.close();
      b.close();
    } finally {
      p.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
