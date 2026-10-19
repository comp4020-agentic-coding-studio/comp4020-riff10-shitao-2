#!/usr/bin/env node
// The touch-only early chain in a real phone-sized browser: harvest, Cottages,
// Sun Garden, help raise both, then a cable between them, every step a real
// CDP touch event (Input.dispatchTouchEvent), never a mouse click or a key.
// A second socket in the room watches the server's state to aim the taps.
// Screenshots of each preview land in /tmp/touchcheck-*.png.
//
//   agent-browser set device "iPhone 12"; agent-browser open <base>/play/?room=<ROOM>
//   node scripts/touchcheck.mjs "$(agent-browser get cdp-url)" <ROOM> [base]
import { writeFileSync } from "node:fs";
import WebSocket from "ws";
const [cdpUrl, room, base = "http://localhost:8080"] = process.argv.slice(2);
if (!cdpUrl || !room) {
  console.error("usage: node scripts/touchcheck.mjs <cdp-browser-ws-url> <room> [baseUrl]");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = new URL(cdpUrl).port;
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page" && t.url.includes(`room=${room}`));
const cdp = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
cdp.on("message", (m) => { const d = JSON.parse(m); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); cdp.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => cdp.once("open", r));
await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
const evaljs = async (expr) => (await call("Runtime.evaluate", { expression: expr, returnByValue: true })).result.result.value;
async function tap(x, y) {
  await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await sleep(50);
  await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(350);
}
async function tapButton(text) {
  const r = await evaljs(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.offsetParent && b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return null; b.scrollIntoView({block: "nearest"}); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  if (!r) throw new Error(`no visible button "${text}"`);
  await tap(r[0], r[1]);
  log(`tapped button "${text}"`);
}
let shot = 0;
async function snap(name) { const r = await call("Page.captureScreenshot", { format: "png" }); writeFileSync(`/tmp/touchcheck-${++shot}-${name}.png`, Buffer.from(r.result.data, "base64")); }
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const t0 = Date.now();

// the observer: a second player whose snapshot tells us where things are
const obs = new WebSocket(base.replace(/^http/, "ws") + "/ws", { headers: { origin: new URL(base).origin } });
let s = null;
const toasts = [];
obs.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.t === "welcome") s = m.snap;
  if (m.t === "delta" && s) {
    for (const [i, t] of m.tiles ?? []) s.tiles[i] = t;
    for (const p of m.players) s.players[p.id] = p;
    for (const [pid, x, y] of m.moves ?? []) Object.assign(s.players[pid] ?? {}, { x, y });
    for (const b of m.buildings ?? []) { const k = s.buildings.findIndex((q) => q.id === b.id); if (k >= 0) s.buildings[k] = b; else s.buildings.push(b); }
    for (const r of m.removed ?? []) s.buildings = s.buildings.filter((b) => b.id !== r);
    if (m.meta) Object.assign(s, m.meta);
  }
});
await new Promise((r) => obs.once("open", r));
obs.send(JSON.stringify({ t: "hello", v: 2, room, name: "Watcher" }));
while (!s) await sleep(50);
const me = () => Object.values(s.players).find((p) => p.name === "Tap");
const W = 390, H = 844;
// the camera centres on the avatar at zoom 1: tile -> screen
const screen = (x, y) => { const p = me(); return [W / 2 + ((x - p.x) - (y - p.y)) * 32, H / 2 + ((x - p.x) + (y - p.y)) * 16]; };
// the world a finger can reach: below the top panels, above the corner buttons and toolbar
let top = 330, bottom = 600;
const measure = async () => { [top, bottom] = await evaljs(`[Math.max(...[...document.querySelectorAll(".col-left, .top-right")].map((e) => e.getBoundingClientRect().bottom)) + 12, Math.min(...[...document.querySelectorAll(".corner-buttons, .bottom")].map((e) => e.getBoundingClientRect().top)) - 12]`); };
const onScreen = ([sx, sy]) => sx > 20 && sx < W - 20 && sy > top && sy < bottom;
async function tapTile(x, y) { await measure(); const [sx, sy] = screen(x, y); if (!onScreen([sx, sy])) throw new Error(`tile ${x},${y} off the open screen at ${sx|0},${sy|0}`); await tap(sx, sy); }
async function walkNear(x, y, within = 1.6) {
  const open = (tx, ty) => { const t = s.tiles[ty * s.w + tx]; return t && t.t === 0 && !t.b && !(t.d && t.amt > 0); };
  for (let k = 0; k < 12; k++) {
    const p = me();
    if (Math.hypot(x - p.x, y - p.y) <= within) return;
    await measure();
    // tap the open-ground tile, within a few tiles of the avatar, closest to the goal
    let best = null, bd = Infinity;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const tx = Math.round(p.x) + dx, ty = Math.round(p.y) + dy;
      if (!open(tx, ty) || !onScreen(screen(tx, ty))) continue;
      const d = Math.hypot(tx - x, ty - y);
      if (d < bd) [bd, best] = [d, [tx, ty]];
    }
    await tapTile(...best);
    await sleep(1400);
  }
  throw new Error("couldn't walk there");
}
const inv = () => `${s.inventory.matter} matter / ${s.inventory.mineral} mineral / ${s.inventory.coolant} coolant`;
async function harvestFamily(fam, want) {
  while (s.inventory[fam] < want) {
    const p = me();
    let best = -1, bd = Infinity;
    s.tiles.forEach((t, i) => { if (t.d === fam && t.amt > 0) { const d = Math.hypot(i % s.w - p.x, Math.floor(i / s.w) - p.y); if (d < bd) [bd, best] = [d, i]; } });
    const x = best % s.w, y = Math.floor(best / s.w);
    await walkNear(x, y);
    const before = s.inventory[fam];
    await tapTile(x, y);
    await sleep(900);
    if (s.inventory[fam] > before) log(`tapped a ${fam} deposit at ${x},${y}: ${inv()}`);
  }
}
/** open ground near the avatar with room for a size x size footprint and its line ends */
function openSpot(size, avoid = []) {
  const p = me();
  const free = (x, y) => { const t = s.tiles[y * s.w + x]; return t && t.t === 0 && !t.b && !(t.d && t.amt > 0) && !t.cb && !t.pa && !t.bt && !t.pp; };
  for (let r = 2; r < 8; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = Math.round(p.x) + dx, y = Math.round(p.y) + dy;
    let ok = x > 0 && y > 0 && x + size < s.w && y + size < s.w;
    for (let a = -1; ok && a <= size; a++) for (let b = -1; ok && b <= size; b++) ok = free(x + a, y + b) && !avoid.some(([ax, ay]) => ax === x + a && ay === y + b);
    if (ok && onScreen(screen(x, y)) && onScreen(screen(x + size - 1, y + size - 1))) return [x, y];
  }
  throw new Error("no open spot on screen");
}
async function build(label, type, size) {
  if (await evaljs(`!!document.querySelector(".tray-folded")`)) await tapButton("Tools");
  await tapButton(label);
  await sleep(300);
  await measure();
  const [x, y] = openSpot(size);
  const n = s.buildings.length;
  await tapTile(x, y);
  log(`aimed ${label} at ${x},${y} (first tap: preview only, buildings ${s.buildings.length})`);
  await sleep(500);
  await snap(`aim-${type}`);
  if (s.buildings.length !== n) throw new Error("first tap built without confirming");
  await tapTile(x, y);
  await sleep(800);
  const b = s.buildings.find((q) => q.type === type && q.x === x && q.y === y);
  if (!b) throw new Error(`${label} wasn't placed: ${JSON.stringify(await evaljs("[...document.querySelectorAll('.toasts p')].map(p=>p.textContent)"))}`);
  log(`second tap placed ${label} (id ${b.id}): ${inv()}`);
  await tapButton("Done");
  return b;
}

