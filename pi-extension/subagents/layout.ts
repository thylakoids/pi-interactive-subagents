/**
 * Where a subagent's pane goes.
 *
 * The parent pi pane keeps half its window and subagents stack in a column
 * beside it; once that column is full they move to extra windows in the same
 * tmux session, tiled. The policy is here, as pure functions over a snapshot of
 * tmux state, so the arithmetic and the decision table can be tested without a
 * multiplexer running. `tmux.ts` reads the snapshot and executes the result.
 *
 * Every decision is made from what tmux currently reports, never from this
 * process's memory: a subagent is itself a pi process running this same
 * extension, so two processes can be placing panes into one window and they
 * must agree. The agreement comes from `@pi_subagent`, a per-pane tmux user
 * option holding the tree's root pane id — the root itself is the one pane
 * without it.
 */

/** One pane, reduced to what placement cares about. */
export interface PaneInfo {
  id: string;
  /** `@pi_subagent` mark: the root pane id of the tree, or "" for an unmanaged pane. */
  tree: string;
}

export interface WindowInfo {
  id: string;
  width: number;
  height: number;
  /** In tmux's own order, which is the order `main-vertical` fills. */
  panes: PaneInfo[];
}

/**
 * What a window is to us.
 *
 * - `home` — the tree's own window: the parent pane plus its subagent column.
 * - `overflow` — an extra window holding only this tree's subagents.
 * - `foreign` — anything else, i.e. the user split their own window. Never
 *   laid out: rearranging panes we did not create would be a surprise, and if
 *   the parent is not the window's first pane `main-vertical` would promote the
 *   wrong one anyway.
 */
export type WindowKind = "home" | "overflow" | "foreign";

/** Main pane width. A percentage so it tracks window resizes on its own. */
export const MAIN_PANE_WIDTH = "50%";

/** Below this a pi pane cannot show its input box and a few lines of output. */
const MIN_PANE_ROWS = 12;

/** Both halves of the home window must stay at least this wide. */
const MIN_COLUMN_COLS = 60;

/** Stacking more than this many panes in one column stops being readable. */
const MAX_COLUMN_PANES = 6;

/** Smallest tile worth giving a subagent in an overflow window. */
const OVERFLOW_CELL_COLS = 64;
const OVERFLOW_CELL_ROWS = 16;

/** Past this, another overflow window is clearer than a bigger grid. */
const MAX_OVERFLOW_PANES = 12;

/**
 * How many subagent panes fit in the home window's column.
 *
 * Each pane costs a row for its border, so K panes need `H - (K - 1)` rows to
 * share between them, and the closed form is `(H + 1) / (MIN_PANE_ROWS + 1)`.
 * On a 58-row window that is 4 — the column heights tmux actually produces are
 * 13/13/13/16, and a fifth pane drops to 10 rows. Zero when the window is too
 * narrow to split at all, which sends every subagent to an overflow window
 * instead of squeezing the parent.
 */
export function columnCapacity(width: number, height: number): number {
  if (width < MIN_COLUMN_COLS * 2 + 1) return 0;
  const byHeight = Math.floor((height + 1) / (MIN_PANE_ROWS + 1));
  return Math.max(0, Math.min(MAX_COLUMN_PANES, byHeight));
}

/**
 * The grid tmux's `tiled` layout chooses for `panes` panes.
 *
 * `layout_set_tiled` grows a near-square grid from 1x1, incrementing rows first
 * and columns second until the grid holds every pane. The window's width and
 * height are only divided into that grid afterwards, so the grid shape is a
 * function of the pane count alone.
 */
function tiledGrid(panes: number): { columns: number; rows: number } {
  let columns = 1;
  let rows = 1;
  while (rows * columns < panes) {
    rows++;
    if (rows * columns < panes) columns++;
  }
  return { columns, rows };
}

/**
 * How many subagents fit in one overflow window.
 *
 * Both cell dimensions shrink monotonically as the grid grows, so the largest
 * pane count whose cells stay above the readability floor is the capacity.
 * Measured against tmux's own grid: 9 panes on a 200x50 gives each 66x16; the
 * 12-pane grid a looser cap would allow drops to 66x11, which is too short.
 */
export function overflowCapacity(width: number, height: number): number {
  let capacity = 1;
  for (let panes = 1; panes <= MAX_OVERFLOW_PANES; panes++) {
    const { columns, rows } = tiledGrid(panes);
    // One cell of slack covers the border tmux draws between cells.
    const cellWidth = Math.floor((width - (columns - 1)) / columns);
    const cellHeight = Math.floor((height - (rows - 1)) / rows);
    if (cellWidth < OVERFLOW_CELL_COLS - 1 || cellHeight < OVERFLOW_CELL_ROWS - 1) break;
    capacity = panes;
  }
  return capacity;
}

export function classifyWindow(window: WindowInfo, tree: string): WindowKind {
  const unmarked = window.panes.filter((pane) => !pane.tree);
  // The root is the one unmarked pane. It has to be the window's first for
  // `main-vertical` to make it the main pane, it has to be *this tree's* root
  // (not a user pane tmux promoted after the root died), and every other pane
  // has to belong to this tree.
  if (
    unmarked.length === 1 &&
    unmarked[0].id === window.panes[0]?.id &&
    unmarked[0].id === tree &&
    window.panes.slice(1).every((pane) => pane.tree === tree)
  ) {
    return "home";
  }
  if (window.panes.length > 0 && window.panes.every((pane) => pane.tree === tree)) {
    return "overflow";
  }
  return "foreign";
}

export type Placement =
  /** Extend the home window's column. */
  | { kind: "column"; window: string; target: string; direction: "h" | "v" }
  /** Add a pane to an existing overflow window and re-tile it. */
  | { kind: "overflow-add"; window: string; target: string }
  /** Open a new overflow window; its first pane becomes the subagent's. */
  | { kind: "overflow-new" };

export interface PlacementInput {
  /** The window holding the anchor pane. */
  home: WindowInfo;
  /** `$TMUX_PANE`: the pi process that is spawning. */
  anchor: string;
  /** Root pane id of this tree. */
  tree: string;
  /** Every window in the anchor's tmux session. */
  windows: WindowInfo[];
}

export function choosePlacement(input: PlacementInput): Placement {
  const { home, anchor, tree, windows } = input;
  const kind = classifyWindow(home, tree);

  if (kind === "home") {
    const column = home.panes.slice(1);
    if (column.length < columnCapacity(home.width, home.height)) {
      // The parent is split rightward exactly once, when the column is empty;
      // every later pane extends the column downward so the parent keeps its
      // half. Splitting the parent again would halve it again.
      return column.length === 0
        ? { kind: "column", window: home.id, target: anchor, direction: "h" }
        : {
            kind: "column",
            window: home.id,
            target: column[column.length - 1].id,
            direction: "v",
          };
    }
  }

  if (kind === "overflow" && home.panes.length < overflowCapacity(home.width, home.height)) {
    // A subagent living in an overflow window spawns its children into that
    // same window rather than opening a redundant second one.
    return {
      kind: "overflow-add",
      window: home.id,
      target: home.panes[home.panes.length - 1].id,
    };
  }

  const roomy = windows.find(
    (window) =>
      window.id !== home.id &&
      window.panes.length > 0 &&
      window.panes.every((pane) => pane.tree === tree) &&
      window.panes.length < overflowCapacity(window.width, window.height),
  );
  if (roomy) {
    return {
      kind: "overflow-add",
      window: roomy.id,
      target: roomy.panes[roomy.panes.length - 1].id,
    };
  }

  return { kind: "overflow-new" };
}
