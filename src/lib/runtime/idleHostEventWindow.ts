import { stat } from "node:fs/promises";
import { releaseHostEventWindow } from "./hostEventWindow";
import type { RuntimeEvent } from "./engineHost";

export const HOST_EVENT_WINDOW_IDLE_MS = 10 * 60_000;

/** Release only an unchanged, settled owner's payloads. Transcript I/O stays
 * off the event loop; every live guard is read again after that await. */
export async function releaseIdleHostEventWindow(options: {
  events: RuntimeEvent[];
  revision: () => number;
  transcriptPath: string;
  eligible: () => boolean;
  onRelease?: () => void;
  now?: () => number;
  transcriptMtime?: (path: string) => Promise<number>;
}): Promise<boolean> {
  const now = options.now ?? Date.now;
  const activity = options.revision();
  const tail = options.events.at(-1);
  if (!tail || !options.eligible()) return false;
  let modified: number;
  try {
    modified = await (options.transcriptMtime ?? (async path => {
      const file = await stat(path);
      return file.isFile() ? file.mtimeMs : Number.NaN;
    }))(options.transcriptPath);
  } catch { return false; }
  if (!Number.isFinite(modified) || now() - modified <= HOST_EVENT_WINDOW_IDLE_MS
    || options.revision() !== activity || options.events.at(-1) !== tail || !options.eligible()) return false;
  releaseHostEventWindow(options.events);
  options.onRelease?.();
  return true;
}
