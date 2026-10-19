"use client";
// The play screen: the canvas (driven by Renderer's own frame loop) plus a
// compact React HUD that re-renders at most five times a second from the
// client's version counter, never per entity update.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BUILDINGS,
  CLAIM_COST,
  CLAIM_SIZE,
  CLAIMS_PER_PLAYER,
  EFFICIENT_EXTRA,
  EMOTES,
  FAMILIES,
  GOODS,
  HARVEST_MODES,
  HARVEST_RANGE,
  KIT_POWER,
  LINES,
  LINE_KINDS,
  RECIPE_LIST,
  STAGES,
  TEND_RANGE,
  buildingName,
  itemLabel,
  type BuildingType,
  type Cost,
  type Emote,
  type Item,
  type LineKind,
} from "../shared/content.ts";
import type { Building, RoomState, Snapshot } from "../shared/protocol.ts";
import { averageLife, buildCost, shortfalls } from "../shared/sim.ts";
import { nextRecipe, powerNeed, recipeOf } from "../shared/economy.ts";
import { lobbyTarget } from "../shared/lobby.ts";
import { claimAt, footprint, route } from "../shared/layout.ts";
import { complete, isIdle } from "../shared/world.ts";
import { GameClient } from "./net.ts";
import { PLAYER_COLOURS, Renderer, type Tool, type View } from "./render.ts";
import { Sound, type Mix } from "./audio.ts";
import { confirmLabel, touchStep } from "./touch.ts";

const EMOTE_GLYPH: Record<Emote, string> = { wave: "👋", heart: "💛", laugh: "😄", wow: "😮", sad: "😢", point: "👉" };
const KEY_DIRS: Record<string, [number, number]> = {
  w: [-1, -1], arrowup: [-1, -1],
  s: [1, 1], arrowdown: [1, 1],
  a: [-1, 1], arrowleft: [-1, 1],
  d: [1, -1], arrowright: [1, -1],
};

const MECHANIC_HINT: Record<string, string> = {
  pollution: "Furnaces are strong but their smoke kills groves and browns the land. Sun Gardens are clean and slow.",
  pressure: "Nothing runs outside a Dome's air. Domes drink ice; so do datacentres. Watch the ice.",
  heat: "Collector Wings pour in power and heat. Over the limit, scoops throttle: radiators shed it.",
  relay: "No sunlight: every machine drinks from the Bottled Sun. Miners only ship if relays link them to the Depot.",
  legacy: "Your old worlds run as World Engines. The host can render one down for a burst of energy, for good.",
};

function useVersion(client: GameClient | null): number {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!client) return;
    let seen = -1;
    const id = setInterval(() => {
      if (client.version !== seen) {
        seen = client.version;
        setN((n) => n + 1);
      }
    }, 200);
    return () => clearInterval(id);
  }, [client]);
  return client?.version ?? 0;
}

