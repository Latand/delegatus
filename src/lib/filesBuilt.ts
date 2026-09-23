/**
 * What one `/api/files` representation was built from (#2072): the epoch of
 * the server's scan-generation counter, the scan generation, and the order in
 * which its projection read the stores. A stale answer carries its own stamp,
 * so the client can refuse to paint anything older than what is on screen.
 *
 * Sent as `x-llv-files-built: <epoch>.<generation>.<sequence>`.
 */
export const FILES_BUILT_HEADER = "x-llv-files-built";

export interface FilesBuilt {
  /** Generations restart at zero with a new counter (a new process). */
  epoch: string;
  /** The scan generation the rows were projected from. */
  generation: number;
  /** Build order across every scope of one process: two projections of the
      same scan differ in the stores they read (a pipeline closed, a task
      moved), and the later build read the later stores. */
  sequence: number;
}

export function formatFilesBuilt(built: FilesBuilt): string {
  return `${built.epoch}.${built.generation}.${built.sequence}`;
}

export function parseFilesBuilt(value: string | null | undefined): FilesBuilt | undefined {
  const match = /^([0-9a-z]+)\.(\d+)\.(\d+)$/.exec(value ?? "");
  if (!match) return undefined;
  const generation = Number(match[2]);
  const sequence = Number(match[3]);
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(sequence)) return undefined;
  return { epoch: match[1], generation, sequence };
}

/** Whether `built` is older than `than`. Unknown on either side, or two
    epochs, is not older: nothing orders them, and refusing would freeze the
    board after a restart. */
export function filesBuiltBefore(built: FilesBuilt | undefined, than: FilesBuilt | undefined): boolean {
  if (!built || !than || built.epoch !== than.epoch) return false;
  return built.generation < than.generation
    || (built.generation === than.generation && built.sequence < than.sequence);
}

/** Whether a representation the client already holds is behind what is on
    screen. It arrived before the screen's answer did, so one from another
    epoch, or with no stamp while the screen has one, belongs to a timeline the
    screen has since left. Nothing on screen to compare with: not behind. */
export function filesBuiltSuperseded(stored: FilesBuilt | undefined, shown: FilesBuilt | undefined): boolean {
  if (!shown) return false;
  return !stored || stored.epoch !== shown.epoch || filesBuiltBefore(stored, shown);
}
