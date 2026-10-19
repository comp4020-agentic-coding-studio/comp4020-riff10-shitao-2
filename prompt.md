# Harden Plenty against its own known limits, for the final project brief

## What we want

This repo already answers the final project's three fixed requirements:
multi-user (every room is shared, server-authoritative state), real-time
(WebSocket, a 10 Hz tick, confirmed under 150 ms lag), and persistence
(SQLite on the Fly volume, survives a restart). `README.md`'s "What the game
is arguing" section already makes a real case for what "good" means here.
**Don't add game features, recipes or worlds.** This prompt is about closing
three gaps `docs/TESTING.md` already names under "Not done" and "Next
development", because the final project brief marks the deployed app against
exactly the three fixed requirements and the claims `README.md` makes about
them — and these three gaps sit directly on top of those requirements, not
beside them.

Work in this priority order. If you only get through the first one well,
that's a better outcome than three done shallowly.

## 1. Make the core loop playable on a touch screen (highest priority)

`docs/TESTING.md` says plainly: "it's a desktop game: there are no touch
controls" and laying lines "work but are fiddly" on a phone. The brief tests
the deployed app at two marking viewports, one of which is a narrow phone
width in this project's own test matrix (390×844) — so a marker judging the
multi-user and real-time claims may be doing it from a touch session.

A player using only taps must be able to complete the whole early chain
without a keyboard: walk, harvest, place a building, and **lay a line**
(cable, pipe, belt or path) — that last one is the roughest edge today. You
do not need full parity with the keyboard controls (no requirement to make
every hotkey touch-accessible, no new gestures beyond what's needed), but a
touch-only player must not get stuck unable to progress.

What "done" looks like, checkable:

- At 390×844, a touch-only session (simulate with `agent-browser` or real
  touch events, not a mouse pretending to be touch) walks, harvests, builds
  a Cottage and a power source, and lays at least one cable or belt, start
  to finish, with no step that only works with a keyboard or precise mouse
  drag.
- A new or adjusted test in `spec/server.test.ts` or a browser-driven check
  exercises this path. If a touch interaction can only be verified visually
  (gesture feel, finger occlusion), say so explicitly rather than claiming
  it's covered by an automated test — the final project brief rewards being
  clear about which claims are checked and which are judged.
- Update `docs/TESTING.md`'s "Known limits" and "Not done" sections to
  reflect what's now true, and `README.md`'s "Known limits" line if it no
  longer holds.

## 2. Make the restart/crash recovery window precise, and tested (high priority)

The brief's persistence requirement is specific: "your machine stops when
nobody is using it, so by then it has restarted, and what both people did
has to still be there." `docs/TESTING.md` already tests this
(`spec/server.test.ts`'s crash-recovery case), but the current save interval
means a crash can lose up to 5 seconds of play, and that number lives only
in prose (the save loop in `server/store.ts`), not in a spec assertion or a
documented, deliberate trade-off.

**Do not change the one-process, one-owner-per-room architecture** —
`CLAUDE.md` requires it, and this task is about tightening what's already
there, not adding replicas or a second machine.

What "done" looks like, checkable:

- Decide, and document in `docs/DECISIONS.md`, whether the save interval
  should be shortened (less data at risk, more disk writes) or left as is
  with the risk window stated precisely — either is acceptable, but it must
  be a stated decision with a reason, not an unexamined default.
- Add or tighten a test in `spec/server.test.ts` that asserts the actual
  bound: after a SIGKILL at a known point in play, at most N seconds (or
  ticks) of state are lost, where N is the number you land on. The existing
  crash-recovery test checks the ledger balances after recovery; this adds
  checking *how much* was lost, not just that recovery is consistent.
- State the resulting guarantee in `README.md` in terms a marker testing
  persistence by coming back later would recognise, e.g. "a crash loses at
  most N seconds of play, never more."

## 3. A minimal host moderation action (lower priority, only if 1 and 2 are solid)

`docs/TESTING.md` lists "host moderation: remove a player, lock a room to
new joiners" as future work, and the brief's top band rewards an app that
"holds up under use it wasn't designed for." Add the smallest version of
this: a host can remove a disruptive player from their own room, or lock it
against new joins. Do not build a chat system, a report queue or a ban list
— this game has no text chat and shouldn't get one just to moderate it.

What "done" looks like, checkable:

- A host-only command (reachable from the UI already used for other
  host actions) that removes a named player from the room or toggles the
  room locked for new joins; a non-host's attempt is refused server-side,
  the same way other authority checks in `shared/sim.ts` are.
- A test in `spec/server.test.ts`: a non-host's removal/lock command is
  refused; a host's removal disconnects the target and frees their seat;
  a locked room refuses a new join with a clear reason.
- Logged the same way every other player action is (`CLAUDE.md`'s "every
  player and lobby action is an event" rule applies here too).

## What to leave alone

Everything else: the five worlds, the factory chain, the Green Lobby, the
resource ledger, the existing recipes and balance in `shared/content.ts`.
Don't touch `spec/invariants.test.ts`. If a fix for 1–3 ever tempts you to
weaken `ledgerHolds` or any other invariant in `CLAUDE.md`'s "What the game
must never do" section, stop and find a different fix instead.

## Before you finish

Run `pnpm check` against the real Docker image (`docker build`, then
`docker run` the way `.github/workflows` does), not just a local dev server
— `PROCESS.md` already describes why that gap matters for this project.
Keep `main` deployable at every commit.
