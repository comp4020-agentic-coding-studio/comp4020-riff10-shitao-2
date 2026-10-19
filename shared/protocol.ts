// The wire protocol between browser and game server. Versioned: a client and
// server that disagree on PROTOCOL_VERSION refuse each other rather than
// guess. All messages are JSON text frames.
import type { Bundle, BuildingType, Emote, Family, Goods, HarvestMode, Item, LineKind, Pace, Recipe, StageId } from "./content.ts";

export const PROTOCOL_VERSION = 2;
export const SCHEMA_VERSION = 2;
export const MAX_MESSAGE_BYTES = 2048;

export type Terrain = 0 | 1 | 2 | 3 | 4; // ground, water/ice, void, stellar core, remnant

export interface Tile {
  t: Terrain;
  /** deposit family, or null for no natural stock */
  d: Family | null;
  amt: number;
  init: number;
  /** 0..100: how alive (or, off Earth, how untouched) the tile is */
  life: number;
  /** id of the building covering this tile, 0 if none */
  b: number;
  mark?: { name: string; by: string };
  /** label for remnant regions (spent worlds) */
  ghost?: string;
  /** a landmark's name after it was harvested bare, so a replanting can say where */
  was?: string;
  /** cable: owner id */
  cb?: string;
  /** pipe: owner id, quality (0 cheap, 1 sealed) */
  pp?: [string, 0 | 1];
  /** belt: owner, direction (0 +x, 1 +y, 2 -x, 3 -y), quality, carried item and count, blocked last tick, splitter (and its round-robin turn) */
  bt?: { o: string; d: 0 | 1 | 2 | 3; q: 0 | 1; it?: Item; n: number; bk?: 1; sp?: 1; r?: number };
  /** path: owner id, quality (0 rough track, 1 laid path) */
  pa?: [string, 0 | 1];
}

/** Whole-number item counts: a factory's input buffer, a machine's output hopper. */
export type Store = Partial<Record<Item, number>>;

export interface Building {
  id: number;
  type: BuildingType;
  x: number;
  y: number;
  owner: string | null;
  /** work units done; complete at `need`, or BUILDINGS[type].build * 10 */
  work: number;
  /** work units an efficiently built site needs (more than standard) */
  need?: number;
  /** "ok", or why it's idle: shown to players as text, never colour alone */
  status: string;
  name?: string;
  /** loaded from a schema-1 save: wired to one shared legacy grid, cooled from the stockpile, delivering to it */
  legacy?: boolean;
  /** what it cost, so salvage is always strictly less */
  paid?: Partial<Record<Item, number>>;
  /** built with efficient construction (its kit benefit built in) */
  eff?: boolean;
  /** an efficiency kit is installed (built efficient, or retrofitted) */
  kit?: boolean;
  /** factory input buffer */
  buf?: Store;
  /** output hopper (factory goods, harvester stock) */
  out?: Store;
  /** coolant tank (datacentres, domes, pumps) */
  tank?: number;
  /** factory: selected recipe, "auto" makes the next datacentre's parts */
  recipe?: Recipe | "auto";
  /** factory with a kit: use the quick recipes anyway */
  quick?: boolean;
  /** factory: pause once this many of the product are in hand (0: no target) */
  target?: number;
  /** factory: the batch in progress, inputs already committed */
  job?: { r: Recipe; n: number; left: number; eff: boolean; in?: Partial<Record<Item, number>> };
  /** harvester mode */
  mode?: HarvestMode;
  /** integer accumulator for half-rate consumption (kits) */
  acc?: number;
  /** round-robin pointer for splitting output across belts */
  rr?: number;
  /** economy ticks the Green Lobby has spent picketing this site */
  picket?: number;
  /** useful output so far (goods made, stock harvested, coolant pumped) */
  made?: number;
}

export interface Claim {
  id: number;
  owner: string;
  x: number;
  y: number;
}

export type LobbyTask =
  | { k: "idle" }
  | { k: "walk"; x: number; y: number; i?: number }
  | { k: "plant"; i: number; got: number }
  | { k: "picket"; b: number; x: number; y: number }
  | { k: "rest"; until: number };

export interface Lobbyist {
  id: number;
  name: string;
  sign: string;
  x: number;
  y: number;
  task: LobbyTask;
  /** a speech bubble, shown until the given tick */
  say?: string;
  sayUntil?: number;
}

export interface Lobby {
  /** the seed bank, per family: the only source of new stock, and finite */
  bank: Bundle;
  bankStart: Bundle;
  agents: Lobbyist[];
  next: number;
  /** told the room the bank is empty */
  spent?: boolean;
}

/** Operating measurements for one world, reset at each transition. */
export interface Ops {
  goods: number;
  coolantUsed: number;
  coolantLost: number;
  /** energy drawn by machines, cable losses included (from the Bottled Sun on its worlds) */
  energyUsed: number;
  /** energy generated on cables that had something to power, and the solar share of it */
  energyGen: number;
  solarGen: number;
  cableLoss: number;
  firstFactory: number | null;
  firstDatacentre: number | null;
  firstAutomation: number | null;
  /** economy ticks in which at least one datacentre ran: how long the machine stayed useful */
  busy: number;
}

export interface PlayerStats {
  harvested: number;
  built: number;
  helped: number;
}

