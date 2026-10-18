/**
 * Pane placement policy tests.
 *
 * `layout.ts` is pure functions over a snapshot of tmux state, so the whole
 * decision table — how many panes a column holds, what a window is to us, and
 * where the next pane goes — is exercised here without a multiplexer running.
 * The numbers come from measurements against real tmux (a 238x58 window gives
 * column panes of 13/13/13/16 rows at K=4 and 10 rows at K=5; `tiled` gives 9
 * panes on a 200x50 66x16 each and 12 panes 66x11).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  choosePlacement,
  classifyWindow,
  columnCapacity,
  overflowCapacity,
  type PaneInfo,
  type WindowInfo,
} from "../pi-extension/subagents/layout.ts";

/** `pane("a")` is marked; `pane()` is an unmanaged pane (the parent). */
function pane(id: string, tree = "ROOT"): PaneInfo {
  return { id, tree };
}

function window(id: string, width: number, height: number, panes: PaneInfo[]): WindowInfo {
  return { id, width, height, panes };
}

describe("columnCapacity", () => {
  it("holds four subagents beside the parent on a 58-row terminal", () => {
    // The geometry this came from: 13/13/13/16 rows per column pane.
    assert.equal(columnCapacity(238, 58), 4);
    assert.equal(columnCapacity(200, 58), 4);
  });

  it("drops to three rows-worth of panes when the window is 50 rows", () => {
    // K=4 would leave 11 rows each, under the 12-row floor.
    assert.equal(columnCapacity(238, 50), 3);
  });

  it("grows with the window and then stops", () => {
    assert.equal(columnCapacity(238, 64), 5);
    assert.equal(columnCapacity(238, 200), 6);
  });

  it("is zero when the window is too narrow to hold both halves", () => {
    // 120 columns would leave the parent and the column under 60 each.
    assert.equal(columnCapacity(120, 58), 0);
    assert.equal(columnCapacity(100, 58), 0);
    assert.equal(columnCapacity(121, 58), 4);
  });

  it("is zero when a single column pane would be too short", () => {
    assert.equal(columnCapacity(238, 12), 1);
    assert.equal(columnCapacity(238, 10), 0);
  });
});

describe("overflowCapacity", () => {
  it("matches the grids tiled actually produces", () => {
    // 3x3 on both, the shape measured at 9 panes.
    assert.equal(overflowCapacity(238, 58), 9);
    assert.equal(overflowCapacity(200, 50), 9);
  });

  it("stops growing past the readability ceiling", () => {
    assert.equal(overflowCapacity(300, 80), 12);
    assert.equal(overflowCapacity(600, 200), 12);
  });

  it("never returns less than one, so a spawn always has somewhere to go", () => {
    assert.equal(overflowCapacity(50, 20), 1);
    assert.equal(overflowCapacity(1, 1), 1);
  });
});

describe("classifyWindow", () => {
  it("calls a window home when the parent is the only unmarked pane and comes first", () => {
    assert.equal(classifyWindow(window("@1", 200, 50, [pane("parent", "")]), "ROOT"), "home");
    assert.equal(
      classifyWindow(
        window("@1", 200, 50, [pane("parent", ""), pane("%2"), pane("%3")]),
        "ROOT",
      ),
      "home",
    );
  });

  it("calls a window home for a subagent too, since the parent is still first", () => {
    // A nested child sees the same window and must reach the same answer.
    assert.equal(
      classifyWindow(window("@1", 200, 50, [pane("parent", ""), pane("%2"), pane("%3")]), "ROOT"),
      "home",
    );
  });

  it("calls a fully marked window overflow", () => {
    assert.equal(classifyWindow(window("@2", 200, 50, [pane("%4"), pane("%5")]), "ROOT"), "overflow");
  });

  it("leaves a window the user split alone", () => {
    // Two unmarked panes: the parent plus a shell of the user's own.
    assert.equal(
      classifyWindow(window("@1", 200, 50, [pane("shell", ""), pane("parent", "")]), "ROOT"),
      "foreign",
    );
    // A window whose first pane is marked is not ours to lay out either.
    assert.equal(
      classifyWindow(window("@1", 200, 50, [pane("%2"), pane("parent", "")]), "ROOT"),
      "foreign",
    );
    // Panes of a different tree are not ours.
    assert.equal(classifyWindow(window("@1", 200, 50, [pane("%2", "OTHER")]), "ROOT"), "foreign");
  });
});

describe("choosePlacement", () => {
  const empty = [pane("parent", "")];

  it("splits the parent rightward once, when the column is empty", () => {
    assert.deepEqual(
      choosePlacement({
        home: window("@1", 238, 58, empty),
        anchor: "parent",
        tree: "ROOT",
        windows: [window("@1", 238, 58, empty)],
      }),
      { kind: "column", window: "@1", target: "parent", direction: "h" },
    );
  });

  it("extends the column downward, never splitting the parent again", () => {
    const home = window("@1", 238, 58, [...empty, pane("%2")]);
    assert.deepEqual(
      choosePlacement({ home, anchor: "parent", tree: "ROOT", windows: [home] }),
      { kind: "column", window: "@1", target: "%2", direction: "v" },
    );
  });

  it("opens an overflow window once the column is full", () => {
    const home = window("@1", 238, 58, [...empty, pane("%2"), pane("%3"), pane("%4"), pane("%5")]);
    assert.deepEqual(
      choosePlacement({ home, anchor: "parent", tree: "ROOT", windows: [home] }),
      { kind: "overflow-new" },
    );
  });

  it("fills an overflow window that still has room", () => {
    const home = window("@1", 238, 58, [...empty, pane("%2"), pane("%3"), pane("%4"), pane("%5")]);
    const overflow = window("@2", 238, 58, [pane("%6")]);
    assert.deepEqual(
      choosePlacement({ home, anchor: "parent", tree: "ROOT", windows: [home, overflow] }),
      { kind: "overflow-add", window: "@2", target: "%6" },
    );
  });

  it("adds to the same overflow window a subagent is already living in", () => {
    // An overflow window has no unmarked pane, so a naive "no parent here"
    // reading would send this spawn to a redundant second window.
    const overflow = window("@2", 238, 58, [pane("%6"), pane("%7")]);
    assert.deepEqual(
      choosePlacement({ home: overflow, anchor: "%7", tree: "ROOT", windows: [overflow] }),
      { kind: "overflow-add", window: "@2", target: "%7" },
    );
  });

  it("opens another window when the first overflow window is full", () => {
    const home = window("@1", 238, 58, [...empty, pane("%2"), pane("%3"), pane("%4"), pane("%5")]);
    const full = window("@2", 238, 58, Array.from({ length: 9 }, (_, i) => pane(`%${i + 6}`)));
    assert.deepEqual(
      choosePlacement({ home, anchor: "parent", tree: "ROOT", windows: [home, full] }),
      { kind: "overflow-new" },
    );
  });

  it("sends everything to overflow when the parent's window is the user's", () => {
    const home = window("@1", 238, 58, [pane("shell", ""), pane("parent", "")]);
    assert.deepEqual(
      choosePlacement({ home, anchor: "parent", tree: "ROOT", windows: [home] }),
      { kind: "overflow-new" },
    );
  });

  it("sends everything to overflow when the window is too narrow to split", () => {
    const home = window("@1", 100, 58, empty);
    assert.deepEqual(
      choosePlacement({ home, anchor: "parent", tree: "ROOT", windows: [home] }),
      { kind: "overflow-new" },
    );
  });
});
