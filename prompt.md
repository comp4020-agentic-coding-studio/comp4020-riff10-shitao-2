# The datacentre is earned, the factory is lived with, and the Green Lobby fights back

## What we want

Right now a Datacentre on Earth costs 10 stone and 6 timber, so most rooms have
one within a few minutes and the bot builds it third. It should instead be
**earned through a visible supply chain and staked-out ground**: raw stock, then
manufactured parts, then a claim, then the build.

Give Plenty a clear, satisfying factory progression: gather raw resources,
process them into parts, claim land, build a datacentre, automate supply, then
improve the network. The datacentre is an earned milestone with a short,
understandable supply chain, and it must still be reachable quickly using cheap,
inefficient and environmentally destructive methods.

Reward those shortcuts immediately: faster harvesting, cheaper construction,
more output and earlier compute. Their consequences emerge through continued
play: wasted deposits, damaged land, thirsty cooling, heat, overloaded supply
lines and an energy reserve that runs out sooner. Sustainable harvesting and
construction require more materials, planning and setup, but reward sustained
operation and endgame play. A speedrunner can deliberately skip them and still
finish. Players can mix approaches and retrofit later; neither route is a
mandatory moral choice or a permanent class selected at the start.

Against all of that, add an opposing side: **the Green Lobby**, server-run
environmental agents who put a bounded amount of stock back into the world and
push back harder the closer the players get to a datacentre.

This brief is the master version. It merges two earlier riff prompts: the
datacentre-as-summit chain with the Green Lobby, and the factory-progression
expansion. **Where they disagreed, this is the resolution:** keep manufactured
goods, land claims and the Green Lobby exactly as specified, but the datacentre
is **not** the last thing a group builds. It is the gate that unlocks a
substantial automation and optimisation phase. Everything else from both briefs
holds.

## Inspiration and scale

Read these references for design principles, then adapt them to Plenty's small
maps and short cooperative sessions:

