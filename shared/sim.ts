// The authoritative room simulation. Pure functions over a JSON-serialisable
// RoomState, so it runs (and is tested) without a browser or a socket. The
// server owns the only live copy of each room and calls these in order: one
// command or one tick at a time, which is what serialises every mutation.
import {
  BUILDINGS,
  BUILD_RANGE,
  BUILD_SCAR,
  CLAIMS_PER_PLAYER,
  CLAIM_COST,
  CLAIM_SIZE,
  EFFICIENT_BUILD,
  EFFICIENT_EXTRA,
  EMOTES,
  FAMILIES,
  GOODS,
  HARVEST_COOLDOWN_TICKS,
  HARVEST_MODES,
  HARVEST_RANGE,
  INPUT_CAP,
  LINES,
  MARKS_PER_PLAYER,
  MAX_IDENTITIES,
  MAX_PLAYERS,
  PACES,
  RECIPES,
  RECIPE_LIST,
  STAGES,
  SUN_TO_RESERVE,
  TEND_RANGE,
  TICK_MS,
  buildingName,
  isItem,
  itemLabel,
  type Bundle,
  type BuildingType,
  type Cost,
  type Family,
  type Item,
  type LineKind,
  type Pace,
  type Recipe,
} from "./content.ts";
import type { Building, Claim, Command, Ledger, Ops, Player, RoomState, StageSummary, Tile } from "./protocol.ts";
import { SCHEMA_VERSION } from "./protocol.ts";
import { generateStage } from "./worldgen.ts";
import { beltDirs, claimAt, footprint, inBounds, lineOwner, linePathProblem, speedAt } from "./layout.ts";
import { economy, recipeOf } from "./economy.ts";
import { lobbyAct, lobbyMove, newLobby } from "./lobby.ts";
import {
  add,
  affordable,
  complete,
  emptyGoods,
  emptyLedger,
  event,
  have,
  log,
  pay,
  remember,
  salvageOf,
  sumCost,
  takeFrom,
  tileAt,
  workNeeded,
  type Changes,
} from "./world.ts";

export { newChanges, type Changes } from "./world.ts";

export type Result = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Result => ({ ok: false, reason });
const OK: Result = { ok: true };

function ledgerFor(tiles: Tile[]): Ledger {
  const l = emptyLedger();
  for (const t of tiles) if (t.d) {
    l[t.d].initial += t.init;
    l[t.d].remaining += t.amt;
  }
  return l;
}

export const emptyOps = (): Ops => ({
  goods: 0,
  coolantUsed: 0,
  coolantLost: 0,
  energyUsed: 0,
  energyGen: 0,
  solarGen: 0,
  cableLoss: 0,
  firstFactory: null,
  firstDatacentre: null,
  firstAutomation: null,
  busy: 0,
});

/**
 * The land holds only as much life as its world has left: every tile's life
 * is capped by how much of the world remains (60%) and how much of its water,
 * its coolant, remains (40%). So the whole land dries as it's consumed, in
 * whatever order, not just the tiles anyone touched, and draining the pond
 * costs more than its share. Derived from the ledger on both sides, so it
 * costs no traffic.
 */
export const lifeCap = (ledger: Ledger): number => {
  const frac = (rem: number, init: number): number => (init ? Math.min(1, rem / init) : 0);
  const total = FAMILIES.reduce((a, f) => a + ledger[f].remaining, 0);
  const initial = FAMILIES.reduce((a, f) => a + ledger[f].initial, 0);
  const left = 0.6 * frac(total, initial) + 0.4 * frac(ledger.coolant.remaining, ledger.coolant.initial);
  return Math.round(15 + 85 * left);
};

export const effectiveLife = (t: Tile, cap: number): number => Math.min(t.life, cap);

export const averageLife = (s: Pick<RoomState, "tiles" | "ledger">): number => {
  const cap = lifeCap(s.ledger);
  const land = s.tiles.filter((t) => t.t === 0 || t.t === 1 || t.t === 3);
  return Math.round(land.reduce((a, t) => a + effectiveLife(t, cap), 0) / Math.max(1, land.length));
};

const emptyEcon = (): RoomState["econ"] => ({ energySupply: 0, energyUsed: 0, computeSupply: 0, computeUsed: 0, workersSupply: 0, workersUsed: 0, unwired: 0, drawn: 0 });

export function createRoom(code: string, seed: number, pace: Pace): RoomState {
  const g = generateStage(seed, 0);
  const ledger = ledgerFor(g.tiles);
  const s: RoomState = {
    v: SCHEMA_VERSION,
    code,
    seed,
    pace,
    hostId: null,
    tick: 0,
    seq: 0,
    gen: 1,
    stage: 0,
    stageStartTick: 0,
    lifeStart: 100,
    econTicks: 0,
    phase: { k: "play" },
    w: STAGES[0].size,
    tiles: g.tiles,
    buildings: g.buildings,
    nextBuildingId: g.buildings.length + 1,
    inventory: { ...STAGES[0].starter },
    goods: emptyGoods(),
    claims: [],
    nextClaimId: 1,
    lobby: newLobby(0, ledger),
    ops: emptyOps(),
    leak: 0,
    ledger,
    econ: emptyEcon(),
    heat: 0,
    reserve: 0,
    history: [],
    archive: [],
    players: {},
    tokens: {},
    receipts: {},
    log: [],
  };
  s.lifeStart = averageLife(s);
  return s;
}

export const spawnPoint = (s: RoomState): { x: number; y: number } => {
  const st = STAGES[s.stage];
  const c = (st.size - 1) / 2;
  if (st.id === "sun") return { x: c, y: st.size - 4 };
  if (st.id === "system") return { x: c, y: c + 2 };
  return { x: c, y: c };
};