try {
  log(`start: ${inv()}`);
  const have = (t) => s.buildings.find((b) => b.type === t && b.owner);
  await harvestFamily("matter", 14);
  await harvestFamily("mineral", 24);
  await harvestFamily("coolant", 4);
  await build("1Cottages", "city", 2);
  await build("4Sun Garden", "solar", 2);
  const city = have("city"), sun = have("solar");
  // help raise both sites by tapping them with the harvest tool, until finished
  for (const b of [city, sun]) {
    for (let k = 0; k < 30; k++) {
      const q = s.buildings.find((z) => z.id === b.id);
      if (!q || q.work >= (q.need ?? 9999) || !String(q.status).startsWith("under construction")) break;
      await walkNear(b.x, b.y, 1.8);
      await tapTile(b.x, b.y);
      await sleep(900);
    }
  }
  await sleep(2000);
  log(`buildings: ${s.buildings.filter((b) => b.owner).map((b) => `${b.type}#${b.id} ${b.status}`).join(", ")}`);
  // a cable from the Sun Garden's edge to the Cottages' edge: tap the start, the end, then confirm
  // a free tile beside each building, the ends at least two tiles apart
  const ring = (b) => [[b.x - 1, b.y], [b.x - 1, b.y + 1], [b.x + 2, b.y], [b.x + 2, b.y + 1], [b.x, b.y - 1], [b.x + 1, b.y - 1], [b.x, b.y + 2], [b.x + 1, b.y + 2]]
    .filter(([x, y]) => { const t = s.tiles[y * s.w + x]; return t && t.t === 0 && !t.b && !t.cb; });
  let from, to, bd = Infinity;
  for (const f of ring(sun)) for (const g of ring(city)) { const d = Math.abs(f[0] - g[0]) + Math.abs(f[1] - g[1]); if (d >= 2 && d < bd) [bd, from, to] = [d, f, g]; }
  // stand between the two ends so both are on screen, as a player would
  await walkNear((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 2.5);
  if (await evaljs(`!!document.querySelector(".tray-folded")`)) await tapButton("Tools");
  await tapButton("cable 1");
  await tapTile(...from);
  log(`tapped cable start ${from}`);
  await tapTile(...to);
  log(`tapped cable end ${to}: preview only, cable tiles ${s.tiles.filter((t) => t.cb).length}`);
  await sleep(400);
  await snap("cable-preview");
  if (s.tiles.some((t) => t.cb)) throw new Error("cable laid without confirming");
  await tapButton("Lay cable");
  await sleep(900);
  const cables = s.tiles.filter((t) => t.cb).length;
  if (!cables) throw new Error(`no cable laid: ${JSON.stringify(await evaljs("[...document.querySelectorAll('.toasts p')].map(p=>p.textContent)"))}`);
  log(`confirm laid ${cables} cable tiles: ${inv()}`);
  await sleep(3000);
  log(`final: ${s.buildings.filter((b) => b.owner).map((b) => `${b.type}#${b.id} ${b.status}`).join(", ")}`);
  await snap("done");
  log("OK");
} catch (e) {
  log(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  obs.close();
  cdp.close();
}