export interface Player {
  id: string;
  name: string;
  colour: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  facing: number;
  act: { k: "harvest" | "build" | "emote"; until: number; e?: Emote } | null;
  connected: boolean;
  joinedTick: number;
  nextHarvest: number;
  nextEmote: number;
  marks: number;
  /** in the Universe: this player wants to stop and leave the rest alone */
  stop?: boolean;
  /** hand harvesting mode */
  mode: HarvestMode;
  stats: PlayerStats;
}

export interface LedgerEntry {
  initial: number;
  /** put back by the Green Lobby: initial + restored = remaining + extracted + destroyed */
  restored: number;
  remaining: number;
  extracted: number;
  destroyed: number;
}
export type Ledger = Record<Family, LedgerEntry>;

export interface Econ {
  energySupply: number;
  energyUsed: number;
  computeSupply: number;
  computeUsed: number;
  workersSupply: number;
  workersUsed: number;
  /** machines with a power need but no cable to a generator */
  unwired: number;
  /** drawn from the Bottled Sun last economy tick */
  drawn: number;
}

export interface StageSummary {
  stage: StageId;
  ledger: Ledger;
  lifeStart: number;
  lifeEnd: number;
  buildings: number;
  ticks: number;
  lost: string[];
  ops?: Ops;
}

export interface ArchiveEntry {
  stage: StageId;
  name: string;
  fate: string;
}

export interface LogEntry {
  tick: number;
  text: string;
}

export type Phase =
  | { k: "play" }
  | { k: "transition"; until: number; summary: StageSummary }
  | { k: "ended"; how?: "consumed" | "restraint" };

/** Everything a room is. JSON-serialisable: this is exactly what gets saved. */
export interface RoomState {
  v: number;
  code: string;
  seed: number;
  pace: Pace;
  hostId: string | null;
  /** the host has closed the room to new players; returning ones still get in */
  locked?: boolean;
  tick: number;
  seq: number;
  gen: number;
  stage: number;
  stageStartTick: number;
  lifeStart: number;
  econTicks: number;
  phase: Phase;
  w: number;
  tiles: Tile[];
  buildings: Building[];
  nextBuildingId: number;
  inventory: Bundle;
  /** manufactured goods: the shared stockpile's second half, outside the natural ledger */
  goods: Goods;
  claims: Claim[];
  nextClaimId: number;
  lobby: Lobby;
  ops: Ops;
  /** cheap-pipe leak accumulator, room-wide: units carried × cheap tiles crossed */
  leak: number;
  ledger: Ledger;
  econ: Econ;
  heat: number;
  reserve: number;
  history: StageSummary[];
  archive: ArchiveEntry[];
  players: Record<string, Player>;
  /** player id -> session token (secret; never sent to other clients) */
  tokens: Record<string, string>;
  /** player id -> recent command ids, for duplicate suppression */
  receipts: Record<string, string[]>;
  log: LogEntry[];
}

export type Command =
  | { k: "move"; dx: number; dy: number }
  | { k: "harvest"; x: number; y: number }
  | { k: "build"; x: number; y: number; type: BuildingType; eff?: boolean }
  | { k: "claim"; x: number; y: number }
  | { k: "unclaim"; x: number; y: number }
  | { k: "line"; kind: LineKind; q: 0 | 1; path: [number, number][]; d?: 0 | 1 | 2 | 3 }
  | { k: "unline"; x: number; y: number; kind: LineKind }
  | { k: "tend"; x: number; y: number }
  | { k: "set"; x?: number; y?: number; recipe?: Recipe | "auto"; target?: number; mode?: HarvestMode; quick?: boolean }
  | { k: "upgrade"; x: number; y: number }
  | { k: "demolish"; x: number; y: number }
  | { k: "emote"; e: Emote }
  | { k: "mark"; x: number; y: number; name: string }
  | { k: "stop"; on: boolean }
  | { k: "remove"; who: string }
  | { k: "lock"; on: boolean };

export type ClientMsg =
  | { t: "hello"; v: number; room: string; token?: string; name: string }
  | { t: "cmd"; id: string; inc: string; gen: number; c: Command }
  | { t: "sync" }
  | { t: "ping"; n: number };

/** What a client sees of the room: the state minus secrets. */
export type Snapshot = Omit<RoomState, "tokens" | "receipts">;

export interface Delta {
  t: "delta";
  seq: number;
  gen: number;
  tick: number;
  /** players whose non-movement fields changed, in full */
  players: Player[];
  /** everyone else who moved: [id, x, y, dx, dy, facing], positions to 0.01 tile */
  moves?: [string, number, number, number, number, number][];
  tiles?: [number, Tile][];
  buildings?: Building[];
  removed?: number[];
  /** the Green Lobby's agents, whenever any of them moved or changed */
  lobby?: Lobby;
  meta?: Pick<RoomState, "inventory" | "goods" | "claims" | "ops" | "ledger" | "econ" | "heat" | "reserve" | "phase" | "hostId" | "locked"> &
    Partial<Pick<RoomState, "archive" | "history">>;
  log?: LogEntry[];
}

export type ServerMsg =
  | { t: "welcome"; v: number; inc: string; you: string; token: string; snap: Snapshot }
  | Delta
  | { t: "ack"; id: string; ok: boolean; reason?: string }
  | { t: "error"; reason: string }
  | { t: "pong"; n: number };
