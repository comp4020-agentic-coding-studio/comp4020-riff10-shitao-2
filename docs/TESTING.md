# Testing and evidence

What was checked, how, and what it showed. Targets and results are kept apart, and anything not tested says so.

## Automated tests

`pnpm check` typechecks and runs every `spec/*.test.ts` against a running server (`APP_URL`, default `:8080`). CI runs it against the Docker image Fly deploys, with a throwaway `/data`.

**`spec/sim.test.ts`**, the simulation with no browser or socket:

- resource accounting: `initial + restored = remaining + extracted + destroyed` for every family on every tick of a whole two-player campaign (and `restored` plus what's left in the seed bank equals the bank it started with), inventories never negative or non-integer, and the campaign reaches the ending
- exactly one transition per exhausted world (stage generations 2, 3, 4, 5) and one history entry per world, each ending at zero remaining
- a building's cost is charged once; salvage returns strictly less than the cost
- furnace smoke records burnt stock as _destroyed_, and the ledger still balances
- two players placing on the same tile: one building, one charge, the second told why
- two players spending the same balance: the second refused, nothing negative
- two players taking the last unit: one succeeds, the world ends exactly once
- a retried command id applies once
- a command for a previous stage generation is refused
- malformed, non-finite, fractional, out-of-bounds, unknown, out-of-range and unauthorised commands are refused; only the builder or host can demolish
- no building on a deposit with stock left; a spent deposit can be built on
- names are stripped of control characters and capped
- mutations are refused during a transition, and the next world admits them
- only applied commands are receipted, so a refused command can be honestly retried
- seats count connected players; departed identities never fill a room, and past 32 the longest-gone is forgotten
- the restraint ending: only in the Universe, only when everyone present agrees, harvesting withdraws a vote, a holdout's dropped connection never completes it, and the ledger still balances with stock left
- a crash mid-transition (state serialised at the Sun's boundary, restored, resumed) yields the same next world, the same generation and the same Bottled Sun as the uninterrupted run: no duplicate generation, no doubled carryover

The factory chain, claims, networks and the Green Lobby (crit 10):

- a datacentre is refused without goods ("needs 6 wire (have 0)"), outside any claim ("claim this ground first") and on someone else's ("that's A's land"), and is built from the parts on its owner's claim
- on every one of the five worlds, two bots starting from the starter crate (no goods, no compute) reach a working factory and a finished datacentre, the ledger holding every tick
- a factory taken down mid-batch refunds exactly the inputs the batch committed, even after its recipe settings changed (an independent review found the quick recipe's inputs refunded instead); a setting with one bad field changes nothing, and a non-string harvest mode is refused
- a factory turns ore loaded from the stockpile into wire, collected back into it, and the natural ledger doesn't move; a batch commits exactly its recipe, and switching recipe mid-batch, a reconnect, or a save and reload produce exactly one batch; idle states name missing inputs, a full output, and a missing cable; with a kit, the same ore makes more wire, more slowly
- claims: can't be drawn over another player's building; never block a hand harvest or walking; the host can give one up; at most two per player
- salvage of an efficient datacentre returns strictly less than it cost (goods included) and its tank's coolant exactly once; a kit fitted later never comes back whole
- careful harvesting takes less and destroys nothing; intensive takes more and destroys real stock; with one or two units left, both take what's there and intensive wastes nothing it can't
- a datacentre with no cable draws no power (`unwired` counts it), then idles on an empty tank, then runs once filled
- a pump and cheap pipe to a datacentre: everything pumped is in a tank, was drunk or leaked, with the leak exactly the persisted counter's whole units
- a belt carries one item a tile per economy tick into a store; a belt into nothing blocks and conserves its items; taking a loaded belt up returns its load once
- a belt branched off the middle of another makes a splitter: six items fed in come out three each way, and the count on the belts plus what's arrived equals what went in on every tick
- the lobby replants a harvested grove and logs it with its name and the tile; stripped of stock, it plants until its bank is empty to the unit, family by family, then goes home; it pickets a datacentre site for at most its bounded ticks and the site still finishes; a world still ends at exhaustion with the lobby active, and it stops at once
- rushed against sustainable bots on one Earth: both reach a factory, a datacentre and automation; the rush gets its datacentre sooner, destroys more than five times as much, and never buys a kit; the green route extracts more useful stock and keeps its datacentre running longer
- both strategies finish a whole five-world campaign with the books balanced on every tick and a datacentre on every world
- an equal Bottled Sun makes more parts through an efficient factory than a quick one before it runs out, and an idle factory leaves the reserve alone
- a schema-1 room migrates with no goods, no claims and zero restored, keeps its datacentre, and the datacentre keeps running; a belt carrying coolant into a legacy datacentre delivers nothing (the review found it vanished into a tank legacy buildings never drink from)

**`spec/server.test.ts`**, the real server over HTTP and WebSocket:

- `/`, `/play/` and `/api/health` answer
- a room can't be created, and a WebSocket can't open, from a foreign origin
- **real time**: one player's harvest reaches a second open session in under a second, without a reload
- a returning browser's token restores its identity; an unknown token gets a new player
- a resent harvest applies once (acknowledged twice); a command from a stale incarnation is refused with a fresh snapshot
- messages built to throw when coerced (an `id` or `n` that's an object with a broken `toString`) are refused, and the server and room carry on: an independent review found this crashed the whole process
- malformed messages are refused without disturbing the room
- **restart recovery**: a private server on its own data directory is stopped with SIGTERM and restarted; the player rejoins as themselves under a new incarnation and the harvested tile is as they left it
- **crash recovery, and how much a crash can lose**: a player harvests eight times, one swing every 0.85 s, and the server is SIGKILLed 0.3 s after the last acknowledgement, between saves. After restart, every harvest acknowledged more than 1.2 s before the kill (the one-second save interval, a 50 ms step and scheduling slack) is in the ledger, and nothing beyond what was acknowledged is. Against the old five-second interval this test fails. Both recovery tests check the ledger's extracted count rather than one tile, since a lobbyist may replant that tile in between
- **the action log**: a private server's stdout names both players' joins with their ids and names, a harvest-mode change, a lobbyist's arrival, every line in the `room= stage= tick= actor= name= action=` shape, and never either player's token

**`spec/invariants.test.ts`**, the course's: `/` answers and `/readme/` publishes this README with every heading.

55 tests, all passing locally against a freshly built server.

## Multiplayer playthroughs

`scripts/playbot.ts` joins a room over the real protocol and plays with the decisions in `scripts/brain.ts`: the whole chain (homes, power, a factory and its parts, a claim, a datacentre, pumps and pipes, harvesters belted to stores, domes, radiators, relays, kits) wherever the server accepts. The spec runs the same decisions directly against the simulation. Bots and real browsers (driven by `agent-browser`, headless Chrome) shared rooms throughout:

- **Full campaign**: two bots and two browsers, rapid preset, Earth to the ending in about six minutes. Every stage boundary, the Bottled Sun carryover, the remnant worlds in the Solar System and Universe, and the ending's archive appeared in both browsers.
- **Both browsers saw the same world**: same buildings, same damage, each other's avatars and names, emotes.
- **Reconnect**: the server was restarted (SIGTERM) under a live browser session; the page showed "reconnecting", came back by itself under the new incarnation, and the next keyboard action went through.
- **Keyboard only**: walk, harvest with `E`, choose a building with `2`, place it with `Enter`. This caught a real bug (a stump refusing a building) and a crash path in the key handler.
- **Dense rooms**: one room at the 8-player cap (seven bots and a browser) plus three more rooms of four bots each.
- **Delay and jitter**: a TCP proxy adding 150 ± 100 ms each way, in order (a 430 ms round trip as measured by the in-game ping), with a browser and a bot playing through it beside an unlagged browser. Movement stayed smooth (own avatar is predicted), actions were confirmed a round trip later, nothing was applied twice or lost, and the stockpile stayed consistent across all three.

**The factory chain in a real browser** (crit 10), `agent-browser` at 1920×1080 and 390×844 beside a rush bot on the rapid preset:

- **Ownership conflict**: with the bot's claim and datacentre in place, the browser player picked a Plaza and pointed at the bot's ground. The ghost read "✕ that's Bo's land", the click was refused with the same toast, and the server log recorded `action=refused cmd=build reason="that's Bo's land"` under the browser player's id and name.
- **Placing and removing a line**: `L`, a click on each end; the preview read "cable: 3 new tiles, 3 metal ore. Click to lay", and the server logged `action=line kind=cable tiles=3`. `X` on one of those tiles took it up (`action=unline`).
- **Recovering from a shortage**: the bot's factory sat at "idle: no metal ore (needs 3, has 1)". The browser player walked over and pressed `F`: the server logged the load (`loaded="2 mineral + 1 matter"`) and the factory's next batch three ticks later.
- **Two browsers, no shared storage**: two separate `agent-browser` sessions joined one room as Ada and Bo. Ada harvested, then claimed a plot with `C` (the ghost read "✓ claim this 4×4"); Bo's browser, pointing a Plaza at it, read "✕ that's Ada's land" on the ghost and in the toast, and the server log told them apart by id and name: `name=Ada action=claim claim=1 x=9 y=8`, then `name=Bo action=refused cmd=build reason="that's Ada's land"`.
- **Mobile**: at 390×844 the toolbar scrolls, the corner buttons sit above it, and tapping open ground walked the player there.
- Console clean throughout.
- **A whole live campaign**: a rush bot and a green bot over the real protocol, rapid preset, from Earth to the consumed ending in about 13 minutes, a factory and datacentre on every world, two World Engines rendered down in the Universe when the Bottled Sun ran out. Reading its server log found one narration bug: a render logged the engine's name in place of the player's. Fixed, with a spec that every event names its actor.

## Visual inspection

Screenshots at 1920×1080, 1600×900, 1400×850, 1280×720 and 390×844 of: lush Earth, industrial Earth (smoke, browned rings around furnaces), spent Earth (12% living land), Mars with domes and a colony stalled on ice, the Sun bright and dimmed, the Solar System with relays and remnants, the Universe with its stars going out, a transition card and the ending. Findings fixed along the way: overlapping HUD panels at 1280×720, a sky that stayed bright after the Sun was spent, an Earth that never looked desolate (the water-table rule), toasts stacking, duplicate player names.

At 390×844 the game renders and the HUD fits (secondary panels hide), but it's a desktop game: there are no touch controls.

**Accessibility**: `agent-browser a11y` (axe-core 4.12 in a real browser) reports no violations on the front page or the play screen with the HUD loaded. Every control is a native button or input with a text label; building status and stock levels are text, never colour alone; there's a reduced-motion setting defaulting to the OS preference; audio starts only on a click and has three volume controls.

## Performance

Targets: 60 fps at 1080p on an ordinary laptop; server tick well inside 100 ms; memory well inside the 256 MB Fly machine; no unbounded growth.

Measured (Node 24.21, headless Chrome 153, on an AMD Threadripper 7960X workstation, which is much faster than an ordinary laptop):

| Measure | Scene | Result |
| --- | --- | --- |
| browser frame time | 1920×1080, Mars, 8 players and ~20 buildings | ~1.2 ms (moving average in the settings panel) |
| browser frame time | 1280×720 through the 430 ms lag proxy | ~1.6 ms |
| server step (all rooms) | 6 rooms, 20 connections, rapid economy | 0.5--1.4 ms typical, 7.4 ms worst (a stage boundary: save plus snapshots) |
| server memory | same | 97 MB at start, 101--104 MB after 100 s, flat |
| outbound traffic | same | 227 KB/s total before compact movement, 136 KB/s after (about 6.8 KB/s per connection) |

Frame time leaves about tenfold headroom on this machine, which suggests a laptop will hold 60 fps, but that isn't established: no ordinary laptop was available. The "low detail" setting turns off wildlife and particles if it's needed. Interest management isn't implemented (every client gets every change in its room); at 32×32 tiles and eight players that's affordable, and it's the first thing to add if maps grow.

Unbounded growth is guarded by design: the activity log keeps 40 entries, receipts 64 per player, interpolation 12 samples per player, toasts 3, pending commands 32; the archive and history grow by a handful of entries per world and stop at the ending.

## Playtesting questions

Answered from bot runs and browser play, not from human playtesters, which this run didn't have:

- **Is the first harvest satisfying?** It has a swing, a pop of "+1 timber", a dust burst and a tone, and a tree visibly thins and becomes a stump. A human should judge the feel.
- **Are buildings useful?** Each unlocks something the previous couldn't do, and the memo walks through the order.
- **Does automation produce new decisions?** Yes, mostly about shortages: the dense Mars test stalled a whole colony on ice, which led to the bottleneck line in the stockpile panel.
- **Can players understand shortages?** Every idle building says why in its inspect panel, and the stockpile panel names the commonest reason.
- **Does environmental loss register without a speech?** After the water-table rule, yes: green to brown across the whole island, birds and birdsong thinning, archive lines as places go.
- **Does cooperation change the experience?** Shared stockpile, helping raise sites, and dependent chains (ice before domes before datacentres) reward dividing work. Untested with humans.
- **Is the end of a stage tedious?** The survey arrow removes the hunt; the last few deposits are still gathered by hand if the machines have run dry.
- **Does each scale feel different?** Each world changes one rule (smoke, air, heat, relays and a finite reserve, legacy engines) and the look and avatar change with it.
- **Does the ending land?** It's deliberate and quiet. Whether it lands needs people.

## Not done

- **Deployment**: this run doesn't deploy; CI deploys the pod's app on push. Nothing here claims a verified live deployment.
- **Human playtesting**: everything above is bots and a scripted browser.
- **An ordinary laptop**: see performance.
- **Mobile and touch**: tap to walk works; laying lines and claiming by touch work but are fiddly, and no human has tried it.
- **Human playtests of the factory chain**: the pacing table in `DESIGN.md` is bots, who know the recipes. A first-time group will be slower to the datacentre.

## Next development, in priority order

1. Human playtests of the first ten minutes (factory, claim, datacentre, first belt) and the ending, then tuning from what people actually do.
2. Interest management (send each client only nearby tile changes) before maps grow.
3. Sprite art for buildings and avatars, replacing the procedural shapes one family at a time (see [`ASSETS.md`](ASSETS.md)).
4. Host moderation: remove a player, lock a room to new joiners.
5. A photo album kept per room, so the archive has pictures, not just names.
6. Touch-first line laying (drag to draw).
