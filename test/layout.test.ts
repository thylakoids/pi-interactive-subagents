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

/**
 * The tree id is the root *pane* id. A root's own pane is unmarked; everything
 * the extension creates in that tree carries the root pane id as its mark.
 */
const ROOT = "parent";

/** A pane the extension created for this tree (or another one). */
function pane(id: string, tree = ROOT): PaneInfo {
  return { id, tree };
}

/** An unmanaged pane: the root itself, or one the user created. */
function unmarked(id: string): PaneInfo {
  return { id, tree: "" };
}

function window(id: string, width: number, height: number, panes: PaneInfo[]): WindowInfo {
  return { id, width, height, panes };
}

describe("pane capacity tables", () => {
  it("fits the side column to measured geometry, minimum dimensions and its readability ceiling", () => {
    const cases = [
      [238, 58, 4], [200, 58, 4], // measured 13/13/13/16-row column
      [238, 50, 3],               // four panes would fall below the 12-row floor
      [238, 64, 5], [238, 200, 6],
      [120, 58, 0], [100, 58, 0], [121, 58, 4],
      [238, 12, 1], [238, 10, 0],
    ];
    for (const [width, height, expected] of cases) {
      assert.equal(columnCapacity(width, height), expected, 'column capacity at ' + width + 'x' + height);
    }
  });

  it("uses tmux tiled geometry, caps readable grids and always leaves overflow room for one pane", () => {
    const cases = [
      [238, 58, 9], [200, 50, 9], // measured 3x3 grids
      [300, 80, 12], [600, 200, 12],
      [400, 50, 9], [320, 58, 9], // a 12-pane grid would fall below the 16-row floor
      [50, 20, 1], [1, 1, 1],
    ];
    for (const [width, height, expected] of cases) {
      assert.equal(overflowCapacity(width, height), expected, 'overflow capacity at ' + width + 'x' + height);
    }
  });
});

describe("classifyWindow", () => {
  it("calls a window home when this tree's root is the only unmarked pane and comes first", () => {
    assert.equal(classifyWindow(window("@1", 200, 50, [unmarked(ROOT)]), ROOT), "home");
    assert.equal(
      classifyWindow(
        window("@1", 200, 50, [unmarked(ROOT), pane("%2"), pane("%3")]),
        ROOT,
      ),
      "home",
    );
  });

  it("calls a window home for a nested child too, since the root is still first", () => {
    // A nested child's tree is still the root pane id, not its own pane.
    assert.equal(
      classifyWindow(
        window("@1", 200, 50, [unmarked(ROOT), pane("%2"), pane("%3"), pane("%4")]),
        ROOT,
      ),
      "home",
    );
  });

  it("calls a fully marked window overflow", () => {
    assert.equal(classifyWindow(window("@2", 200, 50, [pane("%4"), pane("%5")]), ROOT), "overflow");
  });

  it("leaves a window the user split alone", () => {
    // Two unmarked panes: the parent plus a shell of the user's own.
    assert.equal(
      classifyWindow(window("@1", 200, 50, [unmarked("shell"), unmarked(ROOT)]), ROOT),
      "foreign",
    );
    // A window whose first pane is marked is not ours to lay out either.
    assert.equal(
      classifyWindow(window("@1", 200, 50, [pane("%2"), unmarked(ROOT)]), ROOT),
      "foreign",
    );
    // Panes of a different tree are not ours.
    assert.equal(classifyWindow(window("@1", 200, 50, [pane("%2", "OTHER")]), ROOT), "foreign");
  });

  it("does not treat a user pane as the root after the root pane dies", () => {
    // tmux renumbers the user's pane to the front; it is unmarked, but it is
    // not the tree's root pane.
    assert.equal(
      classifyWindow(window("@1", 200, 50, [unmarked("user"), pane("%2")]), ROOT),
      "foreign",
    );
  });

  it("does not treat a window with another tree's pane as home", () => {
    assert.equal(
      classifyWindow(
        window("@1", 200, 50, [unmarked(ROOT), pane("%2"), pane("%3", "OTHER")]),
        ROOT,
      ),
      "foreign",
    );
  });
});

describe("choosePlacement", () => {
  const empty = [unmarked(ROOT)];
  const fullColumn = [
    unmarked(ROOT),
    pane("%2"),
    pane("%3"),
    pane("%4"),
    pane("%5"),
  ];

  it("splits the parent rightward once, when the column is empty", () => {
    assert.deepEqual(
      choosePlacement({
        home: window("@1", 238, 58, empty),
        anchor: ROOT,
        tree: ROOT,
        windows: [window("@1", 238, 58, empty)],
      }),
      { kind: "column", window: "@1", target: ROOT, direction: "h" },
    );
  });

  it("extends the column downward, never splitting the parent again", () => {
    const home = window("@1", 238, 58, [...empty, pane("%2")]);
    assert.deepEqual(
      choosePlacement({ home, anchor: ROOT, tree: ROOT, windows: [home] }),
      { kind: "column", window: "@1", target: "%2", direction: "v" },
    );
  });

  it("opens an overflow window once the column is full", () => {
    const home = window("@1", 238, 58, fullColumn);
    assert.deepEqual(
      choosePlacement({ home, anchor: ROOT, tree: ROOT, windows: [home] }),
      { kind: "overflow-new" },
    );
  });

  it("fills an overflow window that still has room", () => {
    const home = window("@1", 238, 58, fullColumn);
    const overflow = window("@2", 238, 58, [pane("%6")]);
    assert.deepEqual(
      choosePlacement({ home, anchor: ROOT, tree: ROOT, windows: [home, overflow] }),
      { kind: "overflow-add", window: "@2", target: "%6" },
    );
  });

  it("adds to the same overflow window a subagent is already living in", () => {
    // An overflow window has no unmarked pane, so a naive "no parent here"
    // reading would send this spawn to a redundant second window.
    const overflow = window("@2", 238, 58, [pane("%6"), pane("%7")]);
    assert.deepEqual(
      choosePlacement({ home: overflow, anchor: "%7", tree: ROOT, windows: [overflow] }),
      { kind: "overflow-add", window: "@2", target: "%7" },
    );
  });

  it("opens another window when the first overflow window is full", () => {
    const home = window("@1", 238, 58, fullColumn);
    const full = window("@2", 238, 58, Array.from({ length: 9 }, (_, i) => pane(`%${i + 6}`)));
    assert.deepEqual(
      choosePlacement({ home, anchor: ROOT, tree: ROOT, windows: [home, full] }),
      { kind: "overflow-new" },
    );
  });

  it("never shares another tree's overflow window", () => {
    const home = window("@1", 238, 58, fullColumn);
    const other = window("@2", 238, 58, [pane("%6", "OTHER")]);
    assert.deepEqual(
      choosePlacement({ home, anchor: ROOT, tree: ROOT, windows: [home, other] }),
      { kind: "overflow-new" },
    );
  });

  it("sends everything to overflow when the parent's window is the user's", () => {
    const home = window("@1", 238, 58, [unmarked("shell"), unmarked(ROOT)]);
    assert.deepEqual(
      choosePlacement({ home, anchor: ROOT, tree: ROOT, windows: [home] }),
      { kind: "overflow-new" },
    );
  });

  it("sends everything to overflow when the window is too narrow to split", () => {
    const home = window("@1", 100, 58, empty);
    assert.deepEqual(
      choosePlacement({ home, anchor: ROOT, tree: ROOT, windows: [home] }),
      { kind: "overflow-new" },
    );
  });
});