- [Satisfactory's official overview](https://www.satisfactorygame.com/): use
  visible production chains, belts and pipes, and the satisfaction of reducing
  manual labour. Its construction, exploration and automation loop is the
  inspiration for arranging a working setup and improving it.
- [Factorio's official overview](https://www.factorio.com/): connect resource
  extraction, manufacturing and infrastructure so each new capability creates
  an understandable demand on the previous stage.
- [Factorio modules](https://wiki.factorio.com/Module) and
  [pollution](https://wiki.factorio.com/Pollution): use explicit trade-offs
  between production speed, resource efficiency, energy use and environmental
  impact. Our consequences should emerge from the economy and landscape.

Keep the implementation compact: a small recipe set, simple grid connections,
bounded buffers and a few meaningful upgrades. No trains, vehicles, combat,
large research tree, detailed fluid physics or hundreds of component types.
The sustainability mechanics below are this game's design direction, not a
claim that either reference game implements them in the same way.

## The progression on every world

1. **Survey and gather.** Show the nearest deposits and the materials needed
   for the next useful building. Hand harvesting always works without power,
   compute or ownership. Metal has to be one of the things players visibly
   collect: on Earth the player sees and harvests **metal ore**, either by
   relabelling Earth's `mineral` family as ore and updating its presentation,
   or by adding ore deposits only if that is demonstrably cleaner. Prefer
   retaining the three existing resource families and their conservation
   ledger. Pick the cleaner option, record it in `docs/DECISIONS.md`, and keep
   `ledgerHolds` true either way.
2. **Establish workers and power.** Build basic housing and a cheap power
   source. Baseline housing must supply workers before it receives compute.
   Lay a short cable connection to the first production area. Renewable power
   is an optional larger investment where the world's existing rules allow it.
3. **Manufacture parts.** Add a **Factory** that turns raw inventory into
   **manufactured goods**: at minimum **wire** (from metal) and one more part a
   datacentre plausibly needs, such as a structural frame (metal + matter) or
   circuit boards (wire + stone/silica). It is a real building in the existing
   economy: powered and staffed, requiring **zero compute**, showing its status
   in the inspect panel and saying what it is missing when idle ("idle: no
   ore"). Start with hand deliveries. The first factory must be buildable from
   raw stock, as must the cables and other equipment needed to run it. No
   circular dependencies.
4. **Claim and build.** A player claims a small plot of ground (for example a
   4×4 square) with a new command, then builds a Datacentre entirely inside it
   using wire, the second part and a little raw stock, plus workers, power and
   coolant. `placementProblem` gives a clear reason for each failure: "needs 6
   wire (have 2)", "claim this ground first", "that's Ada's land". Show all
   shortages before construction and operating shortages afterwards. Claiming
   should be a quick spatial decision, not a long grind.
5. **Automate the supply.** Compute enables Harvesters. Connect their output
   to factories with belts, bring coolant through pipes, and extend electricity
   to the new machines. The first complete loop should visibly reduce manual
   work. Factories also keep producing parts for expansion and upgrades.
6. **Find the bottleneck.** More extraction exposes limited factory throughput;
   more factories expose power, coolant and transport limits. Players decide
   whether to add cheap capacity, overwork the existing setup, shorten routes,
   improve recipes or invest in efficient equipment.
7. **Optimise or rush onward.** A hurried setup advances sooner but consumes
   more stock per useful result. A carefully planned setup delivers more useful
   production from finite inputs and runs longer before shortages. Preserve
   the world's existing exact-exhaustion transition: these milestones guide
   play, and are not new mandatory gates for leaving a world.

Use the same chain on every stage, with the stage's own names (Mars, the Sun,
the Solar System and the Universe already have their own words for everything
in `STAGES[].names` and `families`). Retune each later stage's `starter` bundle
so a group can't skip the chain, and can't stall before reaching it.

For a normal-pace group of two to four players, initially target a useful
factory in the first couple of minutes and a rushed first datacentre around
three to five minutes. These are tuning targets, not measured claims. The
first ten minutes should include successful automation and an improvement
choice. Do not achieve progression by adding long timers or inflated costs.
Measure and adjust targets against the actual game and player count.

## Recipes and manufacturing

Use a small explicit recipe table in `shared/content.ts`. Starting values may
be tuned after testing; preserve the differences between the routes:

| Recipe | Quick production | Efficient production |
| --- | --- | --- |
| Wire | 3 mineral -> 2 wire in 1 batch interval | 3 mineral -> 3 wire in 2 intervals |
| Frame | 4 mineral + 3 matter -> 1 frame in 1 interval | 3 mineral + 2 matter -> 1 frame in 2 intervals |
| Efficiency kit | 2 wire + 1 frame -> 1 kit | Same recipe; a deliberate investment |

A first datacentre might require 6 wire and 2 frames plus raw stock. Tune this
alongside the whole bootstrap budget, including housing, factory, power,
cables and any world-specific support. Do not require efficiency kits for the
first datacentre or the completion of a campaign.

Factories have a selected recipe, visible input/output buffers, batch progress,
and an optional output target that pauses production once enough is made.
Production may be automatic per economy tick or player-chosen per recipe; your
call, as long as the state is legible. Recipe changes cannot duplicate
committed inputs or reset progress for free. Offer a simple default that
produces the parts for the next datacentre, so a new player need not manage a
complicated queue. Clearly distinguish missing inputs, insufficient
power/workers and a full output buffer.

Installing an efficiency kit unlocks the factory's efficient recipes, or
improves a supported building's operating costs. Make the installed benefit
specific in the inspect panel. Use one upgrade tier initially. Retrofitting
costs real parts and improves future operation; it cannot undo earlier damage.

## Simple travel, electricity, water and conveyor mechanisms

Layout must affect the setup. Implement these four mechanisms with a clear
placement preview, total cost, connected/disconnected state and inspectable
benefit. Use grid-aligned segments and endpoint selection or short drag paths.
Connections of different types can cross without becoming the same network.
Keep movement possible everywhere and all remaining deposits reachable.

| Network | Simple mechanism | Meaningful choice |
| --- | --- | --- |
| Travel lines | Paths give players a movement bonus while travelling along them; ordinary walking remains available everywhere. | A cheap direct route is quick to build but damages more living ground. A carefully routed, more expensive low-impact path preserves more land. Shorter routes reduce delivery time. |
| Electricity | Cables connect generators to consumers. Connected supply is finite; disconnected machines cannot draw from a magical room-wide pool. | Furnaces provide cheap compact power with fuel and pollution costs; solar needs investment and ground. Short shared cable routes use fewer materials; efficient machines reduce demand and late-game reserve drain. |
| Water/coolant | An intake beside a coolant deposit feeds a bounded tank and connected pipes; hand-filled tanks provide a bootstrap fallback. | Cheap pipes have a small, explicit loss rate; sealed pipes cost more and conserve coolant. Recirculation upgrades reduce net consumption without creating water. Longer wasteful networks drain finite sources sooner. |
| Conveyor belts | Directed segments transfer whole units of raw material or manufactured goods between adjacent ports and bounded buffers at a capped rate. | Cheap belts suit a small rushed factory; parallel lines or one upgrade tier increase capacity at a material/power cost. Short balanced routes reduce transport delay and blocked machines. |

Travel lines are paths in this version; no vehicle simulation is required.
For power and pipes, connected components with a fixed transfer budget are
sufficient. For belts, one discrete movement step per economy tick is enough;
items cannot traverse an entire long belt instantaneously. Define a consistent
junction policy, such as round-robin splitting, and show direction arrows.
Avoid elaborate routing controls: one simple splitter/junction is enough.

Preserve the communal stockpile for hand gathering and construction. Automated
machines use explicit local buffers and connections. A player standing nearby
can load a machine from the shared stockpile or collect its output into it.
A small store/depot can bridge a belt endpoint to the shared stockpile. Explain
that abstraction in the UI; factories must not silently pull inputs across the
map when their intended supply line is disconnected. This keeps manual setup
possible while making automated logistics useful.

Intakes and initial transport must not require datacentre compute; Harvesters
still do. Every powered network component has an explicit operating cost.
Idle, blocked or disconnected components must not consume inputs as if they
were producing. Define stable allocation when supply is insufficient so the
same machine does not win accidentally because of client message ordering.
Keep workers and compute shared unless an existing world rule says otherwise.

Show pipeline losses as consumed coolant from already-extracted stock. For
integer accounting, use persisted counters, for example losing one unit per
N transferred, rather than rounding tiny losses to zero. Save these counters
so reconnecting or toggling a mode cannot erase costs. Water recovery reduces
net withdrawals; it never refills natural deposits or creates an infinite loop.

## Fast extraction and sustainable building

Provide an understandable harvesting choice before automation, then carry the
same trade-off into Harvesters:

- **Intensive harvesting:** more useful resources per action/tick, but removes
  additional natural stock as waste and causes more local damage. For example,
  take 2 useful units and destroy 1 additional unit when enough remains.
- **Careful harvesting:** slower useful output, minimal additional destruction
  and reduced collateral damage. It remains possible to take the last unit.
  Automated careful operation may require an efficiency kit to reach its best
  performance, making sustained efficiency an investment.

Clamp both useful extraction and destruction to stock actually present. Record
useful output as `extracted`, collateral loss as `destroyed`, and reduce the
deposit by their sum. Display the expected yield and waste before the action.
Consumption of stock already in an inventory must not be counted a second time
as destruction of a natural deposit.

Offer standard and efficient construction for major production buildings and
infrastructure. Standard construction is affordable, quick and rough on the
site. Efficient construction costs additional parts and setup time, reduces
construction damage and improves a stated operating cost. A datacentre might
use less coolant per sustained compute output; a factory uses less material
per part; a sealed pipe wastes less water. Avoid an upgrade that improves every
stat with no trade-off. All footprints still obey deposit placement rules.

Every major build, harvest mode and network choice should expose its concrete
cost, throughput, resource use and local impact. Do not invent a universal
morality score. Sustainable layouts can still consume a finite world; they
extract more useful work from it and leave a different history on the way.

## Levels and how their decisions evolve

Keep the five existing worlds and their order. Reuse the core chain and the
same small goods/network system, with stage-appropriate names in `STAGES`.
Each world introduces a new constraint rather than restarting a long tutorial.

### Earth: learn the loop and see the cost

Gather timber, ore and water; build Cottages and a Furnace or Sun Garden; run
a Factory; manufacture wire/frames; claim a plot; connect and start a
Datacentre. Then add a Harvester, a short belt and piped cooling. Teach one
connection at a time through the goal checklist.

The fast route uses intensive gathering, compact furnace power, standard
construction and cheap pipes. It reaches compute first. Continued use burns
fuel and nearby groves, wastes ore and drains the pond. The sustainable route
invests in Sun Gardens, careful extraction, sealed cooling and efficient
recipes. It takes longer to establish but retains useful stock and operating
capacity. Pollution and named places make the consequences visible.

### Mars: coordinate a colony around scarce ice

Start with enough raw materials to establish a Dome, Solar Field and Hab Block.
Build the stage's Factory inside supported air, make parts, claim ground and
bring a Cold Datacentre online. Rover Drills and belts extend supply afterwards.
No starter crate includes manufactured goods or bypasses the factory.

Domes, cooling and production compete for buried ice. A rushed colony spreads
cheap independent facilities and leaks coolant; it grows fast and then needs
constant ice supply. A planned colony shares dome coverage, uses short sealed
pipes and upgrades cooling. Show ice consumption and the remaining supply.
The factory's pressure requirement must not create a bootstrap deadlock.

### The Sun: trade a burst of output for sustained operation

Establish a Collector Wing and Crew Ring, then an Assembly Platform, parts,
claimed Furnace Mind and Plasma Scoops. Bring forward familiar belts and
coolant connections. Radiators become a meaningful investment as heat grows.

The rushed route adds collectors and intensive scoops, obtaining a quick burst
while approaching the existing heat throttle. A balanced route adds cooling,
uses efficient machines and avoids oversized production that cannot be fed.
Preserve the Bottled Sun rule: only plasma actually extracted contributes to
the reserve. Plasma destroyed through careless extraction contributes nothing,
so an early shortcut has a real consequence in the next two worlds.

### The Solar System: live on the energy already banked

Arrive near the existing protected Depot. Establish a Station, relay coverage,
power connections and an Orbital Factory; manufacture parts and build a claimed
Orbital Datacentre. Connect Asteroid Miners to production through belts while
respecting the existing relay shipping requirement.

The Bottled Sun powers the network; there is no new solar generator here.
Sprawling, constantly running machinery gives quick capacity but drains the
reserve. Short shared routes, targeted output, efficient processing and lower
coolant demand give more useful production before the reserve empties. Show
reserve use and an estimated runtime at the current draw. Manual harvesting
remains possible after power is exhausted.

### The Universe: the endgame reflects earlier choices

Existing World Engines retain their compute role. Add a Cosmic Foundry and
stage-appropriate parts for a claimed Matrioshka Shell, then expand Galaxy
Siphons and their supply network. Existing engine compute may help bootstrap;
new datacentres still require manufacturing and claims.

Efficient infrastructure stretches the remaining energy and dark cold. A
speedrunner can use cheap intensive machinery and the existing irreversible
option to render a World Engine for an immediate energy burst, accepting the
lost compute and recorded consequence. Preserve both the exhaustion ending and
the unanimous restraint ending. Conservation must not be required to finish.
The endgame should reveal what the group consumed, wasted and preserved, and
how long its machines stayed useful, through actual measured state.

World transitions still happen when natural deposits are exhausted. Buildings,
claims, buffers and ordinary inventory reset with the world; identity, history,
archive and the existing Bottled Sun carry forward. Do not silently carry
upgrades. The bounded Green Lobby restoration below is the only new stock
source. Rebalance raw starter bundles so the whole bootstrap is possible
without skipping manufacturing. Conservation on Earth/Mars pays off locally;
the Sun's extracted reserve and later efficiency provide the explicit
mechanical link to endgame endurance.

## The other side: the Green Lobby

The players are the ones digging Earth up to get to a datacentre. Add an
opposing side: **environmental lobby agents** who are against the
datacentre and keep **putting resources back** into the world.

- They're server-run characters (not players), drawn like players but clearly
  different: their own look, a name ("Fern", "Moss" or similar), and a little
  placard or sign. They walk the map on the server tick, so every open browser
  sees the same lobbyist in the same place.
- **They replant.** A lobbyist walks to a deposit the players have harvested
  down (a stump, a dry pond, a dug-out ore pit) and puts stock back into it,
  a little at a time. The tile visibly recovers.
- **They push back harder as the datacentre gets closer.** A few lobbyists at
  the start, more once a Factory runs, and more again for each Datacentre.
  They can also picket a Datacentre site: stand beside it and slow its
  construction, or protest with a speech bubble. Pick what reads best and is
  fun, but it must never permanently block a player.
- **It's a tug of war, not a stalemate.** Restoration has to be bounded or
  the world never ends. Give the lobby a finite seed bank (for example a
  share of the world's initial stock) that runs dry. Players can also
  outpace them, so a world can always be finished.
- **The books still balance.** Replanted stock is new stock entering the
  world, so it can't appear off the books. Add a ledger column for it (for
  example `restored`) and make the identity `initial + restored = remaining +
  extracted + destroyed`. Update `ledgerHolds`, the transition summary table
  and the tests to match. The seed bank also means the total can never
  exceed a known bound.
- **Earth first.** The lobby is strongest on Earth, where there's something
  living to put back. Decide whether it follows the players to later worlds,
  and how, and write that decision down in `docs/DECISIONS.md`. Keep the
  restraint ending in the Universe intact.
- **Every lobby action is logged on the server** like player actions, with
  the lobbyist's name, the tile and the amount, so `flyctl logs` shows both
  sides of the fight.
- The HUD shows that the lobby exists: how many lobbyists are active, how
  much of their seed bank is left, and a log line when they replant
  ("Fern replanted the Old Oak's grove").

### Integrating the lobby with factory progression

Preserve the Green Lobby above alongside the fast and sustainable routes. Its
finite seed bank is the sole explicit exception to the base finite-stock rule:
restoration is bounded new stock, recorded in `restored`, and never an unlimited
renewable resource. Sustainable machinery still saves inputs rather than
creating them. A world ends at exact deposit exhaustion; a remaining seed bank
must not resurrect a world after its transition has begun. Lobby actions stop
in transition, ended and empty-room states. Initialise and persist a per-world
seed bank, restored counters and lobbyists; migrated ledgers start at zero
restored. Define the bank's allocation by resource family so ore and coolant
cannot be created from an unbounded generic balance.

Keep opposition readable and avoid making sustainability a way to bypass the
whole production chain. Picketing can slow construction but must have a bounded
effect; it cannot steal ownership or permanently prevent completion. Measure
both play strategies with the lobby active. Test replanting, bank exhaustion,
resource-family bounds, the extended ledger, save/load and eventual campaign
completion. The new ledger identity explicitly replaces the old identity in
the supplied harness for this feature; preserve all other invariants.

## Quick deposit respawn (replaces gradual depletion for individual nodes)

Right now a tile's natural deposit depletes gradually across many harvest
actions (`takeFrom` in `shared/world.ts`), staying bare until a Green Lobby
agent happens to walk over and replant it. Change how an individual node
recovers, without breaking the finite-world thesis the rest of this brief
depends on:

- When a harvest action empties a tile's current stock (`tile.amt` reaches
  0), the deposit disappears immediately: the same bare rendering the game
  already has (stump, dry pond, dug pit).
- After a short, fixed delay once bare — a few seconds, tuned per family and
  stage in `shared/content.ts`, long enough to not feel instant but short
  enough that a player who moves on and comes back finds it live again — the
  tile automatically refills to a fresh amount and its tree, rock or water
  reappears, with no player or lobbyist action required.
- This automatic refill is new stock entering the world, exactly like the
  Green Lobby's replanting, so it must be added to the same bounded
  `restored` ledger column (or a clearly named sibling column, if you keep
  the two separate — document the choice in `docs/DECISIONS.md`), drawn from
  a finite bank, never invented off the books. `initial + restored =
  remaining + extracted + destroyed` must keep holding.
- Give this respawn a bounded bank per resource family per world — shared
  with the Green Lobby's seed bank or a separate one, your call, written down
  in `docs/DECISIONS.md` — so that once a family's bank is spent, tiles stop
  respawning and stay bare for good. A world must still be able to reach
  exact exhaustion and end; respawn must never be unbounded or permanent.
- Log each automatic respawn as a server event (tile, family, amount
  restored), the same way a lobby replant is logged, so `flyctl logs` shows
  it.
- Add tests in `spec/sim.test.ts`: a harvested-bare tile respawns after its
  delay with the refill correctly added to `restored`; `ledgerHolds` stays
  true through many harvest/respawn cycles; the respawn bank runs dry and
  tiles then stay bare permanently; a world with respawn active can still
  reach exact exhaustion and end.

This changes only how an individual node recovers. The family-wide ledger,
the Green Lobby's own slower walk-and-replant behaviour, and the
exhaustion-based world ending all stay exactly as specified elsewhere in
this brief.

## Claims, permissions and cooperation

Add a claim command for a small plot, such as 4×4 tiles, with a modest cost or
per-player cap so nobody grabs the whole map. Display its boundary in the
owner's colour and name. The server refuses other players' construction or
demolition inside it. A Datacentre must fit entirely inside its builder's
claim. Claims never block walking, hand harvesting or access to deposits, and
claimed ground must never make a deposit unreachable.

Keep unclaimed ordinary construction possible. Do not let a new claim capture
someone else's existing buildings or infrastructure. Players may connect at
exposed network endpoints without gaining demolition or reconfiguration rights.
Owners control their buildings, recipes, upgrades and lines; the host retains
an explicit recovery override consistent with current demolition powers.
Claims and machines survive temporary disconnection.

**Write the ownership rule down.** Add a short section to `docs/DECISIONS.md`
(or a new ADR in `docs/adr/`) covering what a claim lets its owner do, what it
stops others doing, what the host can override, how shared supply works across
an ownership boundary, and why.

## Feedback and player experience

- A new player still gets a satisfying first ten minutes. They harvest, build
  homes, power and a Factory, and see wire appear in the shared inventory. The
  Datacentre becomes something they can see coming and plan for.
- The goal checklist (around `client/Game.tsx:537`) explains the next useful
  action and why: gather ore, house workers, connect power, make parts, claim
  ground, cool the datacentre, automate a supply line, then inspect a
  bottleneck.
- The build bar shows goods costs next to raw costs and greys out what can't be
  afforded, as it does now. Build previews show raw and goods costs, ownership
  conflicts, network connections and operating needs, with specific messages
  such as "needs 6 wire (have 2)", "claim this ground first" and "that's Ada's
  land".
- Compute still matters as much as before. Harvesters still need compute, so
  automation waits until a group has worked through the chain and claimed land.
  That's the point: dependency arrives later and costs more.
- Inspect panels show current throughput, expected inputs per output, power
  draw, coolant use, buffer fill and a plain-language idle reason. Network
  overlays make breaks and overloaded sections visible without relying on
  colour alone. Keep touch controls practical on mobile.
- Track useful production, resource waste, coolant consumption, energy draw
  and renewable share where renewable power exists. Compare rates and totals
  separately; a fast machine and an efficient machine are different choices.
  Never label the finite Bottled Sun as renewable electricity.
- Consequences should be readable in the world and operational feedback:
  damaged places, shrinking sources, stalled input, heat throttling and lower
  reserve. Keep the Cooperative's warm tone and avoid moralising popups.
- **Every claim, build, demolish, upgrade, mode/recipe change, factory batch
  and lobby action is logged on the server** as one line per action with the
  actor's id and display name, room and stage, so `flyctl logs` alone shows who
  did what and both sides of the fight. The next crit is narrated from those
  logs. Autonomous batches identify the owning player and machine. Network
  placement can be one log entry per completed path rather than one per tile.
  Never log tokens.

## Rules that still hold

Read the "What the game must never do" and "What a change must not break"
sections of `CLAUDE.md`, plus `docs/ARCHITECTURE.md`, and keep every one of
them: server ownership, origin checks, explicit `.ts` imports and the existing
renderer/HUD update boundaries.

- The server decides. A claim, factory recipe, transfer, permission, bound,
  cost or datacentre placement is validated in `shared/sim.ts`, whatever the
  client sends. Client previews never determine an outcome.
- Extend the ledger to `initial + restored = remaining + extracted + destroyed`
  for the Green Lobby and keep `ledgerHolds` true. Manufactured goods and local
  buffers are separate, whole-number, never-negative stores, outside the
  natural-stock ledger: turning ore into wire changes `inventory`, not the
  `ledger`. Transfers conserve their contents.
- Define bounded storage and backpressure: a full destination stops delivery;
  a disconnected belt cannot delete or duplicate items. Deleting a line or
  machine returns its buffered contents exactly once, separately from salvage.
  Salvage of a Factory, a Datacentre or an installed upgrade returns strictly
  less than it cost, goods included.
- This changes the wire format and saved state. Persist batch progress,
  pipe-loss counters, goods, claims, infrastructure, buffers, upgrades,
  lobbyists and seed banks. Bump `PROTOCOL_VERSION` and `SCHEMA_VERSION`, and
  add a migration in `server/store.ts` so saved rooms load with no goods, no
  claims, zero restored and their existing datacentres kept. Give legacy
  buildings a documented compatibility supply mode or valid initial connections
  so loading an old room does not break its economy.
- Balance lives in `shared/content.ts`. Integer batch counters can express
  reduced consumption without fractional inventory. Test mode switches and
  reconnects so players cannot evade costs or duplicate batch outputs.
- Empty rooms pause, ended campaigns stay ended, and stage boundaries are saved
  before announcement. No new factory milestone blocks exact exhaustion.

## Implementation and acceptance

Implement in manageable steps: goods and the bootstrap chain; claims; the Green
Lobby; simple local buffers and networks; fast/careful operation and upgrades;
all-world balance and feedback. Finish a working version of all four network
types. Prefer simpler complete mechanics over decorative connections or
unfinished simulation features.

Update `scripts/playbot.ts` so the bot follows the new order on every stage —
gather, factory, parts, claim, datacentre, automate — for both rushed and
sustainable strategies. Both must establish workers and power, manufacture
parts, claim ground, build a datacentre and use at least one working automated
supply line. Run complete campaigns at `rapid` pace to prove nothing stalls.
Measure normal-pace Earth with identical seeds and player counts, including a
hand-harvest-only baseline. Compare time to first factory/datacentre, useful
output, wasted stock, coolant used and energy used. Also test late-stage
runtime with an equal starting reserve. Sustainable setups must show a
measurable efficiency/endurance benefit after their setup cost; rushed setups
must retain an early speed advantage and remain completable. Record real
results and tuning in `docs/DESIGN.md` (including the new building, recipe and
network table rows) and `docs/TESTING.md`.

Add tests in `spec/sim.test.ts` for each of these:

- A datacentre is refused without goods, refused outside a claim, and refused
  on someone else's claim.
- A factory turns ore into wire and the natural ledger still holds.
- A claim never blocks a harvest, and cannot capture another player's assets.
- Salvage is strictly below cost.
- The lobby replants harvested tiles; its seed bank runs dry and caps what it
  can put back, per resource family; the extended ledger holds through a whole
  bot campaign; and a world still ends with the lobby active.
- The first factory and datacentre are reachable without pre-existing compute
  or manufactured goods, using baseline workers on every stage.
- Recipes consume the correct inputs, preserve the natural ledger, and cannot
  duplicate work through switching, pausing, reconnecting or save/load.
- Intensive harvesting is faster but wastes real stock; careful harvesting
  preserves more useful stock, including when only one or two units remain.
- Disconnected power, empty coolant and blocked/full belts produce correct
  idle states; forks, loops and simultaneous transfers conserve resources.
- Pipe losses and cooling recovery are accounted for exactly; upgrades do not
  create water, energy or raw stock, and demolition cannot yield profit.
- Efficient operation saves inputs for a comparable useful output, while the
  rushed route can complete without buying sustainable upgrades.
- All five stage bootstraps, legacy-save migration, exact exhaustion, both
  endings and the empty-room pause still work.

Update the player guide in `README.md` for the new progression, the
building/recipe/network tables in `docs/DESIGN.md`, and the relevant
decisions/architecture documentation. Test the real built UI at desktop and
mobile sizes, including placing/removing a line, recovering from a shortage and
a two-player ownership conflict. Run `pnpm check` with its required running
server and keep `main` deployable. Delete this `prompt.md` in the
implementation agent's last commit, as required by the supplied riff harness.

## Leave alone

The stage order, the five mechanics (pollution, pressure, heat, relay,
legacy), the restraint ending and the empty-room pause. This brief changes how
a group gets to a datacentre, what they do with it afterwards, and adds the
Green Lobby against them. Don't redesign anything else.
