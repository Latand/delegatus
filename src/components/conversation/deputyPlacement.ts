/**
 * Where a drawn block sits in the conversation window
 * (docs/design/ghost-seat.md §6.1 "Ordering"), as a pure helper beside
 * `tailOrder.ts` so the rule is provable without a mounted feed.
 *
 * A block is placed ONCE, at the position of its head, and never moves: after
 * the last seat row whose instant is at or before the block's `startedAt`, and
 * after the undated rows that immediately follow that row. Everything the seat
 * writes later is dated later and lands below it. Rows inside a block keep
 * their own transcript's order and are never re-sorted against the seat's.
 * Blocks started at different instants sit in start order.
 */

export interface PlacedBlock {
  id: string;
  /** Epoch milliseconds the block's head was sent at. */
  startedAt: number;
}

export interface BlockPlacement {
  id: string;
  /** How many of the window's rows come before the block: 0 puts it first,
      `rows.length` puts it after every row. */
  after: number;
}

/**
 * The placement of every block against the window's rows, in list order.
 *
 * `instants` is one entry per row in window order: the row's instant in epoch
 * milliseconds, or null for an undated row. The answer depends only on rows
 * dated at or before each block, so rows arriving later never move a block.
 */
export function placeDeputyBlocks(
  instants: readonly (number | null)[],
  blocks: readonly PlacedBlock[],
): BlockPlacement[] {
  const ordered = [...blocks].sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  return ordered.map((block) => {
    let lastDated = -1;
    for (let index = 0; index < instants.length; index += 1) {
      const at = instants[index];
      if (at !== null && at !== undefined && at <= block.startedAt) lastDated = index;
    }
    if (lastDated < 0) return { id: block.id, after: 0 };
    let after = lastDated + 1;
    while (after < instants.length && (instants[after] === null || instants[after] === undefined)) after += 1;
    return { id: block.id, after };
  });
}

/**
 * Merge rows and blocks into one list: each block right after the row count
 * its placement names, blocks sharing a slot in start order.
 */
export function interleaveDeputyBlocks<Row, Block>(
  rows: readonly Row[],
  placements: readonly BlockPlacement[],
  block: (id: string) => Block,
): (Row | Block)[] {
  const bySlot = new Map<number, string[]>();
  for (const placement of placements) {
    const slot = Math.min(Math.max(0, placement.after), rows.length);
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), placement.id]);
  }
  const out: (Row | Block)[] = [];
  for (let index = 0; index <= rows.length; index += 1) {
    for (const id of bySlot.get(index) ?? []) out.push(block(id));
    if (index < rows.length) out.push(rows[index]!);
  }
  return out;
}
