// What a tap does on a touch screen. A finger has no hover, so anything that
// spends stock or takes something down is aimed first (the ghost preview shows
// the cost or the problem) and done on a second tap on the same tile, or the
// touch bar's confirm button. Pure, so the spec can walk a touch-only player
// through the early chain without a browser.
import { BUILDINGS, HARVEST_RANGE } from "../shared/content.ts";
import type { Snapshot } from "../shared/protocol.ts";
import type { View } from "./render.ts";

export type TouchStep = { k: "walk"; to: [number, number] } | { k: "aim"; at: [number, number] } | { k: "act"; at: [number, number] };

/** Tools whose action costs stock or removes something: aim, then confirm. */
export const needsConfirm = (view: Pick<View, "tool" | "line">): boolean =>
  view.tool === "build" || view.tool === "claim" || view.tool === "demolish" || (view.tool === "line" && !!view.line?.from);

const same = (a: [number, number] | null, b: [number, number]): boolean => !!a && a[0] === b[0] && a[1] === b[1];

export function touchStep(s: Snapshot, view: Pick<View, "tool" | "line" | "aim">, me: { x: number; y: number }, at: [number, number]): TouchStep {
  const [x, y] = at;
  const t = x >= 0 && y >= 0 && x < s.w && y < s.w ? s.tiles[y * s.w + x] : undefined;
  if (view.tool === "harvest") {
    if (!t) return { k: "walk", to: at };
    const site = t.b ? s.buildings.find((b) => b.id === t.b) : undefined;
    // a site still going up is helped like a harvest, so it walks there first when out of reach
    const raising = site && site.work < BUILDINGS[site.type].build * 10;
    const reach = Math.hypot(x - me.x, y - me.y) <= HARVEST_RANGE;
    if (site && !raising) return { k: "act", at };
    if (((t.d && t.amt > 0) || raising) && reach) return { k: "act", at };
    return { k: "walk", to: at };
  }
  if (!needsConfirm(view)) return { k: "act", at };
  return same(view.aim, at) ? { k: "act", at } : { k: "aim", at };
}

/** The touch bar's confirm button text for what's aimed, or null when nothing needs confirming. */
export function confirmLabel(view: Pick<View, "tool" | "line" | "aim" | "build">, name: (type: NonNullable<View["build"]>) => string): string | null {
  if (!view.aim || !needsConfirm(view)) return null;
  if (view.tool === "build" && view.build) return `Place ${name(view.build)}`;
  if (view.tool === "claim") return "Claim here";
  if (view.tool === "demolish") return "Take down";
  if (view.tool === "line" && view.line) return `Lay ${view.line.kind}`;
  return null;
}
