# Decision log

Consequential decisions, newest last. The multi-user behaviour decision has its own record: [ADR 0001](adr/0001-empty-rooms-pause.md).

## Creative direction

Three directions were sketched against emotional impact, gameplay, visual identity and cost:

| Direction | Pitch | For | Against |
| --- | --- | --- | --- |
| **Plenty** (chosen) | a cheerful cooperative hands you world after world; the copy stays sunny while the land dies | the critique lives in the gap between the voice and the screen, so no lecture is needed; warm Animal Crossing tone is natural | relies on visible environmental change being strong enough |
| Ledger | a clean corporate dashboard world, every tile a spreadsheet cell, players as consultants | the economy reads clearly; cheap to draw | cold from the first minute: no attachment to lose |
| Hearth | a village of named animals who move away as their homes are consumed | strongest attachment | named characters cost far more art and writing than the time allows, and the cosmic stages have no animals to lose |

Plenty keeps Hearth's attachment through landmarks, player-named places and wildlife, and takes Ledger's legibility for the HUD.

## Decisions

- **One authoritative Node process; Next.js exported static.** Satisfies "Next.js for the shell, a separate long-running service for the simulation" on the course's one-machine Fly setup. See [`ARCHITECTURE.md`](ARCHITECTURE.md).
- **Canvas 2D, procedural art.** Fastest route to a consistent original look; one file to replace. PixiJS is the upgrade path if needed.
- **No collisions for avatars.** Players walk through everything; tall buildings turn translucent when someone's behind them. This rules out obstructed routes and trapped deposits entirely, at the cost of a little physicality.
- **Buildings can't cover a deposit that still has stock.** Combined with walk-anywhere, no deposit is ever unreachable, so exhaustion is always achievable.
- **A single shared stockpile, and local machine stores.** Hand gathering and construction pay from one communal stockpile; automated machines keep their own buffers and only reach each other through belts, pipes and cables, or a player loading and collecting (`F`). That keeps manual setup always possible and makes logistics worth building, without a factory silently pulling ore from across the map.
- **Three resource families relabelled per world.** One economy to balance and learn, five sets of names and looks.
- **Inventory doesn't carry between worlds; the Bottled Sun does.** Each world opens with a small starter crate, so balance is predictable per stage, and the one carryover is the one the prompt makes consequential: the Sun's energy.
- **No readiness vote at transitions.** The server moves the room on after a fixed pause, so no absent player can block it.
- **No rotation.** No building's function depends on facing, so rotation would be decoration with a key binding.
- **No text chat.** Emotes, named places and the activity log carry communication. This removes the moderation surface rather than half-building one.
- **Host is a role, not a person.** The creator, or the longest-connected player present. The host can take down anyone's building and render down World Engines.
- **Hand harvest slowed to 0.8 s and stocks deepened about 1.4×** after measuring a two-player Earth at under three minutes. See [`DESIGN.md`](DESIGN.md#pacing).
- **Movement sent as compact tuples** after measuring bandwidth. See [`TESTING.md`](TESTING.md).
- **Spent deposits are buildable.** Found playtesting: a stump refused a plaza because the tile still had a deposit family with zero stock.
- **Restraint is a unanimous vote, offered only in the Universe.** Unanimous among those present, so it's collective without letting absentees block it; consuming withdraws your vote; a dropped connection never completes it. Offered last so it saves something real without undoing the earlier worlds. The full consumption ending stays available.
- **A crash loses at most one second of play.** A changed room is saved every second (it was five). A save is one JSON stringify of the room (about 33 KB for an 8-player Earth, measured at 0.08 ms) and one SQLite UPSERT in WAL mode with `synchronous = NORMAL`, so five times the writes costs nothing a player could notice, and one machine running a handful of rooms writes a few hundred KB a second at most. Saving on every tick (10 Hz) was rejected: it would multiply disk writes tenfold again to shave a window already shorter than a round trip through the lag proxy, and a write per tick per room would start to show on the tick budget as rooms grow. Saving per command was rejected because movement alone sends commands continuously. Empty rooms, stage boundaries and shutdowns (SIGTERM, SIGINT, which is how Fly stops a machine for a deploy or autostop) still save immediately, so the one-second window applies only to an abrupt crash. `spec/server.test.ts` kills the server with SIGKILL mid-play and checks every harvest acknowledged more than 1.2 s before the kill survived.
- **Fixes from an independent review** (a subagent auditing `server/` and `shared/`): a message that crashed the process, rooms that filled forever, receipts for refused commands, a resync that doubled log lines, a city served for free, unlimited room creation. All fixed with regression tests where they're testable.

## The factory chain (crit 10)

- **Earth's mineral family is relabelled metal ore; no fourth family.** Wire and frames need metal, and players have to see themselves collect it. Adding an ore deposit would mean a fourth ledger column on every world, a fourth stock bar and a worldgen rebalance for no new decision; relabelling Earth's "stone" as "metal ore" (rust-brown rocks, the Granite Seat renamed Rust Knoll) keeps the three families and the conservation ledger exactly as they were. The other worlds already call the family iron, magnetics, asteroid metal and stellar cores.
- **Goods live beside the ledger, not in it.** Turning ore into wire moves stock from `inventory` to `goods`; the natural ledger only changes when stock leaves or enters a deposit. That keeps `initial + restored = remaining + extracted + destroyed` checkable on every tick without tracking what was made of what.
- **A datacentre is a milestone, not the summit.** It needs 6 wire, 2 frames and your own claim, and it unlocks harvesters, which is where belts, pipes, bottlenecks and efficiency kits start to matter. Efficiency kits are never required for a datacentre or for finishing.
- **Power belongs to a grid.** Replacing the room-wide power pool with cable grids is the change that makes layout matter: a disconnected machine says so and draws nothing. The Bottled Sun is tapped through the Depot (Solar System) and World Engines (Universe), only as much as a grid needs each tick, so a long cable and a running idle machine both cost real reserve. Relays draw nothing, because they're the link itself.
- **Furnaces light only when their grid needs them.** A furnace with nothing to power burns nothing. Fuel then tracks demand, and a rushed Earth's furnaces burn out of timber exactly when it's used up.
- **Kits trade parts for operation, not one stat for another.** A kit's price is the 2 wire and frame it costs; its benefit is named per building. The first version also charged a kitted machine an extra power, which made an efficient datacentre strictly worse on a finite Bottled Sun; measured, then removed. The furnace keeps its trade (half the fuel and smoke for 1 less power), and the factory's efficient recipes draw 1 power less, which is what makes an equal Bottled Sun make more parts through an efficient factory.
- **Legacy rooms keep working.** A schema-1 room loads with no goods, no claims and zero restored, and every building it already had is marked `legacy`: legacy buildings share one grid of their own, cool from the stockpile and deliver into it, as the old economy did. New buildings in that room follow the new rules. See `server/migrate.ts`.
- **Mars ice deepened from 26 to 40 a tile.** With domes, datacentres and pumps all drinking it, the first measured Mars colony ran dry before a single drill could start. Ice is still the binding constraint; it's now one a careful colony can plan around.
- **Every action is logged.** One logfmt line per claim, build, demolish, upgrade, mode or recipe change, line laid or taken up, load or collect, factory batch and lobby action, plus refusals that touch someone else's ground. A hand harvest logs when it empties a tile, or every twentieth unit, so a narrator can follow it without a flood.

## Who owns what

A claim is how a player stakes out ground for a datacentre: a 4×4 square for 3 timber, at most two per player per world.

- **What a claim lets its owner do.** Build on it (a datacentre must sit entirely inside its builder's claim), take things down on it, and give it up.
- **What it stops others doing.** Building, taking down, or laying a line across it. That's the whole of it: it can't be drawn over another player's building or line, so a claim never captures anything.
- **What it never stops.** Walking, hand harvesting (deposits under a claim stay everyone's), helping raise a site, loading or collecting at a machine, or connecting a cable, pipe or belt at its edge. Natural stock stays communal, and no deposit ever becomes unreachable.
- **Owners control their machines.** Recipes, targets, harvester modes, upgrades and demolition belong to whoever built a building, and a line to whoever laid it. Anyone can load a machine from the shared stockpile or collect its output into it, because both already belong to everyone: a collaborator can feed your factory but can't change what it makes. A belt can be fed by anyone but re-aimed only by its owner.
- **What the host can override.** The host (the creator, or the longest-connected player present) can take down any building or line and give up any claim, the same recovery power the host already had over buildings. It exists so a room is never stuck on an absent player's layout.
- **Shared supply across a boundary.** Power, coolant and items flow through whatever's connected, regardless of whose it is: a cable is one grid whoever laid each tile. Allocation is in a fixed building order, never message order.
- **Absence.** Claims and machines survive disconnection and keep working under their owner's name.

Why: the brief wants the datacentre to be staked-out ground, and the game's whole argument depends on the land and its stock staying communal. Making claims about construction rights only, never access, gives a real "that's Ada's land" moment without letting anyone fence off a deposit or hold a room hostage.

## The Green Lobby across worlds

The lobby is strongest on Earth, where there is something living to put back: its seed bank holds 12% of Earth's timber, 4% of its ore and 10% of its water. It follows the players to Mars with a small bank of ice only (5%), tending the buried ice that the colony depends on. It doesn't follow them to the Sun, the Solar System or the Universe: there's nothing there it could replant, and an agent restoring plasma or galaxies would read as a joke rather than an opponent. So the Universe's restraint ending stays the players' own decision, with nobody else putting anything back.

The bank is per family, so ore and water can't be conjured from a generic balance, and it's finite, so the lobby can slow a world down but never keep it alive. A world ends at exact exhaustion even if the bank still holds something: the transition is checked before the lobby acts each tick, and lobbyists go home the moment a world is spent.
