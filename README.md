# Plenty

A cosy multiplayer game about having enough, and never stopping.

You and up to seven friends arrive on a little meadow island: a pond with a heron, a few groves, an old oak, a hill for picnics. You gather timber and metal ore by hand, build cottages, power them, run a factory that turns ore into wire and frames, stake out a plot, and earn a datacentre that teaches harvesters and conveyor belts to do the gathering for you. It works beautifully. A few people in straw hats with placards, the Green Lobby, wander about replanting what you take, for as long as their seed bank lasts. When the island is used up, the Plenty Cooperative has another world ready: Mars, then the Sun itself, then the whole Solar System, then the Universe. There is no sixth.

The game is built from a pod's brief, _Consume the Universe_: let players enjoy building the machine, then notice what the machine has consumed.

## How to play

Start a world from the front page and send the invite link (or the five-letter room code) to friends. No account: your browser remembers who you are in each room.

- **Walk** with WASD or the arrow keys, or tap open ground on a touch screen. Paths make it quicker. Zoom with the wheel or `+`/`-`.
- **Harvest** by holding `E` (or `Space`) near a tree, rock or pond, or by clicking it. `M` switches between careful (takes 1, wastes nothing) and intensive (takes 2 and destroys 1 more, scarring the ground). Everything goes into the room's shared stockpile.
- **Build** with `1`--`9`. A ghost shows the footprint, every shortage ("needs 6 wire (have 2)"), and why it can't go somewhere ("claim this ground first", "that's Ada's land"). Click to place it, or press `Enter` for the tile you're facing. Buildings with an efficiency kit can be built efficiently: more parts, slower, less damage, the kit built in.
- **Load and collect** with `F` beside a machine: it loads a factory from the stockpile and collects what it made, empties a harvester's hopper or a pump's tank, and fills a datacentre's or dome's tank.
- **Lay lines** with `L`: click where it starts, then where it ends. Cables carry power (a machine only has what its own grid makes), pipes carry coolant from a pump, belts carry items towards their arrows (start a belt on the side of another to split it), and paths are quicker to walk. `G` shows every network. `X` on a line takes up that tile.
- **Claim** a 4×4 plot with `C` (3 timber, two each). A datacentre has to sit on your own claim. Nobody else can build or take anything down there, but anyone can still walk, harvest and connect.
- **Help raise** a building site by pressing `E` beside it: several people building together finish faster.
- `I` inspects a building (recipes, buffers, what it runs on, why it's idle, and its efficiency kit), `X` takes one down for half its cost back, `N` names a favourite place, `V` surveys every deposit left, `P` saves a photo, and `Shift`+`1`--`6` emotes.
- `H` opens help in the game.
- **The host** (whoever started the room, or the longest-connected player still in it) can remove a player from the room panel, and close the room to new players: anyone who has already played there can still come back.

**On a phone or tablet** the whole early chain works with taps alone. Tap open ground to walk and a tree, rock or pond (or a building site) in reach to harvest it. Pick a building or a line from the toolbar and it folds away so the world is clear; anything that costs stock or takes something down is aimed first and done second: the first tap shows the same ghost a mouse would (cost, shortages, "that's Ada's land"), and a second tap on the same tile, or the green button in the touch bar, does it. A line is a tap where it starts, a tap where it ends to preview the route and its cost, and a third to lay it. The touch bar also has "Harvest nearby" and "Load/collect" for the `E` and `F` keys, a careful/intensive switch for `M`, and "Tools" to bring the toolbar back.

## The chain

Every world runs the same short chain, in its own words, and the Cooperative memo in the corner walks you through it:

1. **Gather** timber and metal ore by hand.
2. **House workers** in Cottages. They need no power to start with.
3. **Power** them: a Furnace (lots of power, burns timber and nearby groves) or a Sun Garden (clean, slow, takes ground). Lay a cable from the generator to what it powers.
4. **Build a Factory**, cable it in, and load it with `F`. It needs power and workers, never compute, and makes **wire** (3 ore → 2) and **frames** (4 ore + 3 timber → 1) until you have enough for a datacentre.
5. **Claim** a plot and **build the Datacentre** on it: 6 wire, 2 frames, a little ore and timber.
6. **Cool it**: a Pump beside the pond, piped to the datacentre (or fill its tank by hand).
7. **Automate**: the datacentre's compute runs Harvesters. Belt their hoppers to a Store (into the stockpile) or straight into the factory.
8. **Find the bottleneck**. More extraction runs into factory throughput, then power, coolant and belt capacity. Add cheap capacity, or make an **efficiency kit** (2 wire + 1 frame) and fit it: a factory's efficient recipes get more parts from the same ore, a datacentre drinks half the coolant, a harvester works carefully at full speed.

Rushing (intensive harvesting, furnaces, standard builds, cheap pipe) gets you compute first and burns through the world faster. Building carefully takes more parts and setup and gets more useful work out of the same finite stock. Mix them, switch, retrofit: there's no class to pick. The stockpile panel tells you what your idle machines are waiting for and keeps a tally of parts made, water used and energy drawn.

A world moves on when every deposit on it is gone, for everyone at once, whatever you've built. The survey arrow points at the nearest remaining deposit, so the last few never turn into a hunt.

## The Green Lobby

They're against the datacentre. A couple of them arrive at the start, one more for every running factory, two more for every datacentre. They walk to whatever you've harvested down and put a little back, a few units at a visit, and they'll stand by a datacentre site with a placard and slow its construction for a while. They come from a finite seed bank, shown in the HUD, and when it's empty they go home. You can always outpace them: a world ends when its deposits do. They're strongest on Earth, bring a little ice to Mars, and stay home after that.

## The five worlds

| World | What you consume | What's different |
| --- | --- | --- |
| Earth | timber, metal ore, fresh water | Furnaces are strong, but their smoke kills groves and browns the land. Sun Gardens are clean and slow. The Green Lobby is out in force. |
| Mars | regolith, iron, buried ice | Nothing runs outside a dome's air, and domes, pumps and datacentres all drink the same buried ice. Sealed domes and pipes stretch it. |
| The Sun | plasma, magnetics, shade | Collectors pour in power and heat; past the limit, scoops throttle until radiators shed it. Only plasma you actually extract is bottled for later: what an intensive scoop destroys is gone. The star dims as you take it. |
| The Solar System | volatiles, asteroid metal, comet ice | No sunlight now. Cable machines to the Depot and they draw on the Bottled Sun you saved, which doesn't refill; the HUD shows how long it'll last at the current draw. Miners only run if relays link them to the Depot. |
| The Universe | starlight, stellar cores, dark cold | Your spent worlds run as World Engines. The host can render one down for a burst of energy, forever. And if everyone here agrees, you can stop, and leave the rest alone. |

Spent Earth and Mars float in the Solar System as grey remnants, and the Solar System sits in a corner of the Universe. Nothing you've finished comes back fresh.

## What the game is arguing

Every convenience has a dependency. A datacentre takes parts, and parts take ore; the datacentre gives you compute, which runs harvesters, which empty the land faster, which needs more power, which on Earth means furnaces, whose smoke burns the groves you were going to harvest anyway. Being careful gets more out of the same world; it doesn't make a new one. The game never stops you and never lectures you. It shows the cost in the land (grass browns, trees become stumps, the pond shrinks to mud, the birds thin out and the birdsong with them) and it keeps a short archive of every named place and what became of it. The ending reads that archive back to you.

The design document, [`docs/DESIGN.md`](docs/DESIGN.md), covers the economy, pacing, stages and ending in detail.

## How it works

One Node process on Fly.io owns every room's simulation and speaks WebSocket; browsers render the world and send intentions (move, harvest, build, claim, lay a line). The server decides everything, and logs every action with who did it, so `flyctl logs` tells the story of a room. The browser app is Next.js, exported to static files that the same process serves, with the world drawn on a Canvas 2D in its own frame loop. Rooms persist as snapshots in SQLite on the Fly volume.

**What survives.** Close the tab, come back tomorrow, let the machine stop because nobody's playing, or sit through a redeploy: the world is as everyone left it, and your browser rejoins as you. A room with nobody in it is saved and paused, and a deploy or autostop saves every room before the machine stops, so none of those lose anything. Only an abrupt crash can cost play, and **a crash loses at most the last second of play, never more**: a changed room is saved every second, and the spec kills the server mid-play to check it.

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the stack, the protocol, authority, persistence, deployment and recovery
- [`docs/DECISIONS.md`](docs/DECISIONS.md): the decision log, including the creative directions weighed at the start
- [`docs/adr/0001-empty-rooms-pause.md`](docs/adr/0001-empty-rooms-pause.md): what a player finds when they come back
- [`docs/TESTING.md`](docs/TESTING.md): what was tested, how, and what was measured
- [`docs/ASSETS.md`](docs/ASSETS.md): where every picture and sound comes from, and how to replace them

## Running it

You need the versions in `mise.toml` (Node 24, pnpm 11).

```sh
pnpm install
pnpm build          # Next.js shell -> out/
pnpm start          # game server on :8080 (PORT and DATA_DIR override)
```

Then open <http://localhost:8080>. `pnpm check` typechecks and runs the spec against the running server (set `APP_URL` if it isn't on :8080). `node scripts/playbot.ts <ROOM> [url] [name] [rush|green|hand]` joins a room with a bot that plays the whole chain (rushed, sustainable, or by hand only), which is the quickest way to see later stages or fill a room.

The rapid preset (a button on the front page) runs the same rules with the economy five times faster and a hand harvest worth ten. A solo campaign takes about ten minutes on it.

## Known limits

Desktop browsers with a keyboard are the fullest way to play; on a phone everything in the early chain works by touch (harvest mode included, from the touch bar), but there's no pinch zoom, the side panels (stockpile detail, memo, lobby, log) are hidden to leave room for the world, and no human has played it on a real phone yet. One server process and one Fly machine host every room, so a deploy or crash pauses all rooms for a few seconds, and a crash (not a deploy) can roll back up to one second of play. There's no text chat by design (emotes only). The host can take down anyone's buildings, remove a disruptive player and close the room to newcomers, but there are no accounts, so there's no ban list: a removed player can rejoin an open room as someone new. The full list, and what to build next, is in [`docs/TESTING.md`](docs/TESTING.md).