const prefersTouch = (): boolean => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
const prefersReducedMotion = (): boolean => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function Game({ room, name }: { room: string; name: string }): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [client, setClient] = useState<GameClient | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const soundRef = useRef(new Sound());
  const viewRef = useRef<View>({ tool: "harvest", build: null, eff: false, line: null, networks: false, hover: null, keyboardTarget: true, touch: prefersTouch(), aim: null, survey: false, selected: null, reducedMotion: prefersReducedMotion(), low: false, zoom: 1 });
  const [, force] = useState(0);
  const [help, setHelp] = useState(false);
  const [naming, setNaming] = useState<[number, number] | null>(null);
  const [mix, setMix] = useState<Mix>({ music: 0.5, ambience: 0.7, effects: 0.8 });
  const [settings, setSettings] = useState(false);
  // phones: the toolbar folds away once a tool is picked, so the world it would cover can be tapped
  const [tray, setTray] = useState(() => !(prefersTouch() && typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches));
  useVersion(client);
  const view = viewRef.current;
  const rerender = (): void => force((n) => n + 1);

  useEffect(() => {
    const c = new GameClient(room, name);
    const canvas = canvasRef.current!;
    const r = new Renderer(canvas, c, viewRef.current);
    rendererRef.current = r;
    c.onAck = (ok, cmd) => {
      const snd = soundRef.current;
      if (!ok) snd.reject();
      else if (cmd.k === "harvest") snd.harvest();
      else if (cmd.k === "build") snd.build();
    };
    const prevBoundary = c.onBoundary;
    c.onBoundary = () => {
      prevBoundary?.();
      soundRef.current.boundary();
      viewRef.current.tool = "harvest";
      viewRef.current.build = null;
      viewRef.current.line = null;
      viewRef.current.selected = null;
      viewRef.current.aim = null;
    };
    c.connect();
    r.start();
    setClient(c);
    return () => {
      r.stop();
      c.close();
      soundRef.current.stop();
    };
  }, [room, name]);

  // keep the sound engine fed with the world's state
  const s = client?.state ?? null;
  useEffect(() => {
    if (!s) return;
    const snd = soundRef.current;
    snd.life = averageLife(s);
    snd.machines = s.buildings.filter((b) => b.status === "ok" && b.owner).length;
    snd.stage = s.stage;
    snd.ended = s.phase.k === "ended" && s.phase.how !== "restraint";
  });
  useEffect(() => soundRef.current.setMix(mix), [mix]);

  // whichever pointer was used last decides the controls: a finger anywhere (toolbar included) brings up the touch bar
  useEffect(() => {
    const seen = (e: PointerEvent): void => {
      const touch = e.pointerType !== "mouse";
      if (touch !== viewRef.current.touch) {
        viewRef.current.touch = touch;
        if (!touch) viewRef.current.aim = null;
        rerender();
      }
    };
    window.addEventListener("pointerdown", seen, true);
    return () => window.removeEventListener("pointerdown", seen, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keyboard
  useEffect(() => {
    if (!client) return;
    const held = new Set<string>();
    let harvestTimer: ReturnType<typeof setInterval> | null = null;
    const sendMove = (): void => {
      let dx = 0;
      let dy = 0;
      for (const k of held) {
        const d = KEY_DIRS[k];
        if (d) {
          dx += d[0];
          dy += d[1];
        }
      }
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        dx /= len;
        dy /= len;
      }
      if (dx !== client.me.dx || dy !== client.me.dy) {
        client.me.dx = dx;
        client.me.dy = dy;
        client.send({ k: "move", dx, dy });
      }
    };
    const down = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, select, dialog")) return;
      if (el?.closest("button, a") && (e.key === "Enter" || e.key === " ")) return;
      const k = e.key.toLowerCase();
      const st = client.state ? STAGES[client.state.stage] : null;
      if (KEY_DIRS[k]) {
        e.preventDefault();
        held.add(k);
        viewRef.current.keyboardTarget = true;
        sendMove();
        return;
      }
      if (e.repeat) return;
      if (k === "e" || k === " ") {
        e.preventDefault();
        quickHarvest();
        if (!harvestTimer) harvestTimer = setInterval(quickHarvest, 820);
      } else if (e.shiftKey && /^digit[1-6]$/i.test(e.code)) {
        e.preventDefault();
        client.send({ k: "emote", e: EMOTES[Number(e.code.slice(5)) - 1] });
      } else if (/^[1-9]$/.test(k) && st) {
        const type = st.buildings[Number(k) - 1];
        if (type) {
          e.preventDefault();
          chooseBuild(type);
        }
      } else if (k === "escape") {
        if (viewRef.current.tool === "line" && viewRef.current.line?.from) {
          viewRef.current.line.from = null;
          viewRef.current.aim = null;
          rerender();
        } else setTool("harvest");
        setHelp(false);
      } else if (k === "enter") {
        e.preventDefault();
        viewRef.current.keyboardTarget = true;
        const tgt = rendererRef.current?.facingTile();
        if (tgt) act(tgt[0], tgt[1]);
      } else if (k === "f") {
        e.preventDefault();
        quickTend();
      } else if (k === "c") setTool("claim");
      else if (k === "l") pickLine(viewRef.current.line?.kind ?? "cable");
      else if (k === "m") {
        const me = client.state?.players[client.you];
        if (me) client.send({ k: "set", mode: me.mode === "careful" ? "intensive" : "careful" });
      } else if (k === "g") {
        viewRef.current.networks = !viewRef.current.networks;
        rerender();
      } else if (k === "x") setTool("demolish");
      else if (k === "i") setTool("inspect");
      else if (k === "n") setTool("mark");
      else if (k === "v") {
        viewRef.current.survey = !viewRef.current.survey;
        rerender();
      } else if (k === "p") photo();
      else if (k === "h" || k === "?") setHelp((h) => !h);
      else if (k === "=" || k === "+") zoomBy(1.15);
      else if (k === "-") zoomBy(1 / 1.15);
    };
    const up = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase();
      if (held.delete(k)) sendMove();
      if ((k === "e" || k === " ") && harvestTimer) {
        clearInterval(harvestTimer);
        harvestTimer = null;
      }
    };
    const blur = (): void => {
      held.clear();
      sendMove();
      if (harvestTimer) clearInterval(harvestTimer);
      harvestTimer = null;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      if (harvestTimer) clearInterval(harvestTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  /** a finger picked a tool: fold the toolbar on a phone so the world is clear to aim at */
  function fold(): void {
    if (view.touch && window.matchMedia("(max-width: 900px)").matches) setTray(false);
  }

  function setTool(tool: Tool): void {
    view.tool = tool;
    view.aim = null;
    if (tool !== "build") view.build = null;
    if (tool !== "line") view.line = null;
    if (tool !== "inspect") view.selected = null;
    rerender();
  }

  function chooseBuild(type: BuildingType): void {
    view.tool = "build";
    view.build = type;
    view.line = null;
    view.aim = null;
    view.selected = null;
    if (!BUILDINGS[type].kit) view.eff = false;
    rerender();
  }

  function pickLine(kind: LineKind, q: 0 | 1 = 0): void {
    view.tool = "line";
    view.build = null;
    view.selected = null;
    view.networks = true;
    view.line = { kind, q: LINES[kind].cost[q] ? q : 0, from: view.line?.kind === kind ? view.line.from : null };
    view.aim = view.line.from;
    rerender();
  }

  /** Load or collect at the nearest finished machine in reach. */
  function quickTend(): void {
    const c = client;
    const st = c?.state;
    if (!c || !st) return;
    let best: Building | null = null;
    let bd = Infinity;
    for (const b of st.buildings) {
      const def = BUILDINGS[b.type];
      if (!complete(b) || !(b.type === "factory" || b.type === "extractor" || b.type === "intake" || def.tank)) continue;
      const h = (def.size - 1) / 2;
      const d = Math.hypot(b.x + h - c.me.x, b.y + h - c.me.y);
      if (d <= TEND_RANGE + def.size / 2 && d < bd) [bd, best] = [d, b];
    }
    if (best) c.send({ k: "tend", x: best.x, y: best.y });
    else c.toast("Nothing to load or collect in reach: stand beside a factory, harvester, pump or tank.", "bad");
  }

  function zoomBy(k: number): void {
    view.zoom = Math.max(0.5, Math.min(2.2, view.zoom * k));
  }

  /** Harvest (or help build) the best thing in reach: the forgiving keyboard path. */
  function quickHarvest(): void {
    const c = client;
    const st = c?.state;
    if (!c || !st) return;
    let best: [number, number] | null = null;
    let bd = Infinity;
    const r = Math.ceil(HARVEST_RANGE);
    for (let y = Math.floor(c.me.y) - r; y <= Math.ceil(c.me.y) + r; y++)
      for (let x = Math.floor(c.me.x) - r; x <= Math.ceil(c.me.x) + r; x++) {
        if (x < 0 || y < 0 || x >= st.w || y >= st.w) continue;
        const t = st.tiles[y * st.w + x];
        const site = t.b ? st.buildings.find((b) => b.id === t.b) : undefined;
        const useful = (t.d && t.amt > 0) || (site && site.work < BUILDINGS[site.type].build * 10);
        const d = Math.hypot(x - c.me.x, y - c.me.y);
        if (useful && d <= HARVEST_RANGE - 0.1 && d < bd) [bd, best] = [d, [x, y]];
      }
    if (best) {
      c.send({ k: "harvest", x: best[0], y: best[1] });
      soundRef.current.tap();
    }
    else c.toast("Nothing in reach to harvest. Press V to survey.", "bad");
  }

  function act(x: number, y: number): void {
    const c = client;
    const st = c?.state;
    if (!c || !st || x < 0 || y < 0 || x >= st.w || y >= st.w) return;
    const t = st.tiles[y * st.w + x];
    switch (view.tool) {
      case "build":
        if (view.build) c.send({ k: "build", x, y, type: view.build, eff: view.eff && !!BUILDINGS[view.build].kit });
        break;
      case "claim": {
        const owned = claimAt(st, x, y);
        if (owned) c.send({ k: "unclaim", x, y });
        else c.send({ k: "claim", x: x - 1, y: y - 1 });
        break;
      }
      case "line": {
        const ln = view.line;
        if (!ln) break;
        if (!ln.from) {
          ln.from = [x, y];
          // on a touch screen the start stays previewed until the end is tapped
          view.aim = [x, y];
          rerender();
          break;
        }
        const path = route(st as RoomState, ln.kind, ln.from, [x, y], c.you);
        if (!path) {
          c.toast(`No clear route for a ${ln.kind} there (at most 32 tiles, around buildings and water).`, "bad");
          break;
        }
        c.send({ k: "line", kind: ln.kind, q: ln.q, path });
        ln.from = null;
        view.aim = null;
        rerender();
        break;
      }
      case "tend":
        if (t.b) c.send({ k: "tend", x, y });
        break;
      case "demolish":
        // a building first; otherwise take up the line on the tile (belt, pipe, cable, then path)
        if (t.b) c.send({ k: "demolish", x, y });
        else {
          const kind = t.bt ? "belt" : t.pp ? "pipe" : t.cb ? "cable" : t.pa ? "path" : null;
          if (kind) c.send({ k: "unline", x, y, kind });
        }
        break;
      case "mark":
        setNaming([x, y]);
        break;
      case "inspect":
        view.selected = t.b || null;
        rerender();
        break;
      default:
        if ((t.d && t.amt > 0) || t.b) {
          const site = t.b ? st.buildings.find((b) => b.id === t.b) : undefined;
          if (site && site.work >= BUILDINGS[site.type].build * 10) {
            view.selected = site.id;
            rerender();
          } else {
            c.send({ k: "harvest", x, y });
            soundRef.current.tap();
          }
        } else view.selected = null;
        rerender();
    }
  }

  function photo(): void {
    const url = rendererRef.current?.photo();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `plenty-${client?.state ? STAGES[client.state.stage].id : "world"}-${Date.now()}.png`;
    a.click();
    client?.toast("Photo saved.");
  }

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    view.hover = rendererRef.current?.pick(e.clientX - rect.left, e.clientY - rect.top) ?? null;
    view.keyboardTarget = false;
    if (e.pointerType === "mouse") view.touch = false;
  };
  // touch and pen: a tap on open ground walks there (a keyboard isn't the only way to move)
  const walkRef = useRef<[number, number] | null>(null);
  useEffect(() => {
    if (!client) return;
    const id = setInterval(() => {
      const goal = walkRef.current;
      if (!goal) return;
      const dx = goal[0] - client.me.x;
      const dy = goal[1] - client.me.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.35) {
        walkRef.current = null;
        client.me.dx = client.me.dy = 0;
        client.send({ k: "move", dx: 0, dy: 0 });
        return;
      }
      client.me.dx = dx / d;
      client.me.dy = dy / d;
      client.send({ k: "move", dx: dx / d, dy: dy / d });
    }, 100);
    return () => clearInterval(id);
  }, [client]);

  const onClick = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return;
    view.touch = e.pointerType !== "mouse";
    onPointer(e);
    if (!view.hover) return;
    // a tall building is picked by what you see of it, not only its footprint
    let at = view.hover;
    if (view.tool === "harvest" || view.tool === "inspect" || view.tool === "demolish") {
      const rect = e.currentTarget.getBoundingClientRect();
      const b = rendererRef.current?.pickBuilding(e.clientX - rect.left, e.clientY - rect.top);
      if (b) at = [b.x, b.y];
    }
    const st = client?.state;
    if (view.touch && st && client) {
      fold();
      // touch and pen: tap open ground to walk, tap once to aim anything that costs, again to do it
      const step = touchStep(st, view, client.me, at);
      if (step.k === "walk") {
        walkRef.current = step.to;
        return;
      }
      walkRef.current = null;
      if (step.k === "aim") {
        view.aim = step.at;
        rerender();
        return;
      }
      if (view.tool !== "line") view.aim = null;
      return act(step.at[0], step.at[1]);
    }
    walkRef.current = null;
    act(at[0], at[1]);
  };

  /** The touch bar's confirm: do what the aimed tile previews. */
  function confirmAim(): void {
    const at = view.aim;
    if (!at) return;
    if (view.tool !== "line") view.aim = null;
    act(at[0], at[1]);
  }

  const st = s ? STAGES[s.stage] : null;
  const host = !!(s && client && s.hostId === client.you);

  return (
    <main className={`game ${tray ? "" : "tray-folded"}`}>
      <h1 className="sr-only">{st ? `Plenty: ${st.name}, room ${room}` : "Plenty"}</h1>
      <canvas
        ref={canvasRef}
        className="world"
        tabIndex={0}
        aria-label={st ? `${st.name}: the shared world. Move with WASD or arrows, harvest with E.` : "Loading the world"}
        onPointerMove={onPointer}
        onPointerDown={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          setTool("harvest");
        }}
        onWheel={(e) => zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1)}
      />
      {!s || !client || !st ? (
        <div className="overlay center">
          <div className="card">
            <p className="title">Plenty</p>
            <p>{client?.status === "error" ? client.error : "Walking to the world…"}</p>
            {client?.status === "error" && <a href="/">Back to the start</a>}
          </div>
        </div>
      ) : (
        <>
          <div className="col-left">
            <StagePanel s={s} />
            <Economy s={s} you={client.you} onMode={(mode) => client.send({ k: "set", mode })} />
            {s.phase.k === "play" && (s.lobby.agents.length > 0 || s.lobby.bankStart.matter + s.lobby.bankStart.mineral + s.lobby.bankStart.coolant > 0) && <LobbyPanel s={s} />}
            {s.phase.k === "play" && <Memo s={s} you={client.you} />}
          {st.id === "universe" && s.phase.k === "play" && <LastFrontier s={s} you={client.you} onVote={(on) => client.send({ k: "stop", on })} />}
          </div>
          <RoomPanel s={s} client={client} host={host} />
          <BuildBar s={s} view={view} onPick={(t) => { chooseBuild(t); fold(); }} onTool={(t) => { setTool(t); if (t !== "harvest") fold(); }} onLine={(k, q) => { pickLine(k, q); fold(); }} onEff={(on) => { view.eff = on; rerender(); }} onNetworks={() => { view.networks = !view.networks; rerender(); }}>
            {view.touch && (
              <TouchBar
                s={s}
                view={view}
                tray={tray}
                onTray={() => setTray((t) => !t)}
                onConfirm={confirmAim}
                onWalk={() => {
                  if (view.aim) walkRef.current = view.aim;
                }}
                onHarvest={() => quickHarvest()}
                onTend={() => quickTend()}
                mode={s.players[client.you]?.mode ?? "careful"}
                onMode={(mode) => client.send({ k: "set", mode })}
                onCancel={() => {
                  if (view.tool === "line" && view.line?.from) {
                    view.line.from = null;
                    view.aim = null;
                    rerender();
                  } else setTool("harvest");
                }}
              />
            )}
          </BuildBar>
          <Log s={s} client={client} />
          {view.selected !== null && (
            <Inspect
              s={s}
              b={s.buildings.find((b) => b.id === view.selected)}
              youId={client.you}
              host={host}
              send={(c) => client.send(c)}
              onClose={() => setTool("harvest")}
            />
          )}
          <div className="corner-buttons">
            <div className="emotes" role="group" aria-label="Emotes">
              {EMOTES.map((e, i) => (
                <button key={e} type="button" title={`${e} (Shift+${i + 1})`} aria-label={`Emote: ${e}`} onClick={() => client.send({ k: "emote", e })}>
                  {EMOTE_GLYPH[e]}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => { view.survey = !view.survey; rerender(); }} aria-pressed={view.survey}>
              Survey (V)
            </button>
            <button type="button" onClick={photo}>Photo (P)</button>
            <button type="button" onClick={() => { if (!soundRef.current.running) soundRef.current.start(mix); setSettings((v) => !v); }} aria-expanded={settings}>
              {soundRef.current.running ? "Sound" : "Sound on"}
            </button>
            <button type="button" onClick={() => setHelp(true)}>Help (H)</button>
          </div>
          {settings && (
            <div className="panel settings" role="group" aria-label="Settings">
              {(Object.keys(mix) as (keyof Mix)[]).map((k) => (
                <label key={k}>
                  {k}
                  <input type="range" min={0} max={1} step={0.05} value={mix[k]} onChange={(e) => setMix({ ...mix, [k]: Number(e.target.value) })} />
                </label>
              ))}
              <label>
                <input type="checkbox" checked={view.reducedMotion} onChange={(e) => { view.reducedMotion = e.target.checked; rerender(); }} /> reduced motion
              </label>
              <label>
                <input type="checkbox" checked={view.low} onChange={(e) => { view.low = e.target.checked; rerender(); }} /> low detail
              </label>
              <p className="small">
                {Math.round(1000 / Math.max(1, 16.7))} fps target · frame {rendererRef.current?.frameMs.toFixed(1)} ms · ping {client.rtt} ms
              </p>
            </div>
          )}
          {help && <Help onClose={() => setHelp(false)} st={st} />}
          {naming && (
            <NameDialog
              onCancel={() => setNaming(null)}
              onName={(n) => {
                client.send({ k: "mark", x: naming[0], y: naming[1], name: n });
                setNaming(null);
                setTool("harvest");
              }}
            />
          )}
          {s.phase.k === "transition" && <Transition s={s} />}
          {s.phase.k === "ended" && <Ending s={s} />}
          <Toasts client={client} />
          {client.status === "error" && (
            <div className="overlay center" role="alert">
              <div className="card">
                <p className="title">Disconnected</p>
                <p>{client.error}</p>
                <a href="/">Back to the start</a>
              </div>
            </div>
          )}
          {client.status === "reconnecting" && (
            <div className="overlay center" role="status">
              <div className="card">
                <p className="title">Reconnecting…</p>
                <p>The world is safe on the server. You'll be back where you were in a moment.</p>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function StagePanel({ s }: { s: Snapshot }): ReactNode {
  const st = STAGES[s.stage];
  const life = averageLife(s);
  const drawn = s.econ.drawn;
  return (
      <div className="panel top-left">
        <p className="stage">
          <span className="stage-n">Stage {s.stage + 1} of 5</span> <strong>{st.name}</strong>
        </p>
        <p className="small">{st.tagline}</p>
        <ul className="stocks" aria-label="Natural stock remaining">
          {FAMILIES.map((f) => {
            const l = s.ledger[f];
            const pct = l.initial ? Math.min(100, (l.remaining / l.initial) * 100) : 0;
            return (
              <li key={f}>
                <span className="lbl">{st.families[f].label}</span>
                <span className="bar" aria-hidden="true">
                  <span style={{ width: `${pct}%`, background: st.palette[f] }} />
                </span>
                <span className="num">
                  {l.remaining}/{l.initial}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="small">
          {st.id === "earth" ? "Living land" : "Untouched ground"}: <strong>{life}%</strong>
          {st.mechanic === "heat" && (
            <>
              {" "}· Heat: <strong>{s.heat}</strong>/100{s.heat >= 70 ? " (throttling)" : ""}
            </>
          )}
          {st.energySource === "bottled" && (
            <>
              {" "}· Bottled Sun: <strong>{s.reserve}</strong> energy left
              {drawn > 0 ? `, drawing ${drawn} a tick (about ${Math.floor(s.reserve / drawn / (s.pace === "rapid" ? 5 : 1))}s at this rate)` : ", nothing drawing"}
            </>
          )}
        </p>
      </div>
  );
}

function RoomPanel({ s, client, host }: { s: Snapshot; client: GameClient; host: boolean }): ReactNode {
  const [copied, setCopied] = useState(false);
  const status = { live: "connected", connecting: "connecting…", reconnecting: "reconnecting…", error: "disconnected" }[client.status];
  return (
      <div className="panel top-right">
        <p>
          Room <strong className="code">{s.code}</strong>{" "}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(`${location.origin}/play/?room=${s.code}`);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Link copied" : "Copy invite link"}
          </button>
        </p>
        <p className="small" role="status">
          <span className={`dot ${client.status}`} aria-hidden="true" /> {status}
          {s.pace === "rapid" ? " · rapid preset" : ""}
        </p>
        <ul className="roster" aria-label="Players">
          {Object.values(s.players)
            .sort((a, b) => Number(b.connected) - Number(a.connected))
            .map((p) => (
              <li key={p.id} className={p.connected ? "" : "away"}>
                <span className="swatch" style={{ background: PLAYER_COLOURS[p.colour % 8] }} aria-hidden="true" />
                {p.name}
                {p.id === client.you ? " (you)" : ""}
                {s.hostId === p.id ? " · host" : ""}
                {p.connected ? "" : " · away"}
                {host && p.id !== client.you && p.connected && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="small-btn"
                      aria-label={`Remove ${p.name} from the room`}
                      onClick={() => {
                        if (window.confirm(`Remove ${p.name}? They'll be sent out of the room and come back, if it's open, as a newcomer. Their buildings stay.`)) client.send({ k: "remove", who: p.id });
                      }}
                    >
                      Remove
                    </button>
                  </>
                )}
              </li>
            ))}
        </ul>
        {s.locked && <p className="small">🔒 Closed to new players: anyone already here can come back.</p>}
        {host && (
          <>
            <p className="small">You're the host: you can take down anyone's buildings, remove a player, or close the room.</p>
            <button type="button" aria-pressed={!!s.locked} onClick={() => client.send({ k: "lock", on: !s.locked })}>
              {s.locked ? "Open to new players" : "Close to new players"}
            </button>
          </>
        )}
      </div>
  );
}

function Economy({ s, you, onMode }: { s: Snapshot; you: string; onMode: (m: "careful" | "intensive") => void }): ReactNode {
  const st = STAGES[s.stage];
  const e = s.econ;
  const me = s.players[you];
  // the shortage most of the machine is waiting on, so nobody has to inspect buildings one by one
  const idle = s.buildings.filter((b) => complete(b) && isIdle(b));
  const tally = new Map<string, number>();
  for (const b of idle) tally.set(b.status, (tally.get(b.status) ?? 0) + 1);
  const top = [...tally].sort((a, b) => b[1] - a[1])[0];
  const bottleneck = top ? { n: idle.length, why: top[0] } : null;
  const o = s.ops;
  const mode = me ? HARVEST_MODES[me.mode] : HARVEST_MODES.careful;
  const y = s.pace === "rapid" ? 10 : 1;
  return (
    <div className="panel left">
      <h2>Stockpile (shared)</h2>
      <ul className="inv">
        {FAMILIES.map((f) => (
          <li key={f}>
            <span className="swatch" style={{ background: st.palette[f] }} aria-hidden="true" />
            {st.families[f].label}: <strong>{s.inventory[f]}</strong>
          </li>
        ))}
        {GOODS.map((g) => (
          <li key={g} className="good">
            <span className="swatch good" aria-hidden="true" />
            {st.goods[g]}: <strong>{s.goods[g]}</strong>
          </li>
        ))}
      </ul>
      <ul className="inv small">
        <li>
          Power {e.energyUsed}/{e.energySupply}
          {e.unwired ? ` · ${e.unwired} not cabled` : ""}
        </li>
        <li>
          Compute {e.computeUsed}/{e.computeSupply}
        </li>
        <li>
          Workers {e.workersUsed}/{e.workersSupply}
        </li>
      </ul>
      {me && (
        <div className="mode" role="group" aria-label="Hand harvesting">
          <span className="small">Harvest (M):</span>
          {(["careful", "intensive"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={me.mode === m} className={me.mode === m ? "on" : ""} onClick={() => onMode(m)}>
              {m}
            </button>
          ))}
          <p className="small">
            {me.mode === "careful" ? `takes ${mode.useful * y}, wastes nothing` : `takes ${mode.useful * y}, wastes ${mode.waste * y} more and scars the ground`}
          </p>
        </div>
      )}
      <p className="small ops">
        This world: {o.goods} parts made · {o.coolantUsed} {st.families.coolant.label} used{o.coolantLost ? ` (${o.coolantLost} leaked)` : ""} · {o.energyUsed} energy
        {o.energyGen ? `, ${Math.round((o.solarGen / Math.max(1, o.energyGen)) * 100)}% from ${buildingName(st, "solar")}s` : ""}
        {o.cableLoss ? ` · ${o.cableLoss} lost in cables` : ""}
      </p>
      {bottleneck && (
        <p className="small bottleneck">
          <strong>⚠ {bottleneck.n} idle</strong>, mostly “{bottleneck.why.replace(/^(idle|unserved|throttled): /, "")}”
        </p>
      )}
    </div>
  );
}

/** The goal checklist: the next useful action on every world, and why. */
function Memo({ s, you }: { s: Snapshot; you: string }): ReactNode {
  const st = STAGES[s.stage];
  const n = (t: BuildingType): string => buildingName(st, t);
  const built = (t: BuildingType): boolean => s.buildings.some((b) => b.type === t && b.owner && complete(b));
  const has = (t: BuildingType): boolean => s.buildings.some((b) => b.type === t && b.owner);
  const ore = st.families.mineral.label;
  const cabled = s.buildings.some((b) => b.type === "factory" && complete(b) && !b.status.includes("not cabled") && !b.status.includes("no power"));
  const parts = s.ops.goods > 0;
  const claimed = s.claims.length > 0;
  const dc = s.buildings.find((b) => b.type === "datacentre" && b.owner && complete(b));
  const cooled = !!dc && dc.status === "ok";
  const automated = s.ops.firstAutomation !== null;
  const inspected = s.buildings.some((b) => b.type === "extractor" && complete(b));
  const power = st.buildings.includes("furnace") ? `Power them: a ${n("furnace")} (fast, smoky) or a ${n("solar")} (clean, slow)` : `Power them: a ${n("solar")}, cabled in`;
  const steps: [string, boolean][] = [
    ...(st.mechanic === "pressure" ? ([[`Raise a ${n("habitat")}: nothing runs outside its air`, has("habitat")]] as [string, boolean][]) : []),
    [`Gather ${st.families.matter.label} and ${ore} (E): careful or intensive (M)`, s.ledger.matter.extracted + s.ledger.mineral.extracted >= 20 || has("city")],
    [`Build ${n("city")}: workers, no power needed`, has("city")],
    ...(st.energySource === "local" ? ([[power, has("furnace") || has("solar")]] as [string, boolean][]) : ([[`Cable machines to the ${n(st.id === "system" ? "depot" : "engine")}: it taps the Bottled Sun`, s.econ.drawn > 0 || s.ops.energyUsed > 0]] as [string, boolean][])),
    [`Build a ${n("factory")}, and cable it to power (L)`, cabled],
    [`Make ${st.goods.wire} and ${st.goods.frame}: load the factory (F), collect the parts`, parts],
    [`Claim a ${CLAIM_SIZE}×${CLAIM_SIZE} plot (C): the ${n("datacentre")} goes on your own ground`, claimed],
    [`Build the ${n("datacentre")} on it: 6 ${st.goods.wire}, 2 ${st.goods.frame}`, has("datacentre")],
    [`Cool it: a ${n("intake")} by the ${st.families.coolant.label}, piped in (or fill it, F)`, cooled],
    [`Automate: a ${n("extractor")} belted to a ${n("store")} or the factory`, automated],
    [`Find the bottleneck: inspect (I) what's idle, and choose`, automated && inspected && s.ops.goods >= 12],
  ];
  void you;
  const next = steps.findIndex(([, done]) => !done);
  if (next === -1) return null;
  // done steps fold into a count, so the next one is always in view
  const done = steps.filter(([, d]) => d).length;
  return (
    <div className="panel memo">
      <h2>Cooperative memo</h2>
      {done > 0 && <p className="small">✓ {done} of {steps.length} done</p>}
      <ol>
        {steps.map(([text, d], i) =>
          d ? null : (
            <li key={text} className={i === next ? "next" : ""}>
              {text}
            </li>
          ),
        )}
      </ol>
    </div>
  );
}

function LobbyPanel({ s }: { s: Snapshot }): ReactNode {
  const L = s.lobby;
  const total = (b: typeof L.bank): number => b.matter + b.mineral + b.coolant;
  const st = STAGES[s.stage];
  const picket = L.agents.filter((a) => a.task.k === "picket").length;
  const planting = L.agents.filter((a) => a.task.k === "plant").length;
  const restored = FAMILIES.reduce((a, f) => a + s.ledger[f].restored, 0);
  return (
    <div className="panel lobby-panel">
      <h2>The Green Lobby</h2>
      <p className="small">
        {L.agents.length ? `${L.agents.length} out (${L.agents.map((a) => a.name).join(", ")})` : L.spent ? "gone home: the seed bank is empty" : "not here yet"}
        {planting ? `, ${planting} replanting` : ""}
        {picket ? `, ${picket} picketing` : ""}. {L.agents.length ? `More come as factories and datacentres go up (${lobbyTarget(s as RoomState)} now).` : ""}
      </p>
      <p className="small">
        Seed bank: <strong>{total(L.bank)}</strong> of {total(L.bankStart)} left (
        {FAMILIES.filter((f) => L.bankStart[f]).map((f) => `${L.bank[f]} ${st.families[f].label}`).join(", ") || "none"}). Put back so far: {restored}.
      </p>
    </div>
  );
}

function LastFrontier({ s, you, onVote }: { s: Snapshot; you: string; onVote: (on: boolean) => void }): ReactNode {
  const here = Object.values(s.players).filter((p) => p.connected);
  const ready = here.filter((p) => p.stop).length;
  const mine = !!s.players[you]?.stop;
  const left = FAMILIES.reduce((a, f) => a + s.ledger[f].remaining, 0);
  return (
    <div className="panel memo">
      <h2>The last frontier</h2>
      <p className="small">
        {left} units of the Universe are left. You could stop here and leave them alone, for good. Everyone here has to agree; harvesting or building takes your vote back.
      </p>
      <p className="small">
        <strong>
          {ready} of {here.length}
        </strong>{" "}
        here want to stop.
      </p>
      <button type="button" aria-pressed={mine} onClick={() => onVote(!mine || ready === here.length)}>
        {mine ? (ready === here.length ? "Stop for good" : "Keep going instead") : "Stop here"}
      </button>
    </div>
  );
}

const costText = (st: (typeof STAGES)[number], c: Cost): string =>
  Object.entries(c)
    .filter(([, v]) => v)
    .map(([k, v]) => `${v} ${itemLabel(st, k as Item)}`)
    .join(", ");

function BuildBar({
  s,
  view,
  onPick,
  onTool,
  onLine,
  onEff,
  onNetworks,
  children,
}: {
  children?: ReactNode;
  s: Snapshot;
  view: View;
  onPick: (t: BuildingType) => void;
  onTool: (t: Tool) => void;
  onLine: (k: LineKind, q?: 0 | 1) => void;
  onEff: (on: boolean) => void;
  onNetworks: () => void;
}): ReactNode {
  const st = STAGES[s.stage];
  const canEff = !!(view.build && BUILDINGS[view.build].kit);
  return (
    <div className="panel bottom" role="toolbar" aria-label="Build and tools">
      {children}
      <div className="row-buttons">
        {st.buildings.map((type, i) => {
          const def = BUILDINGS[type];
          const cost = buildCost(type, view.build === type && view.eff && !!def.kit);
          const short = shortfalls(s as RoomState, cost);
          const text = costText(st, cost);
          return (
            <button
              key={type}
              type="button"
              className={`build ${view.build === type ? "on" : ""} ${short.length ? "short" : ""}`}
              aria-pressed={view.build === type}
              title={def.blurb}
              aria-label={`${buildingName(st, type)}, costs ${text || "nothing"}${short.length ? `, short of ${short.join(", ")}` : ""}`}
              onClick={() => onPick(type)}
            >
              <span className="key">{i < 9 ? i + 1 : ""}</span>
              <span className="bname">{buildingName(st, type)}</span>
              <span className="cost">
                {short.length ? "✕ " : ""}
                {text || "free"}
              </span>
            </button>
          );
        })}
      </div>
      <div className="row-buttons">
        {LINE_KINDS.map((k) => (
          <span key={k} className="linegroup">
            {([0, 1] as const)
              .filter((q) => LINES[k].cost[q])
              .map((q) => {
                const on = view.tool === "line" && view.line?.kind === k && view.line.q === q;
                const c = LINES[k].cost[q]!;
                const short = shortfalls(s as RoomState, c).length > 0;
                return (
                  <button
                    key={q}
                    type="button"
                    className={`tool line ${on ? "on" : ""} ${short ? "short" : ""}`}
                    aria-pressed={on}
                    title={LINES[k].blurb}
                    onClick={() => onLine(k, q)}
                  >
                    {LINES[k].q[q]} <span className="cost">{costText(st, c)}/tile</span>
                  </button>
                );
              })}
          </span>
        ))}
        <button type="button" className={`tool ${view.networks ? "on" : ""}`} aria-pressed={view.networks} onClick={onNetworks} title="Show cables, pipes, belts and claims">
          Networks (G)
        </button>
      </div>
      <div className="row-buttons tools">
        {canEff && (
          <label className="eff">
            <input type="checkbox" checked={view.eff} onChange={(e) => onEff(e.target.checked)} /> efficient build (+{costText(st, EFFICIENT_EXTRA)}, slower, kit built in)
          </label>
        )}
        {(["harvest", "tend", "claim", "inspect", "demolish", "mark"] as Tool[]).map((t) => (
          <button key={t} type="button" className={`tool ${view.tool === t ? "on" : ""}`} aria-pressed={view.tool === t} onClick={() => onTool(t)}>
            {{ harvest: "Harvest (E)", tend: "Load/collect (F)", claim: `Claim (C) ${costText(st, CLAIM_COST)}`, inspect: "Inspect (I)", demolish: "Take down (X)", mark: "Name (N)", build: "", line: "" }[t]}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Touch only: what the aimed tile will do and a button to do it, plus the
 * actions a keyboard has keys for (harvest what's in reach, load or collect)
 * and the way back to the toolbar once it has folded away.
 */
function TouchBar({
  s,
  view,
  tray,
  onTray,
  onConfirm,
  onWalk,
  onHarvest,
  onTend,
  onCancel,
  mode,
  onMode,
}: {
  mode: "careful" | "intensive";
  onMode: (m: "careful" | "intensive") => void;
  s: Snapshot;
  view: View;
  tray: boolean;
  onTray: () => void;
  onConfirm: () => void;
  onWalk: () => void;
  onHarvest: () => void;
  onTend: () => void;
  onCancel: () => void;
}): ReactNode {
  const st = STAGES[s.stage];
  const confirm = confirmLabel(view, (t) => buildingName(st, t));
  const doing =
    view.tool === "build" && view.build
      ? `Placing ${buildingName(st, view.build)}`
      : view.tool === "line" && view.line
        ? view.line.from
          ? `${LINES[view.line.kind].q[view.line.q]}: tap where it ends`
          : `${LINES[view.line.kind].q[view.line.q]}: tap where it starts`
        : { harvest: "Tap ground to walk, a deposit to harvest", tend: "Tap a machine to load or collect", claim: "Tap the middle of a 4×4 to claim", inspect: "Tap a building to inspect", demolish: "Tap what to take down", mark: "Tap a place to name", build: "", line: "" }[view.tool];
  const aiming = view.tool === "build" || view.tool === "claim" || view.tool === "demolish" || (view.tool === "line" && !!view.line?.from);
  return (
    <div className="touchbar" role="group" aria-label="Touch controls">
      <p className="small doing" aria-live="polite">
        {doing}
        {aiming && !view.aim ? ": tap once to preview, again to confirm" : ""}
      </p>
      <div className="row-buttons">
        {confirm && (
          <button type="button" className="go" onClick={onConfirm}>
            {confirm}
          </button>
        )}
        {view.aim && view.tool !== "harvest" && (
          <button type="button" onClick={onWalk}>
            Walk there
          </button>
        )}
        {view.tool === "harvest" ? (
          <>
            <button type="button" onClick={onHarvest}>
              Harvest nearby
            </button>
            <button type="button" onClick={onTend}>
              Load/collect
            </button>
            <button type="button" aria-pressed={mode === "intensive"} title="Switch harvesting: careful takes 1 and wastes nothing; intensive takes 2 and destroys 1 more" onClick={() => onMode(mode === "careful" ? "intensive" : "careful")}>
              {mode === "careful" ? "Careful" : "Intensive"}
            </button>
          </>
        ) : (
          <button type="button" onClick={onCancel}>
            {view.tool === "line" && view.line?.from ? "Start over" : "Done"}
          </button>
        )}
        <button type="button" onClick={onTray} aria-expanded={tray}>
          {tray ? "Hide tools" : "Tools"}
        </button>
      </div>
    </div>
  );
}

function Log({ s, client }: { s: Snapshot; client: GameClient }): ReactNode {
  void client;
  return (
    <div className="panel log" aria-live="polite" aria-label="Activity">
      {s.log.slice(-4).map((l, i) => (
        <p key={`${l.tick}-${i}`}>{l.text}</p>
      ))}
    </div>
  );
}

function Inspect({ s, b, youId, host, send, onClose }: { s: Snapshot; b: Building | undefined; youId: string; host: boolean; send: (c: import("../shared/protocol.ts").Command) => void; onClose: () => void }): ReactNode {
  if (!b) return null;
  const st = STAGES[s.stage];
  const def = BUILDINGS[b.type];
  const owner = b.owner ? (s.players[b.owner]?.name ?? "someone") : "the Cooperative";
  const done = complete(b);
  const need = b.need ?? def.build * 10;
  const mine = b.owner === youId || host || (b.owner === null && !def.protected);
  const io: string[] = [];
  const pw = powerNeed(b);
  if (def.energy > 0) io.push(`+${b.type === "solar" ? def.energy * st.solarScale : def.energy - (b.kit ? KIT_POWER.furnace ?? 0 : 0)} power${b.type === "furnace" ? `, burns ${b.kit ? "1 every other tick" : "1"} ${st.families.matter.label}, only when its grid needs it` : ""}`);
  if (pw) io.push(`uses ${pw} power${b.kit && KIT_POWER[b.type] && b.type !== "furnace" && !b.quick ? " (1 less with the kit)" : ""}, only while working`);
  if (def.workers) io.push(def.workers > 0 ? `houses ${def.workers}, ${def.workers + 3} served` : `employs ${-def.workers}`);
  if (def.compute) io.push(def.compute > 0 ? `+${def.compute} compute` : `uses ${-def.compute} compute`);
  if (def.coolantUse) io.push(`drinks ${b.kit ? "1 every other tick" : def.coolantUse} ${st.families.coolant.label} from its tank`);
  if (b.type === "extractor") {
    const m = HARVEST_MODES[b.mode ?? "intensive"];
    io.push(b.mode === "careful" ? `harvests ${b.kit ? 2 : 1} a tick, wastes nothing` : `harvests ${m.useful} a tick and destroys ${m.waste} more, scarring the ground`);
  }
  const store = (x?: Partial<Record<Item, number>>): string => costText(st, x ?? {}) || "empty";
  const canDemolish = !def.protected && (def.renderValue ? host : b.owner === youId || host);
  const salvage = Object.entries(b.paid ?? def.cost)
    .map(([k, v]) => `${Math.floor((v ?? 0) / 2)} ${itemLabel(st, k as Item)}`)
    .join(", ");
  const next = b.type === "factory" ? nextRecipe(s as RoomState, b) : null;
  return (
    <div className="panel inspect" role="dialog" aria-label={`${buildingName(st, b.type)} details`}>
      <h2>
        {b.name ?? buildingName(st, b.type)}
        {b.kit ? " · efficient" : ""}
      </h2>
      <p className="small">
        {b.owner === youId ? "Yours." : `${owner}'s.`} {def.blurb}
      </p>
      <p>
        Status: <strong>{done ? (b.status === "ok" ? "running" : b.status) : `${b.status} (${Math.round((b.work / need) * 100)}%): press E beside it to help`}</strong>
      </p>
      {b.legacy && <p className="small">From before the factory chain: on the old shared grid, cooled from the stockpile.</p>}
      <p className="small">Per tick: {io.join(" · ") || "nothing"}</p>
      {b.kit && def.kit && <p className="small">Kit: {def.kit}.</p>}
      {b.type === "factory" && (
        <>
          <p className="small">
            Inputs: {store(b.buf)} · output: {store(b.out)}
            {b.job ? ` · making ${b.job.n} ${itemLabel(st, b.job.r)}, ${b.job.left} tick${b.job.left === 1 ? "" : "s"} left` : ""}
            {next && "why" in next ? ` · ${next.why}` : ""}
          </p>
          <p className="small">
            Recipes ({b.kit && !b.quick ? "efficient" : "quick"}):{" "}
            {RECIPE_LIST.map((r) => `${costText(st, recipeOf(b, r).in)} → ${recipeOf(b, r).out} ${itemLabel(st, r)} in ${recipeOf(b, r).ticks}`).join(" · ")}
          </p>
          {mine && (
            <div className="row">
              <label>
                Make{" "}
                <select value={b.recipe ?? "auto"} onChange={(e) => send({ k: "set", x: b.x, y: b.y, recipe: e.target.value as "auto" })}>
                  <option value="auto">parts for the next {buildingName(st, "datacentre")}</option>
                  {RECIPE_LIST.map((r) => (
                    <option key={r} value={r}>
                      {itemLabel(st, r)}
                    </option>
                  ))}
                </select>
              </label>
              {b.recipe && b.recipe !== "auto" && (
                <label>
                  stop at{" "}
                  <input type="number" min={0} max={99} value={b.target ?? 0} onChange={(e) => send({ k: "set", x: b.x, y: b.y, target: Math.max(0, Math.min(99, Math.round(Number(e.target.value) || 0))) })} style={{ width: "4rem" }} />
                </label>
              )}
              {b.kit && (
                <label>
                  <input type="checkbox" checked={!!b.quick} onChange={(e) => send({ k: "set", x: b.x, y: b.y, quick: e.target.checked })} /> quick recipes anyway
                </label>
              )}
            </div>
          )}
        </>
      )}
      {b.type === "extractor" && (
        <p className="small">
          Hopper: {store(b.out)} · harvested {b.made ?? 0} so far
          {mine && (
            <>
              {" "}
              <button type="button" onClick={() => send({ k: "set", x: b.x, y: b.y, mode: b.mode === "careful" ? "intensive" : "careful" })}>
                Switch to {b.mode === "careful" ? "intensive" : "careful"}
              </button>
            </>
          )}
        </p>
      )}
      {(def.tank || b.type === "intake") && !b.legacy && (
        <p className="small">
          Tank: {b.tank ?? 0}/{def.tank ?? 20} {st.families.coolant.label}
          {b.type === "intake" ? ` · pumped ${b.made ?? 0} so far` : ""}
        </p>
      )}
      <div className="row">
        {done && (b.type === "factory" || b.type === "extractor" || b.type === "intake" || !!def.tank) && (
          <button type="button" onClick={() => send({ k: "tend", x: b.x, y: b.y })}>
            {b.type === "factory" ? "Load / collect (F)" : b.type === "extractor" || b.type === "intake" ? "Collect (F)" : "Fill tank (F)"}
          </button>
        )}
        {done && def.kit && !b.kit && mine && (
          <button type="button" onClick={() => send({ k: "upgrade", x: b.x, y: b.y })} disabled={s.goods.kit < 1} title={def.kit}>
            Fit efficiency kit ({s.goods.kit} in stock): {def.kit}
          </button>
        )}
        {canDemolish && (
          <button type="button" onClick={() => send({ k: "demolish", x: b.x, y: b.y })}>
            {def.renderValue ? `Render down (+${def.renderValue} energy, forever)` : `Take down (back: ${salvage || "nothing"})`}
          </button>
        )}
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function Help({ onClose, st }: { onClose: () => void; st: (typeof STAGES)[number] }): ReactNode {
  return (
    <div className="overlay center" role="dialog" aria-modal="true" aria-labelledby="help-h">
      <div className="card help">
        <h2 id="help-h">How to play</h2>
        <ul>
          <li><kbd>WASD</kbd> or arrows: walk (faster on a path). Wheel or <kbd>+</kbd>/<kbd>-</kbd>: zoom.</li>
          <li>On a touch screen: tap ground to walk, a deposit in reach to harvest. Building, claiming, taking down and lines take two taps on the same tile, the first to preview; a line is start, end, then the end again (or the green button).</li>
          <li><kbd>E</kbd>/<kbd>Space</kbd> (hold): harvest whatever's in reach, or help raise a building site. <kbd>M</kbd> switches careful (takes 1, wastes nothing) and intensive (takes 2, destroys 1 more).</li>
          <li><kbd>1</kbd>–<kbd>9</kbd>: pick a building. The ghost shows every shortage and why it can't go there. Click, or <kbd>Enter</kbd> for the tile you face. <kbd>Esc</kbd> cancels.</li>
          <li><kbd>F</kbd>: load the factory beside you from the shared stockpile and collect what it made; collect a harvester's hopper or a pump's tank; fill a datacentre's or dome's tank.</li>
          <li><kbd>L</kbd>: lay a line. Click its start, then its end. Cables carry power (a grid only has what its own generators make), pipes carry coolant from a pump, belts carry items toward their arrow, paths are quicker to walk on. <kbd>G</kbd> shows them all.</li>
          <li><kbd>C</kbd>: claim a {CLAIM_SIZE}×{CLAIM_SIZE} plot (up to {CLAIMS_PER_PLAYER}). A datacentre has to sit inside your own claim; nobody else can build or take things down there, but anyone can walk, harvest and connect.</li>
          <li><kbd>I</kbd> inspect (recipes, upgrades, why it's idle) · <kbd>X</kbd> take down a building or a line tile (half back, plus whatever it held) · <kbd>N</kbd> name a place · <kbd>V</kbd> survey · <kbd>P</kbd> photo · <kbd>Shift</kbd>+<kbd>1</kbd>–<kbd>6</kbd> emote.</li>
        </ul>
        <p>The chain on every world: gather, house workers, power, a factory, parts, a claim, a datacentre, then harvesters and belts so nobody has to carry everything. Rushing is quicker and wastes more; efficient kits and careful harvesting take setup and last longer.</p>
        <p>The Green Lobby walks the land too, putting stock back from a seed bank that runs out, and picketing datacentre sites for a while.</p>
        <p>When every deposit on this world is gone, the room moves on together. There are five worlds.</p>
        <p><strong>{st.name}:</strong> {MECHANIC_HINT[st.mechanic]}</p>
        <button type="button" onClick={onClose} autoFocus>Back to the world</button>
      </div>
    </div>
  );
}

function NameDialog({ onName, onCancel }: { onName: (n: string) => void; onCancel: () => void }): ReactNode {
  const [v, setV] = useState("");
  return (
    <div className="overlay center" role="dialog" aria-modal="true" aria-labelledby="name-h">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim()) onName(v.trim());
        }}
      >
        <h2 id="name-h">Name this place</h2>
        <label>
          Name <input autoFocus maxLength={24} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onCancel()} />
        </label>
        <div className="row">
          <button type="submit">Name it</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

function Transition({ s }: { s: Snapshot }): ReactNode {
  if (s.phase.k !== "transition") return null;
  const sum = s.phase.summary;
  const st = STAGES.find((x) => x.id === sum.stage)!;
  const next = STAGES[s.stage + 1];
  const secs = Math.max(0, Math.ceil((s.phase.until - s.tick) / 10));
  return (
    <div className="overlay bottom-card" role="status">
      <div className="card transition">
        <h2>{st.departure}</h2>
        <table>
          <thead>
            <tr><th scope="col">Stock</th><th scope="col">Was</th><th scope="col">Put back</th><th scope="col">Extracted</th><th scope="col">Destroyed</th></tr>
          </thead>
          <tbody>
            {FAMILIES.map((f) => (
              <tr key={f}>
                <th scope="row">{st.families[f].label}</th>
                <td>{sum.ledger[f].initial}</td>
                <td>{sum.ledger[f].restored}</td>
                <td>{sum.ledger[f].extracted}</td>
                <td>{sum.ledger[f].destroyed}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          {st.id === "earth" ? "Living land" : "Untouched ground"}: {sum.lifeStart}% → {sum.lifeEnd}%.{" "}
          {sum.lost.length ? `Lost: ${sum.lost.join(", ")}.` : ""}
        </p>
        {sum.ops && (
          <p className="small">
            {sum.ops.goods} parts made · {sum.ops.coolantUsed} {st.families.coolant.label} used ({sum.ops.coolantLost} leaked) · {sum.ops.energyUsed} energy
            {sum.ops.busy ? ` · datacentres ran for ${sum.ops.busy} ticks` : " · no datacentre ever ran"}
          </p>
        )}
        <p className="small">{next ? `Leaving for ${next.name} in ${secs}s.` : `The engine looks for a next frontier… ${secs}s`}</p>
      </div>
    </div>
  );
}

function Ending({ s }: { s: Snapshot }): ReactNode {
  const total = s.history.reduce((a, h) => a + FAMILIES.reduce((b, f) => b + h.ledger[f].extracted + h.ledger[f].destroyed, 0), 0);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (hidden)
    return (
      <div className="overlay bottom-card">
        <button type="button" onClick={() => setHidden(false)}>
          Back to the ending
        </button>
      </div>
    );
  const restraint = s.phase.k === "ended" && s.phase.how === "restraint";
  const left = FAMILIES.reduce((a, f) => a + s.ledger[f].remaining, 0);
  const hands = `${Object.keys(s.players).length} pair${Object.keys(s.players).length === 1 ? "" : "s"} of hands`;
  return (
    <div className="overlay center ending" role="dialog" aria-labelledby="end-h">
      <div className={`card ${restraint ? "dawn" : "dark"}`}>
        {restraint ? (
          <>
            <h2 id="end-h">You stopped.</h2>
            <p>
              Four worlds and most of a fifth, {total.toLocaleString("en-AU")} units of everything, consumed by {hands}. {left.toLocaleString("en-AU")} units of the Universe are
              still out there, and will stay there.
            </p>
            <p>The Cooperative's machine idles. It could have finished. Nobody asked it to.</p>
          </>
        ) : (
          <>
            <h2 id="end-h">There is nothing left.</h2>
            <p>Five worlds, {total.toLocaleString("en-AU")} units of everything, consumed by {hands}.</p>
            <p>The machine runs perfectly. It has no input. Somewhere in its last datacentre, a process is still searching for a next frontier.</p>
            <p className="search" aria-hidden="true">searching… 0 found</p>
          </>
        )}
        <h3>What the machine did with it</h3>
        <table className="ledger-table">
          <thead>
            <tr><th scope="col">World</th><th scope="col">Used</th><th scope="col">Wasted</th><th scope="col">Put back</th><th scope="col">Left</th><th scope="col">Parts</th><th scope="col">Datacentres ran</th></tr>
          </thead>
          <tbody>
            {s.history.map((h, i) => {
              const sum = (k: "extracted" | "destroyed" | "restored" | "remaining"): number => FAMILIES.reduce((a, f) => a + h.ledger[f][k], 0);
              return (
                <tr key={i}>
                  <th scope="row">{STAGES.find((x) => x.id === h.stage)?.name}</th>
                  <td>{sum("extracted")}</td>
                  <td>{sum("destroyed")}</td>
                  <td>{sum("restored")}</td>
                  <td>{sum("remaining")}</td>
                  <td>{h.ops?.goods ?? "–"}</td>
                  <td>{h.ops ? `${h.ops.busy} ticks` : "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <h3>What was named, and what became of it</h3>
        <ul className="archive">
          {s.archive.map((a, i) => (
            <li key={i}>
              <strong>{a.name}</strong> ({STAGES.find((x) => x.id === a.stage)?.name}) {a.fate}.
            </li>
          ))}
        </ul>
        <h3>Who did it</h3>
        <ul>
          {Object.values(s.players).map((p) => (
            <li key={p.id}>
              {p.name}: harvested {p.stats.harvested}, built {p.stats.built}, helped {p.stats.helped} times
            </li>
          ))}
        </ul>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const res = await fetch("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pace: s.pace }) });
            const { code } = (await res.json()) as { code: string };
            location.href = `/play/?room=${code}`;
          }}
        >
          Start a new campaign, somewhere else
        </button>{" "}
        <button type="button" onClick={() => setHidden(true)}>
          Look at what's left
        </button>
      </div>
    </div>
  );
}

function Toasts({ client }: { client: GameClient }): ReactNode {
  return (
    <div className="toasts" aria-live="assertive">
      {client.toasts.map((t) => (
        <p key={t.id} className={t.kind}>
          {t.kind === "bad" ? "✕ " : ""}
          {t.text}
        </p>
      ))}
    </div>
  );
}