const cleanText = (raw: unknown, max: number): string | null => {
  if (typeof raw !== "string") return null;
  // printable characters only; collapse whitespace; hard length cap
  const t = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
  return t.length > 0 ? t : null;
};
export const cleanName = (raw: unknown): string => cleanText(raw, 16) ?? "Guest";

/** Add a player, or return the existing one. Returns null when the room is full, or locked to newcomers. */
export function join(s: RoomState, id: string, token: string, name: string, ch: Changes): Player | null {
  const existing = s.players[id];
  if (existing) {
    existing.connected = true;
    if (!s.hostId || !s.players[s.hostId]?.connected) s.hostId = id;
    log(s, ch, `${existing.name} is back.`);
    event(ch, id, existing.name, "rejoin");
    ch.meta = true;
    return existing;
  }
  // capacity is seats at the table, not every browser that ever visited
  if (Object.values(s.players).filter((q) => q.connected).length >= MAX_PLAYERS) return null;
  if (s.locked) return null;
  if (Object.keys(s.players).length >= MAX_IDENTITIES) {
    // forget the longest-gone identity; its buildings stay, credited to "someone"
    const gone = Object.values(s.players)
      .filter((q) => !q.connected)
      .sort((a, b) => a.joinedTick - b.joinedTick)[0];
    delete s.players[gone.id];
    delete s.tokens[gone.id];
    delete s.receipts[gone.id];
  }
  const used = new Set(Object.values(s.players).map((p) => p.colour));
  let colour = 0;
  while (used.has(colour)) colour++;
  const sp = spawnPoint(s);
  const n = Object.keys(s.players).length;
  // two browsers called "Ada" stay tellable apart
  const taken = new Set(Object.values(s.players).map((q) => q.name));
  let unique = cleanName(name);
  for (let k = 2; taken.has(unique); k++) unique = `${cleanName(name).slice(0, 13)} ${k}`;
  const p: Player = {
    id,
    name: unique,
    colour,
    x: sp.x + (n % 3) - 1,
    y: sp.y + Math.floor(n / 3) * 0.8,
    dx: 0,
    dy: 0,
    facing: 2,
    act: null,
    connected: true,
    joinedTick: s.tick,
    nextHarvest: 0,
    nextEmote: 0,
    marks: 0,
    mode: "careful",
    stats: { harvested: 0, built: 0, helped: 0 },
  };
  s.players[id] = p;
  s.tokens[id] = token;
  s.receipts[id] = [];
  if (!s.hostId || !s.players[s.hostId]?.connected) s.hostId = id;
  log(s, ch, `${p.name} arrived.`);
  event(ch, id, p.name, "join", { colour });
  ch.meta = true;
  return p;
}

