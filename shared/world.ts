// Small mutation helpers shared by the command handlers (sim.ts), the
// economy (economy.ts) and the Green Lobby (lobby.ts): change tracking, the
// room log and the server's action log, natural-stock accounting, statuses.
import { BUILDINGS, FAMILIES, STAGES, isGood, type Bundle, type Cost, type Family, type Goods, type Item } from "./content.ts";
import type { Building, Ledger, RoomState, Tile } from "./protocol.ts";
import { inBounds } from "./layout.ts";

/** One line of the server's action log: who did what, where. Printed as logfmt by the server. */
export type Ev = { actor: string; name: string; action: string } & Record<string, string | number | boolean>;

/** What changed during one call: the server turns this into a delta. */
export interface Changes {
  tiles: Set<number>;
  buildings: Set<number>;
  removed: number[];
  meta: boolean;
  lobby: boolean;
  log: number;
  /** actions for the server log, in order */
  events: Ev[];
  /** a stage boundary or the ending: save now, then broadcast a fresh snapshot */
  boundary: boolean;
  /** players the host removed: the server closes their sockets */
  removedPlayers: string[];
}

export const newChanges = (): Changes => ({ tiles: new Set(), buildings: new Set(), removed: [], meta: false, lobby: false, log: 0, events: [], boundary: false, removedPlayers: [] });

export function log(s: RoomState, ch: Changes, text: string): void {
  s.log.push({ tick: s.tick, text });
  if (s.log.length > 40) s.log.splice(0, s.log.length - 40);
  ch.log++;
}

export function event(ch: Changes, actor: string, name: string, action: string, fields: Record<string, string | number | boolean> = {}): void {
  // who did it always wins over a field of the same name
  ch.events.push({ ...fields, actor, name, action });
}

export const emptyLedger = (): Ledger =>
  Object.fromEntries(FAMILIES.map((f) => [f, { initial: 0, restored: 0, remaining: 0, extracted: 0, destroyed: 0 }])) as Ledger;

export const emptyGoods = (): Goods => ({ wire: 0, frame: 0, kit: 0 });

export const tileAt = (s: RoomState, x: number, y: number): Tile | undefined => (inBounds(s, x, y) ? s.tiles[y * s.w + x] : undefined);

export const workNeeded = (b: Building): number => b.need ?? BUILDINGS[b.type].build * 10;
export const complete = (b: Building): boolean => b.work >= workNeeded(b);

export const setStatus = (b: Building, status: string, ch: Changes): void => {
  if (b.status !== status) {
    b.status = status;
    ch.buildings.add(b.id);
  }
};

export function remember(s: RoomState, tile: Tile, fate: string, ch: Changes): void {
  if (!tile.mark) return;
  s.archive.push({ stage: STAGES[s.stage].id, name: tile.mark.name, fate });
  log(s, ch, `${tile.mark.name} ${fate}.`);
  tile.was = tile.mark.name;
  delete tile.mark;
  ch.meta = true;
}

/** Stockpile reads and writes over both halves: natural stock and goods. */
export const have = (s: RoomState, item: Item): number => (isGood(item) ? s.goods[item] : s.inventory[item as Family]);
export function add(s: RoomState, item: Item, n: number): void {
  if (isGood(item)) s.goods[item] += n;
  else s.inventory[item as Family] += n;
}
export const affordable = (s: RoomState, cost: Cost): boolean => Object.entries(cost).every(([k, v]) => have(s, k as Item) >= (v ?? 0));
export function pay(s: RoomState, cost: Cost): void {
  for (const [k, v] of Object.entries(cost)) add(s, k as Item, -(v ?? 0));
}
export const sumCost = (...cs: Cost[]): Cost => {
  const out: Cost = {};
  for (const c of cs) for (const [k, v] of Object.entries(c)) out[k as Item] = (out[k as Item] ?? 0) + (v ?? 0);
  return out;
};
/** Half of what was paid, rounded down per item: always strictly less than the cost. */
export const salvageOf = (paid: Cost): Cost => Object.fromEntries(Object.entries(paid).map(([k, v]) => [k, Math.floor((v ?? 0) / 2)]));

/**
 * Take natural stock from a deposit: `useful` units into `into` (the
 * stockpile, or a machine's local store), and up to `waste` more destroyed.
 * Both are clamped to what's there, useful first, so careful work can always
 * take the last unit. Returns [useful, wasted].
 */
export function takeFrom(s: RoomState, idx: number, useful: number, waste: number, ch: Changes, into: Bundle | Partial<Record<Item, number>> = s.inventory): [number, number] {
  const tile = s.tiles[idx];
  if (!tile.d || tile.amt <= 0) return [0, 0];
  const took = Math.min(useful, tile.amt);
  const lost = Math.min(waste, tile.amt - took);
  tile.amt -= took + lost;
  const l = s.ledger[tile.d];
  l.remaining -= took + lost;
  l.extracted += took;
  l.destroyed += lost;
  (into as Record<string, number>)[tile.d] = ((into as Record<string, number>)[tile.d] ?? 0) + took;
  tile.life = Math.min(tile.life, Math.round((tile.amt / tile.init) * 60));
  ch.tiles.add(idx);
  ch.meta = true;
  if (tile.amt === 0) {
    remember(s, tile, "was harvested bare", ch);
    // a grove or pond gone leaves the ground around it poorer
    const x = idx % s.w;
    const y = Math.floor(idx / s.w);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const n = tileAt(s, x + dx, y + dy);
        if (!n || n.t === 2 || (dx === 0 && dy === 0)) continue;
        n.life = Math.max(0, n.life - 15);
        ch.tiles.add((y + dy) * s.w + x + dx);
      }
  }
  return [took, lost];
}

/** Destroy natural stock in place (smoke): off the deposit and onto the books as destroyed. */
export function destroyAt(s: RoomState, idx: number, n: number, ch: Changes, fate: string): number {
  const t = s.tiles[idx];
  if (!t.d || t.amt <= 0) return 0;
  const k = Math.min(n, t.amt);
  t.amt -= k;
  s.ledger[t.d].remaining -= k;
  s.ledger[t.d].destroyed += k;
  t.life = Math.min(t.life, Math.round((t.amt / t.init) * 60));
  ch.tiles.add(idx);
  ch.meta = true;
  if (t.amt === 0) remember(s, t, fate, ch);
  return k;
}

/** Doing its job (a factory mid-batch counts), as opposed to idle, paused or banked. */
export const isRunning = (b: Building): boolean => b.status === "ok" || b.status.startsWith("making");
/** Waiting on something the players could fix: what the HUD and the "!" marker report. */
export const isIdle = (b: Building): boolean => /^(idle|unserved|throttled)/.test(b.status);

export const bankTotal = (b: Bundle): number => FAMILIES.reduce((a, f) => a + b[f], 0);
