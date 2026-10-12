/*
 * The merge batch's own pull request (`scripts/merge-batch.ts`): its head
 * branch and its title are a contract. The batch merges one PR and closes the
 * originals it carried, so a closed PR counts as landed only through the
 * merged batch whose title names its number (docs/design/done-section.md
 * §2.1). Both sides read this module, so the format cannot drift apart.
 */

export const MERGE_BATCH_BRANCH_PREFIX = "merge-batch/";

const TITLE_PREFIX = "Merge batch: ";

export function isMergeBatchHead(headRefName: string): boolean {
  return headRefName.startsWith(MERGE_BATCH_BRANCH_PREFIX);
}

/** `Merge batch: #2699, #2708`. */
export function mergeBatchTitle(numbers: readonly number[]): string {
  return `${TITLE_PREFIX}${numbers.map((number) => `#${number}`).join(", ")}`;
}

/** The numbers a batch title names, in its order; empty for any other title. */
export function parseMergeBatchTitle(title: string | null | undefined): number[] {
  if (typeof title !== "string" || !title.startsWith(TITLE_PREFIX)) return [];
  const numbers: number[] = [];
  for (const part of title.slice(TITLE_PREFIX.length).split(",")) {
    const match = /^\s*#(\d{1,9})\s*$/.exec(part);
    if (!match) return [];
    numbers.push(Number(match[1]));
  }
  return numbers;
}