/** A player's connection dropped. Their buildings, claims and stats stay; the host role moves on. */
export function leave(s: RoomState, id: string, ch: Changes): void {
  const p = s.players[id];
  if (!p || !p.connected) return;
  p.connected = false;
  p.dx = p.dy = 0;
  if (s.hostId === id) {
    const next = Object.values(s.players)
      .filter((q) => q.connected)
      .sort((a, b) => a.joinedTick - b.joinedTick)[0];
    s.hostId = next ? next.id : id;
  }
  log(s, ch, `${p.name} stepped away.`);
  event(ch, id, p.name, "leave");
  ch.meta = true;
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
const near = (p: Pick<Player, "x" | "y">, x: number, y: number, range: number): boolean => Math.hypot(p.x - x, p.y - y) <= range;

export const isHost = (s: RoomState, id: string): boolean => s.hostId === id;

const ownerName = (s: RoomState, id: string | null | undefined): string => (id ? (s.players[id]?.name ?? "someone") : "the Cooperative");

/** What a building costs to build, standard or efficient. */
export const buildCost = (type: BuildingType, eff: boolean): Cost => (eff ? sumCost(BUILDINGS[type].cost, EFFICIENT_EXTRA) : BUILDINGS[type].cost);

/** The first thing a cost is short of, as a player reads it: "needs 6 wire (have 2)". */
export function shortfall(s: RoomState, cost: Cost): string | null {
  const st = STAGES[s.stage];
  for (const [k, v] of Object.entries(cost)) {
    const n = have(s, k as Item);
    if (n < (v ?? 0)) return `needs ${v} ${itemLabel(st, k as Item)} (have ${n})`;
  }
  return null;
}

/** Every shortage at once, for the build preview. */
export function shortfalls(s: RoomState, cost: Cost): string[] {
  const st = STAGES[s.stage];
  return Object.entries(cost)
    .filter(([k, v]) => have(s, k as Item) < (v ?? 0))
    .map(([k, v]) => `${v} ${itemLabel(st, k as Item)} (have ${have(s, k as Item)})`);
}

/** Why a building can't go here, or null if it can. Shared by server and the ghost preview. */
export function placementProblem(s: RoomState, type: BuildingType, x: number, y: number, p?: Pick<Player, "id" | "x" | "y">, eff = false): string | null {
  const st = STAGES[s.stage];
  if (!st.buildings.includes(type)) return `nothing like that can be built on ${st.name}`;
  const def = BUILDINGS[type];
  if (eff && !def.kit) return `there's no efficient ${buildingName(st, type)}`;
  for (const [fx, fy] of footprint({ type, x, y })) {
    const t = tileAt(s, fx, fy);
    if (!t) return "off the edge of the map";
    if (t.b) return "something is already built here";
    if (t.d && t.amt > 0) return `there's ${st.families[t.d].label} here: harvest it first`;
    if (t.t === 1) return "can't build on water";
    if (t.t === 3) return "can't build on the star itself";
    if (t.t === 2 && !def.floats) return "nothing to build on: only relays and taps float in open space";
    if (t.cb || t.pp || t.bt || t.pa) return "a line runs here: take it up first, or build beside it";
    const c = claimAt(s, fx, fy);
    if (c && p && c.owner !== p.id) return `that's ${ownerName(s, c.owner)}'s land`;
    if (def.needsClaim && (!c || (p && c.owner !== p.id))) return c ? `that's ${ownerName(s, c.owner)}'s land` : "claim this ground first: the whole footprint inside your own claim";
  }
  if (p && !near(p, x + (def.size - 1) / 2, y + (def.size - 1) / 2, BUILD_RANGE)) return "too far away: walk closer";
  return shortfall(s, buildCost(type, eff));
}

/** Why this player can't claim the 4x4 square with this top-left corner, or null. */
export function claimProblem(s: RoomState, x: number, y: number, p: Pick<Player, "id" | "x" | "y">): string | null {
  if (!isInt(x) || !isInt(y) || x < 0 || y < 0 || x + CLAIM_SIZE > s.w || y + CLAIM_SIZE > s.w) return "a claim has to fit on the map";
  if (s.claims.filter((c) => c.owner === p.id).length >= CLAIMS_PER_PLAYER) return `you can hold ${CLAIMS_PER_PLAYER} claims per world: give one up first`;
  for (const c of s.claims)
    if (x < c.x + CLAIM_SIZE && c.x < x + CLAIM_SIZE && y < c.y + CLAIM_SIZE && c.y < y + CLAIM_SIZE) return c.owner === p.id ? "that overlaps your own claim" : `that's ${ownerName(s, c.owner)}'s land`;
  let ground = 0;
  for (let dy = 0; dy < CLAIM_SIZE; dy++)
    for (let dx = 0; dx < CLAIM_SIZE; dx++) {
      const t = s.tiles[(y + dy) * s.w + x + dx];
      if (t.b) {
        const b = s.buildings.find((q) => q.id === t.b)!;
        // never capture someone else's building, or the Cooperative's
        if (b.owner !== p.id) return `the ${buildingName(STAGES[s.stage], b.type)} there is ${ownerName(s, b.owner)}'s: claim around it`;
      }
      for (const k of ["cable", "pipe", "belt", "path"] as LineKind[]) {
        const o = lineOwner(t, k);
        if (o && o !== p.id) return `${ownerName(s, o)}'s ${k} runs there: claim around it`;
      }
      if (t.t === 0) ground++;
    }
  if (ground < 4) return "there's hardly any ground to build on there";
  if (!near(p, x + CLAIM_SIZE / 2 - 0.5, y + CLAIM_SIZE / 2 - 0.5, BUILD_RANGE)) return "too far away: walk closer";
  return shortfall(s, CLAIM_COST);
}

function receipt(s: RoomState, pid: string, cmdId: string): void {
  const r = (s.receipts[pid] ??= []);
  r.push(cmdId);
  if (r.length > 64) r.splice(0, r.length - 64);
}

export function applyCommand(s: RoomState, pid: string, cmdId: string, gen: number, c: Command, ch: Changes): Result {
  const p = s.players[pid];
  if (!p) return no("not in this room");
  if (typeof cmdId !== "string" || cmdId.length < 1 || cmdId.length > 40) return no("bad command id");
  if (gen !== s.gen) return no("that was meant for a world that's gone");
  if (!c || typeof c !== "object") return no("malformed command");

  if (c.k === "move") {
    // continuous intent, idempotent by nature: not receipted
    if (typeof c.dx !== "number" || typeof c.dy !== "number" || !Number.isFinite(c.dx) || !Number.isFinite(c.dy)) return no("malformed move");
    const len = Math.hypot(c.dx, c.dy);
    p.dx = len > 1 ? c.dx / len : c.dx;
    p.dy = len > 1 ? c.dy / len : c.dy;
    return OK;
  }

  if (s.phase.k !== "play") return no(s.phase.k === "ended" ? "there is nothing left" : "the world is changing: wait a moment");
  // a retry of a command that was applied is acknowledged again, not applied again;
  // only applied commands are receipted, so a refused one can be retried for real
  if (s.receipts[pid]?.includes(cmdId)) return OK;
  const res = mutate(s, p, c, ch);
  if (res.ok) receipt(s, pid, cmdId);
  return res;
}

const buildingOn = (s: RoomState, x: unknown, y: unknown): Building | undefined => {
  if (!isInt(x) || !isInt(y)) return undefined;
  const t = tileAt(s, x, y);
  return t?.b ? s.buildings.find((q) => q.id === t.b) : undefined;
};

/** Owners control their machines; the host can step in to recover a room. */
const mayControl = (s: RoomState, b: Building, pid: string): boolean => b.owner === pid || isHost(s, pid) || (b.owner === null && !BUILDINGS[b.type].protected);

const fmt = (c: Partial<Record<Item, number>>): string =>
  Object.entries(c)
    .filter(([, v]) => v)
    .map(([k, v]) => `${v} ${k}`)
    .join(" + ") || "nothing";

function mutate(s: RoomState, p: Player, c: Exclude<Command, { k: "move" }>, ch: Changes): Result {
  const pid = p.id;
  const st = STAGES[s.stage];
  const ev = (action: string, fields: Record<string, string | number | boolean> = {}): void => event(ch, pid, p.name, action, fields);

  switch (c.k) {
    case "harvest": {
      if (!isInt(c.x) || !isInt(c.y) || !inBounds(s, c.x, c.y)) return no("off the map");
      if (s.tick < p.nextHarvest) return no("too fast");
      if (!near(p, c.x, c.y, HARVEST_RANGE)) return no("too far away");
      const idx = c.y * s.w + c.x;
      const tile = s.tiles[idx];
      if (tile.b) {
        const b = s.buildings.find((q) => q.id === tile.b)!;
        if (complete(b)) return no(`the ${buildingName(st, b.type)} is already built`);
        b.work = Math.min(workNeeded(b), b.work + 5);
        ch.buildings.add(b.id);
        p.stats.helped++;
        p.nextHarvest = s.tick + HARVEST_COOLDOWN_TICKS;
        p.act = { k: "build", until: s.tick + 4 };
        return OK;
      }
      if (!tile.d || tile.amt <= 0) return no("nothing to harvest there");
      const mode = HARVEST_MODES[p.mode];
      const y = PACES[s.pace].harvestYield;
      const fam = tile.d;
      const [took, lost] = takeFrom(s, idx, mode.useful * y, mode.waste * y, ch);
      if (mode.scar) {
        tile.life = Math.max(0, tile.life - mode.scar);
        ch.tiles.add(idx);
      }
      withdraw(s, p, ch);
      p.stats.harvested += took;
      p.nextHarvest = s.tick + HARVEST_COOLDOWN_TICKS;
      p.act = { k: "harvest", until: s.tick + 4 };
      p.facing = facingTo(c.x - p.x, c.y - p.y, p.facing);
      // one log line per tile emptied, not per swing: enough to narrate, not a flood
      if (tile.amt === 0) ev("harvest_bare", { family: fam, x: c.x, y: c.y, mode: p.mode });
      else if (p.stats.harvested % 20 < took) ev("harvest", { family: fam, took, wasted: lost, x: c.x, y: c.y, mode: p.mode, total: p.stats.harvested });
      checkExhausted(s, ch);
      return OK;
    }
    case "build": {
      if (!isInt(c.x) || !isInt(c.y) || typeof c.type !== "string" || !Object.hasOwn(BUILDINGS, c.type)) return no("malformed build");
      const eff = c.eff === true;
      const problem = placementProblem(s, c.type, c.x, c.y, p, eff);
      if (problem) return no(problem);
      const def = BUILDINGS[c.type];
      const cost = buildCost(c.type, eff);
      // payment and occupancy commit together: nothing between them can fail
      pay(s, cost);
      const b: Building = { id: s.nextBuildingId++, type: c.type, x: c.x, y: c.y, owner: pid, work: 0, status: "under construction", paid: { ...cost } };
      if (eff) {
        b.eff = true;
        b.kit = true;
        b.need = Math.round(def.build * 10 * EFFICIENT_BUILD);
      }
      if (c.type === "factory") b.recipe = "auto";
      if (c.type === "extractor") b.mode = "intensive";
      s.buildings.push(b);
      for (const [fx, fy] of footprint(b)) {
        const idx = fy * s.w + fx;
        const tile = s.tiles[idx];
        tile.b = b.id;
        if (c.type !== "plaza") tile.life = Math.min(tile.life, eff ? BUILD_SCAR.efficient : BUILD_SCAR.standard);
        ch.tiles.add(idx);
        remember(s, tile, `became a ${buildingName(st, c.type)}`, ch);
      }
      ch.buildings.add(b.id);
      ch.meta = true;
      withdraw(s, p, ch);
      p.stats.built++;
      p.act = { k: "build", until: s.tick + 6 };
      log(s, ch, `${p.name} started ${eff ? "an efficient" : "a"} ${buildingName(st, c.type)}.`);
      ev("build", { building: c.type, id: b.id, x: c.x, y: c.y, eff, cost: fmt(cost) });
      return OK;
    }
    case "claim": {
      const why = claimProblem(s, c.x, c.y, p);
      if (why) return no(why);
      pay(s, CLAIM_COST);
      const claim: Claim = { id: s.nextClaimId++, owner: pid, x: c.x, y: c.y };
      s.claims.push(claim);
      ch.meta = true;
      log(s, ch, `${p.name} staked a claim.`);
      ev("claim", { claim: claim.id, x: c.x, y: c.y, size: CLAIM_SIZE });
      return OK;
    }
    case "unclaim": {
      if (!isInt(c.x) || !isInt(c.y)) return no("malformed unclaim");
      const claim = claimAt(s, c.x, c.y);
      if (!claim) return no("nobody has claimed that ground");
      if (claim.owner !== pid && !isHost(s, pid)) return no(`that's ${ownerName(s, claim.owner)}'s land: only they or the host can give it up`);
      s.claims = s.claims.filter((q) => q.id !== claim.id);
      ch.meta = true;
      log(s, ch, `${p.name} gave up ${claim.owner === pid ? "a claim" : `${ownerName(s, claim.owner)}'s claim`}.`);
      ev("unclaim", { claim: claim.id, owner: claim.owner, x: claim.x, y: claim.y });
      return OK;
    }
    case "line": {
      if (typeof c.kind !== "string" || !Object.hasOwn(LINES, c.kind)) return no("malformed line");
      if (c.q !== 0 && c.q !== 1) return no("malformed line");
      if (!Array.isArray(c.path) || !c.path.every((q) => Array.isArray(q) && q.length === 2 && isInt(q[0]) && isInt(q[1]))) return no("malformed line");
      if (c.d !== undefined && ![0, 1, 2, 3].includes(c.d)) return no("malformed line");
      const spec = LINES[c.kind];
      const unit = spec.cost[c.q];
      if (!unit) return no(`there's only one kind of ${c.kind}`);
      const why = linePathProblem(s, c.kind, c.path, p);
      if (why) return no(why);
      const idxs = c.path.map(([x, y]) => y * s.w + x);
      // tiles that already carry this kind are reused: a belt is re-aimed, the rest kept
      const fresh = idxs.filter((i) => !hasKind(s.tiles[i], c.kind));
      for (const i of idxs) {
        const o = lineOwner(s.tiles[i], c.kind);
        if (o && o !== pid && !isHost(s, pid) && c.kind === "belt") return no(`that's ${ownerName(s, o)}'s belt: you can feed it, not re-aim it`);
      }
      if (!fresh.length && c.kind !== "belt") return no(`there's already ${c.kind} all along there`);
      const cost: Cost = {};
      for (const [k, v] of Object.entries(unit)) cost[k as Item] = (v ?? 0) * fresh.length;
      const short = shortfall(s, cost);
      if (short) return no(short);
      pay(s, cost);
      const dirs = c.kind === "belt" ? beltDirs(c.path, c.d) : [];
      // a belt branched off the middle of another belt makes that tile a splitter: it keeps its arrow
      // and alternates items between straight on and the branch
      const branch = c.kind === "belt" && c.path.length > 1 && !!s.tiles[idxs[0]].bt && dirs[0] !== s.tiles[idxs[0]].bt!.d && (dirs[0] + 2) % 4 !== s.tiles[idxs[0]].bt!.d;
      idxs.forEach((i, k) => {
        const t = s.tiles[i];
        const isNew = !hasKind(t, c.kind);
        if (c.kind === "cable") t.cb ??= pid;
        else if (c.kind === "pipe") t.pp ??= [pid, c.q];
        else if (c.kind === "path") t.pa ??= [pid, c.q];
        else if (t.bt && k === 0 && branch) t.bt.sp = 1;
        else if (t.bt) t.bt.d = dirs[k];
        else t.bt = { o: pid, d: dirs[k], q: c.q, n: 0 };
        if (isNew) t.life = Math.min(t.life, spec.life[c.q]);
        ch.tiles.add(i);
      });
      ch.meta = true;
      const [a, b] = [c.path[0], c.path[c.path.length - 1]];
      log(s, ch, `${p.name} laid ${fresh.length} tile${fresh.length === 1 ? "" : "s"} of ${spec.q[c.q]}${branch ? ", branching off with a splitter" : ""}.`);
      ev("line", { kind: c.kind, quality: spec.q[c.q]!, tiles: fresh.length, from: `${a[0]},${a[1]}`, to: `${b[0]},${b[1]}`, cost: fmt(cost), ...(branch ? { splitter: `${a[0]},${a[1]}` } : {}) });
      return OK;
    }
    case "unline": {
      if (!isInt(c.x) || !isInt(c.y) || typeof c.kind !== "string" || !Object.hasOwn(LINES, c.kind)) return no("malformed unline");
      const t = tileAt(s, c.x, c.y);
      if (!t || !hasKind(t, c.kind)) return no(`no ${c.kind} there`);
      const o = lineOwner(t, c.kind)!;
      if (o !== pid && !isHost(s, pid)) return no(`that's ${ownerName(s, o)}'s ${c.kind}: only they or the host can take it up`);
      const q = c.kind === "pipe" ? t.pp![1] : c.kind === "path" ? t.pa![1] : c.kind === "belt" ? t.bt!.q : 0;
      const back = salvageOf(LINES[c.kind].cost[q]!);
      // what rode the belt comes back once, separately from salvage
      const load: Partial<Record<Item, number>> = {};
      if (c.kind === "belt" && t.bt?.it && t.bt.n > 0) load[t.bt.it] = t.bt.n;
      for (const [k, v] of Object.entries(back)) add(s, k as Item, v ?? 0);
      for (const [k, v] of Object.entries(load)) add(s, k as Item, v ?? 0);
      if (c.kind === "cable") delete t.cb;
      else if (c.kind === "pipe") delete t.pp;
      else if (c.kind === "belt") delete t.bt;
      else delete t.pa;
      ch.tiles.add(c.y * s.w + c.x);
      ch.meta = true;
      ev("unline", { kind: c.kind, owner: o, x: c.x, y: c.y, salvage: fmt(back), returned: fmt(load) });
      return OK;
    }
    case "tend": {
      // load a machine from the shared stockpile, or collect its output into it
      const b = buildingOn(s, c.x, c.y);
      if (!b) return no("nothing built there");
      if (!complete(b)) return no("it isn't finished yet: press E beside it to help");
      const [cx, cy] = [b.x + (BUILDINGS[b.type].size - 1) / 2, b.y + (BUILDINGS[b.type].size - 1) / 2];
      if (!near(p, cx, cy, TEND_RANGE + BUILDINGS[b.type].size / 2)) return no("stand beside it to load or collect");
      const moved: Partial<Record<Item, number>> = {};
      const took: Partial<Record<Item, number>> = {};
      // collecting is anyone's: output already belongs to the shared stockpile
      if (b.out) for (const [k, v] of Object.entries(b.out)) if (v) {
        add(s, k as Item, v);
        took[k as Item] = v;
        b.out[k as Item] = 0;
      }
      if (b.type === "intake" && b.tank) {
        took.coolant = b.tank;
        s.inventory.coolant += b.tank;
        b.tank = 0;
      }
      if (b.type === "factory") {
        // top up the inputs for what it's making now, or will make next
        const recipes: Recipe[] = b.job ? [b.job.r] : b.recipe && b.recipe !== "auto" ? [b.recipe] : ["wire", "frame"];
        b.buf ??= {};
        for (const r of recipes)
          for (const [k, need] of Object.entries(recipeOf(b, r).in)) {
            const item = k as Item;
            const want = Math.min(INPUT_CAP, (need ?? 0) * 2) - (b.buf[item] ?? 0);
            const n = Math.max(0, Math.min(want, have(s, item)));
            if (n > 0) {
              add(s, item, -n);
              b.buf[item] = (b.buf[item] ?? 0) + n;
              moved[item] = (moved[item] ?? 0) + n;
            }
          }
      }
      const tank = BUILDINGS[b.type].tank;
      if (tank && b.type !== "intake" && !b.legacy) {
        const n = Math.max(0, Math.min(tank - (b.tank ?? 0), s.inventory.coolant, 10));
        if (n > 0) {
          s.inventory.coolant -= n;
          b.tank = (b.tank ?? 0) + n;
          moved.coolant = n;
        }
      }
      const any = Object.values(moved).some(Boolean) || Object.values(took).some(Boolean);
      if (!any) {
        if (b.type === "factory") return no(`nothing to load: the stockpile has none of what it needs`);
        if (tank) return no(`nothing to fill it with: the stockpile has no ${st.families.coolant.label}`);
        return no("nothing to load or collect here");
      }
      ch.buildings.add(b.id);
      ch.meta = true;
      ev("tend", { building: b.type, id: b.id, owner: b.owner ?? "", loaded: fmt(moved), collected: fmt(took) });
      return OK;
    }
    case "set": {
      const isMode = (m: unknown): m is keyof typeof HARVEST_MODES => typeof m === "string" && Object.hasOwn(HARVEST_MODES, m);
      if (c.mode !== undefined && c.x === undefined) {
        // the player's own hand-harvest mode
        if (!isMode(c.mode)) return no("unknown harvest mode");
        if (p.mode !== c.mode) {
          p.mode = c.mode;
          ev("mode", { harvest: c.mode });
        }
        return OK;
      }
      const b = buildingOn(s, c.x, c.y);
      if (!b) return no("nothing built there");
      if (!mayControl(s, b, pid)) return no(`that's ${ownerName(s, b.owner)}'s ${buildingName(st, b.type)}: only they or the host can change it`);
      // check every field before applying any, so a refused setting changes nothing
      if (c.recipe !== undefined) {
        if (b.type !== "factory") return no("only a factory has recipes");
        if (c.recipe !== "auto" && !(typeof c.recipe === "string" && (RECIPE_LIST as string[]).includes(c.recipe))) return no("unknown recipe");
      }
      if (c.target !== undefined && (b.type !== "factory" || !isInt(c.target) || c.target < 0 || c.target > 99)) return no("a target is a whole number from 0 to 99");
      if (c.quick !== undefined) {
        if (b.type !== "factory" || typeof c.quick !== "boolean") return no("malformed setting");
        if (!b.kit) return no("only a factory with an efficiency kit has a choice of recipes");
      }
      if (c.mode !== undefined && (b.type !== "extractor" || !isMode(c.mode))) return no("only a harvester has a mode");
      const changes: Record<string, string | number | boolean> = {};
      // a batch in progress finishes as it was started: switching never refunds or duplicates it
      if (c.recipe !== undefined) b.recipe = changes.recipe = c.recipe;
      if (c.target !== undefined) b.target = changes.target = c.target;
      if (c.quick !== undefined) b.quick = changes.quick = c.quick;
      if (c.mode !== undefined) b.mode = changes.mode = c.mode;
      if (!Object.keys(changes).length) return no("nothing to change");
      ch.buildings.add(b.id);
      ev("set", { building: b.type, id: b.id, owner: b.owner ?? "", ...changes });
      return OK;
    }
    case "upgrade": {
      const b = buildingOn(s, c.x, c.y);
      if (!b) return no("nothing built there");
      const def = BUILDINGS[b.type];
      if (!def.kit) return no(`there's no efficiency kit for a ${buildingName(st, b.type)}`);
      if (b.kit) return no("it already has an efficiency kit");
      if (!complete(b)) return no("finish building it first");
      if (!mayControl(s, b, pid)) return no(`that's ${ownerName(s, b.owner)}'s ${buildingName(st, b.type)}: only they or the host can upgrade it`);
      if (s.goods.kit < 1) return no(`needs 1 ${st.goods.kit} (have 0): make one in a factory`);
      s.goods.kit--;
      b.kit = true;
      b.paid = sumCost(b.paid ?? def.cost, { kit: 1 });
      ch.buildings.add(b.id);
      ch.meta = true;
      log(s, ch, `${p.name} fitted an efficiency kit to a ${buildingName(st, b.type)}.`);
      ev("upgrade", { building: b.type, id: b.id, owner: b.owner ?? "" });
      return OK;
    }
    case "demolish": {
      const b = buildingOn(s, c.x, c.y);
      if (!isInt(c.x) || !isInt(c.y)) return no("malformed demolish");
      if (!b) return no("nothing built there");
      const def = BUILDINGS[b.type];
      if (def.protected) return no("the Depot is shared: nobody can take it down");
      if (def.renderValue) {
        if (!isHost(s, pid)) return no("only the host can render down a world");
        s.reserve += def.renderValue;
        s.archive.push({ stage: st.id, name: b.name ?? "A world", fate: `was rendered down for ${def.renderValue} energy` });
        log(s, ch, `${p.name} rendered down ${b.name}.`);
        ev("render", { building: b.type, id: b.id, world: b.name ?? "", energy: def.renderValue });
      } else {
        if (b.owner !== pid && !isHost(s, pid)) return no("only its builder or the host can take this down");
        // lossy salvage: always strictly less than the cost, goods included, so no refund loop
        const salvage = salvageOf(b.paid ?? def.cost);
        for (const [k, v] of Object.entries(salvage)) add(s, k as Item, v ?? 0);
        // what it held comes back exactly once, separately; a batch in progress keeps its committed inputs
        const held: Partial<Record<Item, number>> = {};
        const put = (k: Item, n: number): void => {
          if (n > 0) held[k] = (held[k] ?? 0) + n;
        };
        for (const st2 of [b.buf, b.out]) if (st2) for (const [k, v] of Object.entries(st2)) put(k as Item, v ?? 0);
        if (b.job) for (const [k, v] of Object.entries(b.job.in ?? (b.job.eff ? RECIPES[b.job.r].efficient.in : RECIPES[b.job.r].quick.in))) put(k as Item, v ?? 0);
        if (b.tank) put("coolant", b.tank);
        for (const [k, v] of Object.entries(held)) add(s, k as Item, v ?? 0);
        log(s, ch, `${p.name} took down ${b.owner === pid ? "a" : `${ownerName(s, b.owner)}'s`} ${buildingName(st, b.type)}.`);
        ev("demolish", { building: b.type, id: b.id, owner: b.owner ?? "", salvage: fmt(salvage), returned: fmt(held) });
      }
      for (const [fx, fy] of footprint(b)) {
        const idx = fy * s.w + fx;
        s.tiles[idx].b = 0;
        ch.tiles.add(idx);
      }
      s.buildings = s.buildings.filter((q) => q.id !== b.id);
      ch.removed.push(b.id);
      ch.meta = true;
      return OK;
    }
    case "emote": {
      if (!(EMOTES as readonly string[]).includes(c.e)) return no("unknown emote");
      if (s.tick < p.nextEmote) return no("too fast");
      p.act = { k: "emote", e: c.e, until: s.tick + 25 };
      p.nextEmote = s.tick + 8;
      return OK;
    }
    case "mark": {
      if (!isInt(c.x) || !isInt(c.y)) return no("malformed mark");
      const tile = tileAt(s, c.x, c.y);
      const name = cleanText(c.name, 24);
      if (!tile) return no("off the map");
      if (!name) return no("give the place a name");
      if (tile.b) return no("pick somewhere nothing is built");
      if (tile.mark) return no(`that's already ${tile.mark.name}`);
      if (p.marks >= MARKS_PER_PLAYER) return no(`you can name ${MARKS_PER_PLAYER} places per world`);
      if (!near(p, c.x, c.y, BUILD_RANGE)) return no("too far away");
      tile.mark = { name, by: p.name };
      p.marks++;
      ch.tiles.add(c.y * s.w + c.x);
      log(s, ch, `${p.name} named a place ${name}.`);
      ev("mark", { x: c.x, y: c.y, place: name });
      return OK;
    }
    case "stop": {
      if (STAGES[s.stage].id !== "universe") return no("there's always another world, until the last one");
      if (typeof c.on !== "boolean") return no("malformed vote");
      // a dropped connection never ends the campaign: if a holdout leaves, someone
      // still here confirms by voting again
      if (p.stop !== c.on) {
        p.stop = c.on;
        log(s, ch, c.on ? `${p.name} wants to stop here and leave the rest alone.` : `${p.name} wants to keep going.`);
        ev("vote_stop", { on: c.on });
        ch.meta = true;
      }
      checkRestraint(s, ch);
      return OK;
    }
    case "remove": {
      // moderation: the host can send a player away and forget their session, so
      // they come back (if the room is open) as a stranger with nothing of theirs to control
      if (typeof c.who !== "string") return no("malformed removal");
      if (!isHost(s, pid)) return no("only the host can remove a player");
      const q = Object.hasOwn(s.players, c.who) ? s.players[c.who] : undefined;
      if (!q) return no("nobody by that id is in this room");
      if (q.id === pid) return no("you can't remove yourself: just leave");
      leave(s, q.id, ch);
      delete s.tokens[q.id];
      s.receipts[q.id] = [];
      log(s, ch, `${p.name} asked ${q.name} to leave.`);
      ev("remove", { target: q.id, target_name: q.name });
      ch.removedPlayers.push(q.id);
      ch.meta = true;
      return OK;
    }
    case "lock": {
      if (typeof c.on !== "boolean") return no("malformed lock");
      if (!isHost(s, pid)) return no("only the host can lock the room");
      if (!!s.locked !== c.on) {
        s.locked = c.on;
        log(s, ch, c.on ? `${p.name} closed the room to new players.` : `${p.name} opened the room to new players.`);
        ev("lock", { on: c.on });
        ch.meta = true;
      }
      return OK;
    }
    default:
      return no("unknown command");
  }
}

const hasKind = (t: Tile, kind: LineKind): boolean => (kind === "cable" ? !!t.cb : kind === "pipe" ? !!t.pp : kind === "belt" ? !!t.bt : !!t.pa);

function withdraw(s: RoomState, p: Player, ch: Changes): void {
  if (!p.stop) return;
  p.stop = false;
  log(s, ch, `${p.name} went back to work.`);
}

function summarise(s: RoomState): StageSummary {
  const st = STAGES[s.stage];
  return {
    stage: st.id,
    ledger: structuredClone(s.ledger),
    lifeStart: s.lifeStart,
    lifeEnd: averageLife(s),
    buildings: s.buildings.filter((b) => b.owner).length,
    ticks: s.tick - s.stageStartTick,
    lost: s.archive.filter((a) => a.stage === st.id).map((a) => a.name),
    ops: structuredClone(s.ops),
  };
}

/**
 * The restraint ending: if everyone present in the Universe agrees to stop,
 * the campaign ends with what's left still out there. It can't be undone, and
 * absent players can't block it (or make it happen) by staying away.
 */
export function checkRestraint(s: RoomState, ch: Changes): void {
  if (s.phase.k !== "play" || STAGES[s.stage].id !== "universe") return;
  const here = Object.values(s.players).filter((p) => p.connected);
  if (here.length === 0 || !here.every((p) => p.stop)) return;
  const left = totalRemaining(s);
  if (left === 0) return;
  s.history.push(summarise(s));
  for (const t of s.tiles) if (t.mark) s.archive.push({ stage: "universe", name: t.mark.name, fate: "is still there" });
  s.archive.push({ stage: "universe", name: `${left} units of the Universe`, fate: "were left alone" });
  s.phase = { k: "ended", how: "restraint" };
  s.lobby.agents = [];
  for (const p of Object.values(s.players)) p.dx = p.dy = 0;
  log(s, ch, "You stopped. The rest is still out there.");
  event(ch, "room", "room", "ending", { how: "restraint", left });
  ch.meta = true;
  ch.lobby = true;
  ch.boundary = true;
}

export function facingTo(dx: number, dy: number, fallback: number): number {
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return fallback;
  return (Math.round((Math.atan2(dy, dx) / (Math.PI * 2)) * 8) + 8) % 8;
}

/** Exact exhaustion moves the room on: nothing else gates it, and the lobby stops at once. */
function checkExhausted(s: RoomState, ch: Changes): void {
  if (s.phase.k !== "play") return;
  if (FAMILIES.some((f) => s.ledger[f].remaining > 0)) return;
  const st = STAGES[s.stage];
  for (const t of s.tiles) if (t.mark) {
    s.archive.push({ stage: st.id, name: t.mark.name, fate: `was left behind on spent ${st.name}` });
    delete t.mark;
  }
  const summary = summarise(s);
  s.history.push(summary);
  s.phase = { k: "transition", until: s.tick + PACES[s.pace].transitionTicks, summary };
  s.lobby.agents = [];
  log(s, ch, st.departure);
  event(ch, "room", "room", "stage_spent", { stage: st.id, restored: FAMILIES.reduce((a, f) => a + s.ledger[f].restored, 0), goods: s.ops.goods });
  ch.meta = true;
  ch.lobby = true;
  ch.boundary = true;
}

function nextStage(s: RoomState, ch: Changes): void {
  const leaving = STAGES[s.stage];
  if (s.stage === STAGES.length - 1) {
    s.phase = { k: "ended", how: "consumed" };
    for (const p of Object.values(s.players)) p.dx = p.dy = 0;
    log(s, ch, "The engine keeps searching for a next frontier. There isn't one.");
    event(ch, "room", "room", "ending", { how: "consumed" });
    ch.meta = true;
    ch.boundary = true;
    return;
  }
  // only plasma actually extracted is bottled; what careless scooping destroyed is gone
  if (leaving.id === "sun") s.reserve += s.ledger.matter.extracted * SUN_TO_RESERVE;
  s.stage++;
  s.gen++;
  const st = STAGES[s.stage];
  const g = generateStage(s.seed, s.stage);
  s.w = st.size;
  s.tiles = g.tiles;
  s.buildings = g.buildings;
  s.nextBuildingId = g.buildings.length + 1;
  s.inventory = { ...st.starter };
  s.goods = emptyGoods();
  s.claims = [];
  s.ledger = ledgerFor(g.tiles);
  s.lobby = newLobby(s.stage, s.ledger);
  s.ops = emptyOps();
  s.leak = 0;
  s.heat = 0;
  s.stageStartTick = s.tick;
  s.lifeStart = averageLife(s);
  s.phase = { k: "play" };
  const sp = spawnPoint(s);
  Object.values(s.players).forEach((p, i) => {
    p.x = sp.x + (i % 3) - 1;
    p.y = sp.y + Math.floor(i / 3) * 0.8;
    p.dx = p.dy = 0;
    p.act = null;
    p.marks = 0;
  });
  s.receipts = Object.fromEntries(Object.keys(s.players).map((id) => [id, []]));
  log(s, ch, st.arrival);
  event(ch, "room", "room", "stage_start", { stage: st.id, reserve: s.reserve });
  ch.meta = true;
  ch.lobby = true;
  ch.boundary = true;
}

/** One server tick (TICK_MS). Movement every tick; the economy every PACES[pace].econEvery. */
export function tick(s: RoomState, ch: Changes): void {
  s.tick++;
  const dt = TICK_MS / 1000;
  for (const p of Object.values(s.players)) {
    if (p.act && p.act.until <= s.tick) p.act = null;
    if (!p.connected || s.phase.k === "ended" || (p.dx === 0 && p.dy === 0)) continue;
    const v = speedAt(s, p.x, p.y);
    p.x = Math.max(0, Math.min(s.w - 1, p.x + p.dx * v * dt));
    p.y = Math.max(0, Math.min(s.w - 1, p.y + p.dy * v * dt));
    p.facing = facingTo(p.dx, p.dy, p.facing);
  }
  if (s.phase.k === "transition") {
    if (s.tick >= s.phase.until) nextStage(s, ch);
    return;
  }
  if (s.phase.k === "ended") return;
  lobbyMove(s, ch);
  if (s.tick % PACES[s.pace].econEvery === 0) {
    economy(s, ch);
    // a world spent by its machines moves on before the lobby can plant anything back
    checkExhausted(s, ch);
    if (s.phase.k === "play") lobbyAct(s, ch);
  }
}

/** Total across families; used by tests and the HUD. */
export const totalRemaining = (s: RoomState): number => FAMILIES.reduce((a, f) => a + s.ledger[f].remaining, 0);

/**
 * initial + restored = remaining + extracted + destroyed, per family;
 * remaining matches the tiles; and the Green Lobby never put back more than
 * its seed bank held.
 */
export function ledgerHolds(s: RoomState): boolean {
  for (const f of FAMILIES) {
    const l = s.ledger[f];
    const onTiles = s.tiles.reduce((a, t) => a + (t.d === f ? t.amt : 0), 0);
    if (l.initial + l.restored !== l.remaining + l.extracted + l.destroyed || onTiles !== l.remaining) return false;
    if (l.restored + s.lobby.bank[f] !== s.lobby.bankStart[f] || s.lobby.bank[f] < 0) return false;
  }
  return true;
}

export const bundleOk = (b: Bundle): boolean => FAMILIES.every((f) => Number.isSafeInteger(b[f]) && b[f] >= 0);
export const goodsOk = (s: RoomState): boolean => GOODS.every((g) => Number.isSafeInteger(s.goods[g]) && s.goods[g] >= 0);
export { isItem };
export type { Family };
